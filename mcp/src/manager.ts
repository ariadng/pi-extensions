import { setTimeout as delay } from "node:timers/promises";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import {
	createMcpOAuthProvider,
	McpAuthStore,
	type McpAuthStartResult,
	startMcpOAuthFlow,
} from "./auth.js";
import { loadMcpConfig } from "./config.js";
import { discoverManifest, summarizeManifest } from "./manifest.js";
import { createMcpTransport } from "./transports.js";
import { getCachedManifest, isServerDisabled, loadMcpState, saveMcpState, setAllServersDisabled, setCachedManifest, setServerDisabled } from "./state.js";
import { getTransportType } from "./config.js";
import type {
	LoadedMcpConfig,
	McpManifest,
	McpPromptMapping,
	McpServerState,
	McpStateFile,
	McpToolMapping,
	ScopedMcpServerConfig,
	ServerSummary,
} from "./types.js";

const PI_MCP_VERSION = "0.1.0";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const LIST_CHANGED_DEBOUNCE_MS = 250;

function readTimeoutEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const record = error as Record<string, unknown>;
	for (const key of ["code", "status", "statusCode"]) {
		const value = record[key];
		if (typeof value === "number") return value;
		if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	}
	return undefined;
}

function isAuthRequiredError(error: unknown): boolean {
	if (error instanceof UnauthorizedError) return true;
	const code = errorCode(error);
	if (code === 401 || code === 403) return true;
	const message = errorMessage(error);
	return /\b(unauthorized|forbidden|www-authenticate|authentication required|authorization required|invalid_token)\b/i.test(message);
}

function isProtocolDiagnostic(error: unknown): boolean {
	const message = errorMessage(error);
	return /\b(protocol|initialize|initialization|json-rpc|jsonrpc|unsupported|negotiat|capabilit)/i.test(message);
}

function activationErrorMessage(serverName: string, error: unknown): string {
	const message = errorMessage(error);
	if (isAuthRequiredError(error)) {
		return `MCP server ${serverName} requires authentication. Run /mcp auth ${serverName}, call mcp__${serverName}__authenticate, or configure static headers/headersHelper for this server. Original error: ${message}`;
	}
	if (isProtocolDiagnostic(error)) {
		return `MCP server ${serverName} protocol or transport negotiation failed. Check that the configured transport type and URL match the server. Original error: ${message}`;
	}
	return message;
}

export interface McpConnectionManagerOptions {
	cwd: string;
	loadedConfig: LoadedMcpConfig;
	stateFile: McpStateFile;
	authStore: McpAuthStore;
	onManifest?: (serverName: string, manifest: McpManifest) => void;
	onStatus?: () => void;
	onWarning?: (message: string) => void;
	onServerDisabled?: (serverName: string) => void;
	onAuthRequired?: (serverName: string) => void;
	onAuthComplete?: (serverName: string) => void;
	onAuthFailed?: (serverName: string, error: string) => void;
}

export class McpConnectionManager {
	private cwd: string;
	private loadedConfig: LoadedMcpConfig;
	private stateFile: McpStateFile;
	private authStore: McpAuthStore;
	private states = new Map<string, McpServerState>();
	private activationPromises = new Map<string, Promise<Extract<McpServerState, { type: "connected" }>>>();
	private authFlowPromises = new Map<string, Promise<McpAuthStartResult>>();
	private manifestRefreshPromises = new Map<string, Promise<void>>();
	private pendingManifestRefreshes = new Set<string>();
	private activatedNetworkServers = new Set<string>();
	private readonly onManifest?: (serverName: string, manifest: McpManifest) => void;
	private readonly onStatus?: () => void;
	private readonly onWarning?: (message: string) => void;
	private readonly onServerDisabled?: (serverName: string) => void;
	private readonly onAuthRequired?: (serverName: string) => void;
	private readonly onAuthComplete?: (serverName: string) => void;
	private readonly onAuthFailed?: (serverName: string, error: string) => void;

	constructor(options: McpConnectionManagerOptions) {
		this.cwd = options.cwd;
		this.loadedConfig = options.loadedConfig;
		this.stateFile = options.stateFile;
		this.authStore = options.authStore;
		this.onManifest = options.onManifest;
		this.onStatus = options.onStatus;
		this.onWarning = options.onWarning;
		this.onServerDisabled = options.onServerDisabled;
		this.onAuthRequired = options.onAuthRequired;
		this.onAuthComplete = options.onAuthComplete;
		this.onAuthFailed = options.onAuthFailed;
		this.rebuildDormantStates();
	}

