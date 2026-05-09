import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import {
	auth as sdkAuth,
	type AuthResult,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getPiAgentDir } from "./config.js";
import type { McpOAuthConfig, ScopedMcpServerConfig } from "./types.js";

export interface McpAuthRecord {
	serverName: string;
	configHash: string;
	url: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
	state?: string;
}

export interface McpAuthFile {
	version: 1;
	servers: Record<string, McpAuthRecord>;
}

export interface McpAuthStartResult {
	status: "auth_url" | "authorized";
	message: string;
	authUrl?: string;
	completion: Promise<void>;
}

const AUTH_VERSION = 1 as const;
const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60_000;

export function getAuthFilePath(): string {
	return process.env.PI_MCP_AUTH_FILE ? process.env.PI_MCP_AUTH_FILE : path.join(getPiAgentDir(), "mcp-auth.json");
}

function browserCommand(url: string): { command: string; args: string[] } {
	if (process.env.PI_MCP_BROWSER_COMMAND) return { command: process.env.PI_MCP_BROWSER_COMMAND, args: [url] };
	if (process.platform === "darwin") return { command: "open", args: [url] };
	if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
	return { command: "xdg-open", args: [url] };
}

function openBrowser(url: string): Promise<void> {
	if (process.env.PI_MCP_OPEN_BROWSER === "0" || process.env.PI_MCP_OPEN_BROWSER === "false") return Promise.resolve();
	const { command, args } = browserCommand(url);
	return new Promise((resolve, reject) => {
		const child = execFile(command, args, { timeout: 10_000 }, (error) => {
			if (error) reject(error);
			else resolve();
		});
		child.unref?.();
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNetworkConfig(config: ScopedMcpServerConfig): config is ScopedMcpServerConfig & { url: string; oauth?: McpOAuthConfig } {
	return "url" in config && typeof config.url === "string";
}

function normalizeAuthFile(value: unknown): McpAuthFile {
	const output: McpAuthFile = { version: AUTH_VERSION, servers: {} };
	if (!isRecord(value) || !isRecord(value.servers)) return output;
	for (const [key, raw] of Object.entries(value.servers)) {
		if (!isRecord(raw) || typeof raw.serverName !== "string" || typeof raw.configHash !== "string" || typeof raw.url !== "string") continue;
		output.servers[key] = {
			serverName: raw.serverName,
			configHash: raw.configHash,
			url: raw.url,
			clientInformation: isRecord(raw.clientInformation) ? (raw.clientInformation as OAuthClientInformationMixed) : undefined,
			tokens: isRecord(raw.tokens) ? (raw.tokens as OAuthTokens) : undefined,
			codeVerifier: typeof raw.codeVerifier === "string" ? raw.codeVerifier : undefined,
			discoveryState: isRecord(raw.discoveryState) ? (raw.discoveryState as unknown as OAuthDiscoveryState) : undefined,
			state: typeof raw.state === "string" ? raw.state : undefined,
		};
	}
	return output;
}

export async function loadMcpAuthFile(): Promise<{ auth: McpAuthFile; warnings: string[] }> {
	const filePath = getAuthFilePath();
	if (!existsSync(filePath)) return { auth: { version: AUTH_VERSION, servers: {} }, warnings: [] };
	try {
		return { auth: normalizeAuthFile(JSON.parse(await readFile(filePath, "utf8"))), warnings: [] };
	} catch (error) {
		return {
			auth: { version: AUTH_VERSION, servers: {} },
			warnings: [`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}. Starting with empty MCP auth state.`],
		};
	}
}

export function getServerAuthKey(serverName: string, config: ScopedMcpServerConfig): string {
	return `${serverName}|${createHash("sha256").update(config.configHash).digest("hex").slice(0, 16)}`;
}

export class McpAuthStore {
	constructor(private readonly auth: McpAuthFile) {}

	static async load(): Promise<{ store: McpAuthStore; warnings: string[] }> {
		const result = await loadMcpAuthFile();
		return { store: new McpAuthStore(result.auth), warnings: result.warnings };
	}

	get file(): McpAuthFile {
		return this.auth;
	}

	getRecord(serverName: string, config: ScopedMcpServerConfig, create = false): McpAuthRecord | undefined {
		if (!isNetworkConfig(config)) return undefined;
		const key = getServerAuthKey(serverName, config);
		let record = this.auth.servers[key];
		if (!record && create) {
			record = { serverName, configHash: config.configHash, url: config.url };
			this.auth.servers[key] = record;
		}
		return record;
	}

	hasTokens(serverName: string, config: ScopedMcpServerConfig): boolean {
		return Boolean(this.getRecord(serverName, config)?.tokens?.access_token);
	}

	getAccessToken(serverName: string, config: ScopedMcpServerConfig): string | undefined {
		return this.getRecord(serverName, config)?.tokens?.access_token;
	}

	deleteRecord(serverName: string, config: ScopedMcpServerConfig): void {
		delete this.auth.servers[getServerAuthKey(serverName, config)];
	}

	async save(): Promise<void> {
		const filePath = getAuthFilePath();
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, `${JSON.stringify(this.auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	}
}

function oauthConfig(config: ScopedMcpServerConfig): McpOAuthConfig {
	return isNetworkConfig(config) && config.oauth ? config.oauth : {};
}

function buildClientMetadata(redirectUrl: string, config: ScopedMcpServerConfig): OAuthClientMetadata {
	const oauth = oauthConfig(config);
	const overrides = isRecord(oauth.clientMetadata) ? oauth.clientMetadata : {};
	return {
		redirect_uris: [redirectUrl],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		client_name: "Pi MCP",
		...(oauth.scope ? { scope: oauth.scope } : {}),
		...overrides,
	} as OAuthClientMetadata;
}

export function createMcpOAuthProvider(options: {
	store: McpAuthStore;
	serverName: string;
	config: ScopedMcpServerConfig;
	redirectUrl?: string;
	onAuthorizationUrl?: (url: string) => void;
}): OAuthClientProvider {
	const { store, serverName, config, redirectUrl, onAuthorizationUrl } = options;
	const oauth = oauthConfig(config);
	return {
		get redirectUrl() {
			return redirectUrl;
		},
		clientMetadataUrl: oauth.clientMetadataUrl,
		get clientMetadata() {
			return buildClientMetadata(redirectUrl ?? "http://127.0.0.1/callback", config);
		},
		async state() {
			const state = randomBytes(16).toString("hex");
			const record = store.getRecord(serverName, config, true);
			if (record) record.state = state;
			await store.save();
			return state;
		},
		async clientInformation() {
			if (oauth.clientId) return { client_id: oauth.clientId, client_secret: oauth.clientSecret };
			return store.getRecord(serverName, config)?.clientInformation;
		},
		async saveClientInformation(clientInformation) {
			if (oauth.clientId) return;
			const record = store.getRecord(serverName, config, true);
			if (record) record.clientInformation = clientInformation;
			await store.save();
		},
		async tokens() {
			return store.getRecord(serverName, config)?.tokens;
		},
		async saveTokens(tokens) {
			const record = store.getRecord(serverName, config, true);
			if (record) {
				record.tokens = tokens;
				delete record.state;
			}
			await store.save();
		},
		async redirectToAuthorization(authorizationUrl) {
			onAuthorizationUrl?.(authorizationUrl.toString());
		},
		async saveCodeVerifier(codeVerifier) {
			const record = store.getRecord(serverName, config, true);
			if (record) record.codeVerifier = codeVerifier;
			await store.save();
		},
		async codeVerifier() {
			const verifier = store.getRecord(serverName, config)?.codeVerifier;
			if (!verifier) throw new Error(`Missing OAuth code verifier for MCP server ${serverName}`);
			return verifier;
		},
		async saveDiscoveryState(discoveryState) {
			const record = store.getRecord(serverName, config, true);
			if (record) record.discoveryState = discoveryState;
			await store.save();
		},
		async discoveryState() {
			return store.getRecord(serverName, config)?.discoveryState;
		},
		async invalidateCredentials(scope) {
			const record = store.getRecord(serverName, config);
			if (!record) return;
			if (scope === "all") store.deleteRecord(serverName, config);
			else if (scope === "client") delete record.clientInformation;
			else if (scope === "tokens") delete record.tokens;
			else if (scope === "verifier") delete record.codeVerifier;
			else if (scope === "discovery") delete record.discoveryState;
			await store.save();
		},
	};
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to allocate OAuth callback port");
	return address.port;
}

async function createCallbackServer(expectedState: () => string | undefined): Promise<{
	redirectUrl: string;
	waitForCode: Promise<string>;
	close(): Promise<void>;
}> {
	let settled = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	const waitForCode = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});

	const settle = (error: Error | undefined, code?: string) => {
		if (settled) return;
		settled = true;
		if (timeout) clearTimeout(timeout);
		if (error) rejectCode(error);
		else resolveCode(code ?? "");
	};

	const server = createServer((req, res) => {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== "/callback") {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("Not found");
				return;
			}
			const oauthError = url.searchParams.get("error");
			if (oauthError) {
				const description = url.searchParams.get("error_description");
				res.writeHead(400, { "content-type": "text/html" });
				res.end(`<p>Pi MCP authentication failed: ${oauthError}</p>`);
				settle(new Error(description ? `${oauthError}: ${description}` : oauthError));
				return;
			}
			const state = url.searchParams.get("state");
			const expected = expectedState();
			if (expected && state !== expected) {
				res.writeHead(400, { "content-type": "text/html" });
				res.end("<p>Pi MCP authentication failed: state mismatch.</p>");
				settle(new Error("OAuth state mismatch"));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.writeHead(400, { "content-type": "text/html" });
				res.end("<p>Pi MCP authentication failed: missing code.</p>");
				settle(new Error("OAuth callback did not include a code"));
				return;
			}
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<p>Pi MCP authentication complete. You can close this tab and return to Pi.</p>");
			settle(undefined, code);
		} catch (error) {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end(error instanceof Error ? error.message : String(error));
			settle(error instanceof Error ? error : new Error(String(error)));
		}
	});
	const port = await listen(server);
	timeout = setTimeout(() => settle(new Error("OAuth callback timed out")), Number(process.env.PI_MCP_AUTH_TIMEOUT ?? DEFAULT_AUTH_TIMEOUT_MS));
	timeout.unref?.();

	return {
		redirectUrl: `http://127.0.0.1:${port}/callback`,
		waitForCode,
		async close() {
			if (timeout) clearTimeout(timeout);
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export async function startMcpOAuthFlow(options: {
	store: McpAuthStore;
	serverName: string;
	config: ScopedMcpServerConfig;
	onAuthenticated?: () => Promise<void>;
}): Promise<McpAuthStartResult> {
	const { store, serverName, config, onAuthenticated } = options;
	if (!isNetworkConfig(config)) throw new Error(`MCP server ${serverName} does not use a network transport and cannot use OAuth`);

	const callback = await createCallbackServer(() => store.getRecord(serverName, config)?.state);
	let authUrl: string | undefined;
	const provider = createMcpOAuthProvider({
		store,
		serverName,
		config,
		redirectUrl: callback.redirectUrl,
		onAuthorizationUrl: (url) => {
			authUrl = url;
		},
	});

	const scope = oauthConfig(config).scope;
	let startResult: AuthResult;
	try {
		startResult = await sdkAuth(provider, { serverUrl: config.url, scope });
	} catch (error) {
		await callback.close().catch(() => undefined);
		throw error;
	}

	if (startResult === "AUTHORIZED") {
		await callback.close().catch(() => undefined);
		const completion = onAuthenticated?.() ?? Promise.resolve();
		return { status: "authorized", message: `MCP server ${serverName} is already authorized.`, completion };
	}

	if (!authUrl) {
		await callback.close().catch(() => undefined);
		throw new Error(`OAuth flow for MCP server ${serverName} did not provide an authorization URL`);
	}

	let browserMessage = "";
	try {
		await openBrowser(authUrl);
		if (process.env.PI_MCP_OPEN_BROWSER !== "0" && process.env.PI_MCP_OPEN_BROWSER !== "false") browserMessage = "\n\nPi opened this URL in your default browser.";
	} catch (error) {
		browserMessage = `\n\nPi could not open your browser automatically: ${error instanceof Error ? error.message : String(error)}.`;
	}

	const completion = callback.waitForCode
		.then(async (code) => {
			await sdkAuth(provider, { serverUrl: config.url, authorizationCode: code, scope });
			await callback.close().catch(() => undefined);
			await onAuthenticated?.();
		})
		.catch(async (error) => {
			await callback.close().catch(() => undefined);
			throw error;
		});

	return {
		status: "auth_url",
		authUrl,
		message: `Open this URL in your browser to authorize the ${serverName} MCP server:\n\n${authUrl}${browserMessage}\n\nAfter the browser flow completes, Pi will reconnect the server automatically.`,
		completion,
	};
}
