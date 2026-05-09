import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import WebSocket from "ws";
import type { McpServerConfig, ScopedMcpServerConfig } from "./types.js";
import { getTransportType } from "./config.js";

const exec = promisify(execCallback);
const DEFAULT_HEADERS_HELPER_TIMEOUT_MS = 10_000;

export interface TransportContext {
	serverName: string;
	cwd: string;
	authProvider?: OAuthClientProvider;
	oauthAccessToken?: string;
}

export interface TransportFactoryResult {
	transport: Transport;
	warnings: string[];
}

function isNetworkConfig(config: McpServerConfig): config is Extract<McpServerConfig, { url: string }> {
	return getTransportType(config) === "http" || getTransportType(config) === "sse" || getTransportType(config) === "ws";
}

function validateHeaders(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("headersHelper must output a JSON object");
	const output: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value)) {
		if (typeof headerValue !== "string") throw new Error(`headersHelper output for ${key} must be a string`);
		output[key] = headerValue;
	}
	return output;
}

export async function resolveNetworkHeaders(config: ScopedMcpServerConfig, context: TransportContext): Promise<{ headers: Record<string, string>; warnings: string[] }> {
	if (!isNetworkConfig(config)) return { headers: {}, warnings: [] };
	const warnings: string[] = [];
	const headers: Record<string, string> = {
		...(context.oauthAccessToken ? { Authorization: `Bearer ${context.oauthAccessToken}` } : {}),
		...(config.headers ?? {}),
	};
	if (!config.headersHelper) return { headers, warnings };

	try {
		const result = await exec(config.headersHelper, {
			cwd: context.cwd,
			timeout: Number(process.env.PI_MCP_HEADERS_HELPER_TIMEOUT ?? DEFAULT_HEADERS_HELPER_TIMEOUT_MS),
			maxBuffer: 1024 * 1024,
			env: {
				...process.env,
				PI_MCP_SERVER_NAME: context.serverName,
				PI_MCP_SERVER_URL: config.url,
				PI_MCP_TRANSPORT: getTransportType(config),
			},
		});
		const stdout = result.stdout.trim();
		if (!stdout) throw new Error("helper wrote no JSON to stdout");
		Object.assign(headers, validateHeaders(JSON.parse(stdout)));
	} catch (error) {
		throw new Error(`headersHelper failed for ${context.serverName}: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { headers, warnings };
}

function mergeHeaders(base: HeadersInit | undefined, extra: Record<string, string>): HeadersInit {
	const output: Record<string, string> = {};
	if (base instanceof Headers) {
		base.forEach((value, key) => {
			output[key] = value;
		});
	} else if (Array.isArray(base)) {
		for (const [key, value] of base) output[key] = value;
	} else if (base && typeof base === "object") {
		Object.assign(output, base as Record<string, string>);
	}
	Object.assign(output, extra);
	return output;
}

class HeaderWebSocketClientTransport implements Transport {
	private socket?: WebSocket;
	private closedNotified = false;
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: <T extends JSONRPCMessage>(message: T) => void;

	constructor(
		private readonly url: URL,
		private readonly headers: Record<string, string>,
	) {}

	private notifyClosed(): void {
		if (this.closedNotified) return;
		this.closedNotified = true;
		this.onclose?.();
	}

	async start(): Promise<void> {
		if (this.socket) throw new Error("WebSocket transport already started");
		this.closedNotified = false;
		await new Promise<void>((resolve, reject) => {
			const socket = new WebSocket(this.url, { headers: this.headers });
			this.socket = socket;
			let settled = false;
			socket.once("open", () => {
				settled = true;
				resolve();
			});
			socket.once("error", (error) => {
				const err = error instanceof Error ? error : new Error(String(error));
				this.onerror?.(err);
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
			socket.on("message", (data) => {
				try {
					const text = typeof data === "string" ? data : data.toString("utf8");
					this.onmessage?.(JSON.parse(text) as JSONRPCMessage);
				} catch (error) {
					this.onerror?.(error instanceof Error ? error : new Error(String(error)));
				}
			});
			socket.once("close", () => this.notifyClosed());
		});
	}

	async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket transport is not open");
		await new Promise<void>((resolve, reject) => {
			this.socket?.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve()));
		});
	}

	async close(): Promise<void> {
		const socket = this.socket;
		this.socket = undefined;
		if (!socket || socket.readyState === WebSocket.CLOSED) {
			this.notifyClosed();
			return;
		}
		await new Promise<void>((resolve) => {
			socket.once("close", () => resolve());
			socket.close();
			setTimeout(resolve, 1000).unref?.();
		});
		this.notifyClosed();
	}
}

export async function createMcpTransport(config: ScopedMcpServerConfig, context: TransportContext): Promise<TransportFactoryResult> {
	const warnings: string[] = [];
	const type = getTransportType(config);

	if (type === "stdio") {
		const stdioConfig = config as Extract<McpServerConfig, { command: string }>;
		const transport = new StdioClientTransport({
			command: stdioConfig.command,
			args: stdioConfig.args ?? [],
			env: { ...getDefaultEnvironment(), ...(stdioConfig.env ?? {}) },
			cwd: context.cwd,
			stderr: "pipe",
		});
		// Drain stderr so verbose MCP servers cannot block on a full pipe. We intentionally do
		// not surface stderr directly into model context.
		transport.stderr?.on("data", () => undefined);
		return { transport, warnings };
	}

	if (!isNetworkConfig(config)) throw new Error(`Unsupported MCP transport: ${type}`);
	const { headers, warnings: headerWarnings } = await resolveNetworkHeaders(config, context);
	warnings.push(...headerWarnings);
	const url = new URL(config.url);

	if (type === "http") {
		return {
			transport: new StreamableHTTPClientTransport(url, {
				authProvider: context.authProvider,
				requestInit: { headers },
				reconnectionOptions: {
					initialReconnectionDelay: 1000,
					reconnectionDelayGrowFactor: 1.5,
					maxReconnectionDelay: 30_000,
					maxRetries: 3,
				},
			}),
			warnings,
		};
	}

	if (type === "sse") {
		const fetchWithHeaders = ((requestUrl: string | URL, init: RequestInit = {}) => {
			return fetch(requestUrl, { ...init, headers: mergeHeaders(init.headers, headers) });
		}) as never;
		return {
			transport: new SSEClientTransport(url, {
				authProvider: context.authProvider,
				requestInit: { headers },
				eventSourceInit: { fetch: fetchWithHeaders },
			}),
			warnings,
		};
	}

	return { transport: new HeaderWebSocketClientTransport(url, headers), warnings };
}