	get config(): LoadedMcpConfig {
		return this.loadedConfig;
	}

	get state(): McpStateFile {
		return this.stateFile;
	}

	get connectTimeoutMs(): number {
		return readTimeoutEnv("PI_MCP_TIMEOUT", DEFAULT_CONNECT_TIMEOUT_MS);
	}

	get toolTimeoutMs(): number {
		return readTimeoutEnv("PI_MCP_TOOL_TIMEOUT", DEFAULT_TOOL_TIMEOUT_MS);
	}

	private rebuildDormantStates(): void {
		const next = new Map<string, McpServerState>();
		for (const [name, config] of this.loadedConfig.servers) {
			const existing = this.states.get(name);
			if (existing?.type === "connected" && existing.config.configHash === config.configHash) {
				next.set(name, existing);
				continue;
			}
			const manifest = getCachedManifest(this.stateFile, this.cwd, name, config);
			if (isServerDisabled(this.stateFile, this.cwd, name, config)) next.set(name, { type: "disabled", name, config, manifest });
			else next.set(name, { type: "dormant", name, config, manifest });
		}
		for (const [name, state] of this.states) {
			if (!next.has(name) && state.type === "connected") void state.cleanup().catch(() => undefined);
			if (!next.has(name)) this.onServerDisabled?.(name);
		}
		this.states = next;
		this.onStatus?.();
	}

	async reload(): Promise<{ warnings: string[]; errors: string[] }> {
		const [loadedConfig, loadedState, loadedAuth] = await Promise.all([loadMcpConfig(this.cwd), loadMcpState(), McpAuthStore.load()]);
		this.loadedConfig = loadedConfig;
		this.stateFile = loadedState.state;
		this.authStore = loadedAuth.store;
		for (const warning of [...loadedState.warnings, ...loadedAuth.warnings]) this.onWarning?.(warning);
		this.rebuildDormantStates();
		return { warnings: [...loadedConfig.warnings, ...loadedState.warnings, ...loadedAuth.warnings], errors: loadedConfig.errors };
	}

	getServerNames(): string[] {
		return [...this.loadedConfig.servers.keys()].sort((a, b) => a.localeCompare(b));
	}

	getServerConfig(name: string): ScopedMcpServerConfig | undefined {
		return this.loadedConfig.servers.get(name);
	}

	getServerState(name: string): McpServerState | undefined {
		return this.states.get(name);
	}

	getManifest(name: string): McpManifest | undefined {
		return this.states.get(name)?.manifest;
	}

	getSummaries(): ServerSummary[] {
		return this.getServerNames().map((name) => {
			const config = this.loadedConfig.servers.get(name)!;
			const state = this.states.get(name);
			const manifest = state?.manifest;
			return {
				name,
				scope: config.scope,
				transport: getTransportType(config),
				status: state?.type ?? "dormant",
				configPath: config.configPath,
				toolCount: manifest?.tools.length ?? 0,
				resourceCount: manifest?.resources.length ?? 0,
				promptCount: manifest?.prompts.length ?? 0,
				error: state?.type === "failed" || state?.type === "needs-auth" ? state.error : undefined,
			};
		});
	}

	private createListChangedHandlers(name: string) {
		const onChanged = (kind: "tools" | "resources" | "prompts") => (error: Error | null) => {
			if (error) {
				this.onWarning?.(`MCP ${name}: failed to process ${kind}/list_changed notification: ${error.message}`);
				return;
			}
			this.refreshManifestAfterListChanged(name, kind);
		};
		return {
			tools: { autoRefresh: false, debounceMs: LIST_CHANGED_DEBOUNCE_MS, onChanged: onChanged("tools") },
			resources: { autoRefresh: false, debounceMs: LIST_CHANGED_DEBOUNCE_MS, onChanged: onChanged("resources") },
			prompts: { autoRefresh: false, debounceMs: LIST_CHANGED_DEBOUNCE_MS, onChanged: onChanged("prompts") },
		};
	}

