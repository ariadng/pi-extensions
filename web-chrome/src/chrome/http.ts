import { abortError } from "../util/async-queue.js";
import { CdpError } from "../util/errors.js";

export interface ChromeVersionResponse {
	Browser?: string;
	"Protocol-Version"?: string;
	"User-Agent"?: string;
	"V8-Version"?: string;
	webSocketDebuggerUrl?: string;
	[key: string]: unknown;
}

export interface ChromeTargetInfoFromHttp {
	id: string;
	type: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
	[key: string]: unknown;
}

export interface ResolvedEndpoint {
	endpoint?: string;
	webSocketDebuggerUrl: string;
	version?: ChromeVersionResponse;
}

export async function resolveBrowserEndpoint(endpoint: string, timeoutMs: number, signal?: AbortSignal): Promise<ResolvedEndpoint> {
	const parsed = parseEndpoint(endpoint);
	if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
		return { webSocketDebuggerUrl: parsed.toString() };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("CDP endpoint must be an http(s) debugging endpoint or ws(s) browser WebSocket URL.");
	}

	const base = normalizeHttpBase(parsed);
	const version = await fetchChromeVersion(base, timeoutMs, signal);
	if (!version.webSocketDebuggerUrl) {
		throw new Error(`${base}/json/version did not include webSocketDebuggerUrl.`);
	}
	return { endpoint: base, webSocketDebuggerUrl: version.webSocketDebuggerUrl, version };
}

export async function fetchChromeVersion(endpoint: string, timeoutMs: number, signal?: AbortSignal): Promise<ChromeVersionResponse> {
	return fetchJson<ChromeVersionResponse>(`${endpoint.replace(/\/$/, "")}/json/version`, timeoutMs, signal);
}

export async function fetchChromeTargets(endpoint: string, timeoutMs: number, signal?: AbortSignal): Promise<ChromeTargetInfoFromHttp[]> {
	return fetchJson<ChromeTargetInfoFromHttp[]>(`${endpoint.replace(/\/$/, "")}/json/list`, timeoutMs, signal);
}

export function assertLocalEndpoint(endpoint: string): void {
	const parsed = parseEndpoint(endpoint);
	if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
		throw new Error("CDP endpoint must use http, https, ws, or wss.");
	}
	const host = parsed.hostname.toLowerCase();
	if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
		throw new Error("web-chrome MVP only allows localhost CDP endpoints. Use 127.0.0.1 or localhost.");
	}
}

function normalizeHttpBase(parsed: URL): string {
	return `${parsed.protocol}//${parsed.host}`;
}

function parseEndpoint(endpoint: string): URL {
	try {
		return new URL(endpoint);
	} catch (error) {
		throw new Error(`Invalid CDP endpoint URL: ${endpoint}`);
	}
}

async function fetchJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	if (signal?.aborted) {
		clearTimeout(timeout);
		throw abortError();
	}
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new CdpError(`Chrome debugging endpoint returned HTTP ${response.status} for ${url}.`);
		return (await response.json()) as T;
	} catch (error) {
		if (controller.signal.aborted || signal?.aborted) throw abortError(`Timed out or cancelled fetching ${url}`);
		throw error;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}