	private async applyManifestToConnectedState(connected: Extract<McpServerState, { type: "connected" }>, manifest: McpManifest): Promise<boolean> {
		const current = this.states.get(connected.name);
		if (current?.type !== "connected" || current.client !== connected.client) return false;
		current.capabilities = current.client.getServerCapabilities() ?? current.capabilities;
		current.manifest = manifest;
		this.states.set(connected.name, current);
		setCachedManifest(this.stateFile, this.cwd, connected.name, connected.config, manifest);
		this.onManifest?.(connected.name, manifest);
		this.onStatus?.();
		await saveMcpState(this.stateFile);
		return true;
	}

	private async refreshConnectedManifest(name: string): Promise<McpManifest | undefined> {
		const connected = this.states.get(name);
		if (connected?.type !== "connected") return undefined;
		const manifest = await discoverManifest(connected.client, name, connected.config, this.toolTimeoutMs);
		await this.applyManifestToConnectedState(connected, manifest);
		return manifest;
	}

	private refreshManifestAfterListChanged(name: string, kind: "tools" | "resources" | "prompts"): void {
		this.pendingManifestRefreshes.add(name);
		if (this.manifestRefreshPromises.has(name)) return;
		const promise = (async () => {
			while (this.pendingManifestRefreshes.has(name)) {
				this.pendingManifestRefreshes.delete(name);
				try {
					await this.refreshConnectedManifest(name);
				} catch (error) {
					this.onWarning?.(`MCP ${name}: failed to refresh manifest after ${kind}/list_changed: ${errorMessage(error)}`);
				}
			}
		})().finally(() => {
			this.manifestRefreshPromises.delete(name);
			if (this.pendingManifestRefreshes.has(name)) this.refreshManifestAfterListChanged(name, kind);
		});
		this.manifestRefreshPromises.set(name, promise);
	}

	private async performActivation(name: string, refresh: boolean, signal?: AbortSignal): Promise<Extract<McpServerState, { type: "connected" }>> {
		const config = this.loadedConfig.servers.get(name);
		if (!config) throw new Error(`Unknown MCP server: ${name}`);
		if (isServerDisabled(this.stateFile, this.cwd, name, config)) {
			const manifest = getCachedManifest(this.stateFile, this.cwd, name, config);
			this.states.set(name, { type: "disabled", name, config, manifest });
			this.onStatus?.();
			throw new Error(`MCP server ${name} is disabled. Run /mcp enable ${name} before activating it.`);
		}

		const current = this.states.get(name);
		if (current?.type === "connected") {
			if (!refresh) return current;
			await current.cleanup();
		}

		const previousManifest = current?.manifest ?? getCachedManifest(this.stateFile, this.cwd, name, config);
		this.states.set(name, { type: "activating", name, config, manifest: previousManifest });
		this.onStatus?.();

		let client: Client | undefined;
		try {
			const transportType = getTransportType(config);
			const hasAuthTokens = this.authStore.hasTokens(name, config);
			const authProvider = hasAuthTokens && (transportType === "http" || transportType === "sse")
				? createMcpOAuthProvider({ store: this.authStore, serverName: name, config })
				: undefined;
			const oauthAccessToken = hasAuthTokens && transportType === "ws" ? this.authStore.getAccessToken(name, config) : undefined;
			const transportResult = await createMcpTransport(config, { serverName: name, cwd: this.cwd, authProvider, oauthAccessToken });
			for (const warning of transportResult.warnings) this.onWarning?.(warning);

			client = new Client(
				{ name: "pi-mcp", title: "Pi MCP", version: PI_MCP_VERSION },
				{ capabilities: {}, enforceStrictCapabilities: false, listChanged: this.createListChangedHandlers(name) },
			);
			client.onerror = (error) => this.onWarning?.(`MCP ${name}: ${error.message}`);

			await client.connect(transportResult.transport, { timeout: this.connectTimeoutMs, signal });
			const capabilities = client.getServerCapabilities() ?? ({} as ServerCapabilities);
			const manifest = await discoverManifest(client, name, config, this.toolTimeoutMs);
			const connected: Extract<McpServerState, { type: "connected" }> = {
				type: "connected",
				name,
				config,
				client,
				capabilities,
				manifest,
				activatedAt: new Date().toISOString(),
				cleanup: async () => {
					try {
						await client?.close();
					} catch {
						// Best-effort cleanup.
					}
				},
			};
			this.states.set(name, connected);
			if (getTransportType(config) !== "stdio") this.activatedNetworkServers.add(name);
			setCachedManifest(this.stateFile, this.cwd, name, config, manifest);
			await saveMcpState(this.stateFile);
			this.onManifest?.(name, manifest);
			this.onStatus?.();
			return connected;
		} catch (error) {
			await client?.close().catch(() => undefined);
			const message = activationErrorMessage(name, error);
			if (isAuthRequiredError(error)) {
				this.states.set(name, { type: "needs-auth", name, config, error: message, manifest: previousManifest });
				this.onAuthRequired?.(name);
			} else {
				this.states.set(name, { type: "failed", name, config, error: message, manifest: previousManifest });
			}
			this.onStatus?.();
			throw new Error(`Failed to activate MCP server ${name}: ${message}`);
		}
	}

	async activateServer(name: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Extract<McpServerState, { type: "connected" }>> {
		const existing = this.activationPromises.get(name);
		if (existing && !options.refresh) return existing;
		const promise = this.performActivation(name, options.refresh === true, options.signal).finally(() => this.activationPromises.delete(name));
		this.activationPromises.set(name, promise);
		return promise;
	}

	async reconnectServer(name: string, signal?: AbortSignal): Promise<Extract<McpServerState, { type: "connected" }>> {
		const config = this.loadedConfig.servers.get(name);
		if (!config) throw new Error(`Unknown MCP server: ${name}`);
		const attempts = getTransportType(config) === "stdio" || this.activatedNetworkServers.has(name) ? 3 : 1;
		let lastError: unknown;
		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				return await this.activateServer(name, { refresh: true, signal });
			} catch (error) {
				lastError = error;
				if (attempt < attempts - 1) await delay(Math.min(1000 * 2 ** attempt, 8000), undefined, { signal }).catch(() => undefined);
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	async startAuthFlow(name: string): Promise<McpAuthStartResult> {
		const existing = this.authFlowPromises.get(name);
		if (existing) return existing;
		const config = this.loadedConfig.servers.get(name);
		if (!config) throw new Error(`Unknown MCP server: ${name}`);
		if (getTransportType(config) === "stdio") throw new Error(`MCP server ${name} uses stdio and does not support OAuth`);
		const promise = startMcpOAuthFlow({
			store: this.authStore,
			serverName: name,
			config,
			onAuthenticated: async () => {
				this.states.set(name, { type: "dormant", name, config, manifest: getCachedManifest(this.stateFile, this.cwd, name, config) });
				await this.activateServer(name, { refresh: true });
			},
		})
			.then((result) => {
				if (result.status === "auth_url") {
					const current = this.states.get(name);
					const manifest = current?.manifest ?? getCachedManifest(this.stateFile, this.cwd, name, config);
					this.states.set(name, { type: "needs-auth", name, config, error: "Authentication in progress", authUrl: result.authUrl, manifest });
					this.onAuthRequired?.(name);
					this.onStatus?.();
				}
				void result.completion
					.then(() => {
						this.onAuthComplete?.(name);
						this.onStatus?.();
					})
					.catch((error) => {
						const current = this.states.get(name);
						const manifest = current?.manifest ?? getCachedManifest(this.stateFile, this.cwd, name, config);
						const message = errorMessage(error);
						this.states.set(name, { type: "needs-auth", name, config, error: `OAuth failed: ${message}`, manifest });
						this.onAuthRequired?.(name);
						this.onAuthFailed?.(name, message);
						this.onStatus?.();
					})
					.finally(() => this.authFlowPromises.delete(name));
				return result;
			})
			.catch((error) => {
				this.authFlowPromises.delete(name);
				throw error;
			});
		this.authFlowPromises.set(name, promise);
		return promise;
	}

	async callTool(mapping: McpToolMapping, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const connected = await this.activateServer(mapping.serverName, { signal });
		return connected.client.callTool({ name: mapping.originalToolName, arguments: args }, undefined, {
			timeout: this.toolTimeoutMs,
			signal,
		});
	}

	async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<unknown> {
		const connected = await this.activateServer(serverName, { signal });
		return connected.client.readResource({ uri }, { timeout: this.toolTimeoutMs, signal });
	}

	async getPrompt(mapping: McpPromptMapping, args: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
		const connected = await this.activateServer(mapping.serverName, { signal });
		return connected.client.getPrompt({ name: mapping.originalPromptName, arguments: args }, { timeout: this.toolTimeoutMs, signal });
	}

	async refreshManifest(serverName: string, signal?: AbortSignal): Promise<McpManifest> {
		const connected = await this.activateServer(serverName, { signal });
		const manifest = await discoverManifest(connected.client, serverName, connected.config, this.toolTimeoutMs);
		await this.applyManifestToConnectedState(connected, manifest);
		return manifest;
	}

	async refreshResources(serverName: string, signal?: AbortSignal): Promise<McpManifest> {
		return this.refreshManifest(serverName, signal);
	}

	async disableServer(name: string): Promise<void> {
		const config = this.loadedConfig.servers.get(name);
		if (!config) throw new Error(`Unknown MCP server: ${name}`);
		const current = this.states.get(name);
		if (current?.type === "connected") await current.cleanup();
		setServerDisabled(this.stateFile, this.cwd, name, config, true);
		await saveMcpState(this.stateFile);
		this.states.set(name, { type: "disabled", name, config, manifest: current?.manifest ?? getCachedManifest(this.stateFile, this.cwd, name, config) });
		this.onServerDisabled?.(name);
		this.onStatus?.();
	}

	async enableServer(name: string): Promise<void> {
		const config = this.loadedConfig.servers.get(name);
		if (!config) throw new Error(`Unknown MCP server: ${name}`);
		setServerDisabled(this.stateFile, this.cwd, name, config, false);
		await saveMcpState(this.stateFile);
		this.states.set(name, { type: "dormant", name, config, manifest: getCachedManifest(this.stateFile, this.cwd, name, config) });
		this.onStatus?.();
	}

	async clearAuth(name: string): Promise<void> {
		const config = this.loadedConfig.servers.get(name);
		if (!config) throw new Error(`Unknown MCP server: ${name}`);
		const current = this.states.get(name);
		if (current?.type === "connected") await current.cleanup();
		this.authStore.deleteRecord(name, config);
		await this.authStore.save();
		const manifest = current?.manifest ?? getCachedManifest(this.stateFile, this.cwd, name, config);
		this.states.set(name, { type: "dormant", name, config, manifest });
		this.onStatus?.();
	}

	async clearAllAuth(): Promise<void> {
		for (const name of this.getServerNames()) await this.clearAuth(name);
	}

	async setAllDisabled(disabled: boolean): Promise<void> {
		for (const [name, state] of this.states) {
			if (disabled && state.type === "connected") await state.cleanup();
			if (disabled) this.onServerDisabled?.(name);
		}
		setAllServersDisabled(this.stateFile, this.cwd, this.loadedConfig.servers, disabled);
		await saveMcpState(this.stateFile);
		this.rebuildDormantStates();
	}

	async closeAll(): Promise<void> {
		const closers = [...this.states.values()].map(async (state) => {
			if (state.type === "connected") await state.cleanup();
		});
		await Promise.allSettled(closers);
		for (const [name, state] of this.states) {
			if (state.type === "connected") this.states.set(name, { type: "dormant", name, config: state.config, manifest: state.manifest });
		}
		this.onStatus?.();
	}

	activationSummary(name: string): string {
		const state = this.states.get(name);
		if (!state) return `Unknown MCP server: ${name}`;
		if (state.type === "failed") return `${name}: failed · ${state.error}`;
		return `${name}: ${state.type} · ${summarizeManifest(state.manifest)}`;
	}
}

export async function createMcpManager(cwd: string, callbacks: Omit<McpConnectionManagerOptions, "cwd" | "loadedConfig" | "stateFile" | "authStore"> = {}): Promise<{
	manager: McpConnectionManager;
	warnings: string[];
	errors: string[];
}> {
	const [loadedConfig, loadedState, loadedAuth] = await Promise.all([loadMcpConfig(cwd), loadMcpState(), McpAuthStore.load()]);
	const manager = new McpConnectionManager({ cwd, loadedConfig, stateFile: loadedState.state, authStore: loadedAuth.store, ...callbacks });
	return { manager, warnings: [...loadedConfig.warnings, ...loadedState.warnings, ...loadedAuth.warnings], errors: loadedConfig.errors };
}
