import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type WebFetchConfig = {
	maxUrlLength: number;
	maxBytes: number;
	timeoutMs: number;
	redirects: number;
	cacheTtlMs: number;
	cacheBytes: number;
	maxMarkdownChars: number;
	maxSummaryTokens: number;
	allowPrivate: boolean;
	allowHttp: boolean;
	ignoreOffline: boolean;
	rawFallback: boolean;
	allowedDomains: string[];
	blockedDomains: string[];
	preapprovedDomains: string[];
	userAgent: string;
};

export const WEB_FETCH_VERSION = "0.1.0";

export function registerWebFetchFlags(pi: ExtensionAPI): void {
	pi.registerFlag("webfetch-allow-private", {
		description: "Allow WebFetch to fetch private/localhost URLs",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("webfetch-allow-http", {
		description: "Allow WebFetch to use plain HTTP instead of upgrading http:// URLs to https://",
		type: "boolean",
		default: false,
	});
}

export function defaultWebFetchConfig(): WebFetchConfig {
	return {
		maxUrlLength: 2000,
		maxBytes: 10 * 1024 * 1024,
		timeoutMs: 60_000,
		redirects: 10,
		cacheTtlMs: 15 * 60 * 1000,
		cacheBytes: 50 * 1024 * 1024,
		maxMarkdownChars: 100_000,
		maxSummaryTokens: 4096,
		allowPrivate: false,
		allowHttp: false,
		ignoreOffline: false,
		rawFallback: false,
		allowedDomains: [],
		blockedDomains: [],
		preapprovedDomains: [],
		userAgent: `pi-webfetch/${WEB_FETCH_VERSION} (+https://pi.dev)`,
	};
}

export function resolveWebFetchConfig(pi?: ExtensionAPI, cwd = process.cwd()): WebFetchConfig {
	let config = defaultWebFetchConfig();
	config = mergeConfig(config, readConfigFile(join(homedir(), ".pi", "agent", "webfetch.json")));
	config = mergeConfig(config, readConfigFile(join(cwd, ".pi", "webfetch.json")));
	config = mergeConfig(config, envConfig());

	// Boolean flags default to false, so only true can safely override env/config.
	if (pi?.getFlag("webfetch-allow-private") === true) config.allowPrivate = true;
	if (pi?.getFlag("webfetch-allow-http") === true) config.allowHttp = true;

	return normalizeConfig(config);
}

function readConfigFile(path: string): Partial<WebFetchConfig> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return objectConfig(raw);
	} catch {
		return undefined;
	}
}

function objectConfig(raw: Record<string, unknown>): Partial<WebFetchConfig> {
	const config: Partial<WebFetchConfig> = {};
	if (Array.isArray(raw.allowedDomains)) config.allowedDomains = raw.allowedDomains.filter(isString);
	if (Array.isArray(raw.blockedDomains)) config.blockedDomains = raw.blockedDomains.filter(isString);
	if (Array.isArray(raw.preapprovedDomains)) config.preapprovedDomains = raw.preapprovedDomains.filter(isString);
	if (typeof raw.allowPrivate === "boolean") config.allowPrivate = raw.allowPrivate;
	if (typeof raw.allowHttp === "boolean") config.allowHttp = raw.allowHttp;
	if (typeof raw.ignoreOffline === "boolean") config.ignoreOffline = raw.ignoreOffline;
	if (typeof raw.rawFallback === "boolean") config.rawFallback = raw.rawFallback;
	if (typeof raw.maxMarkdownChars === "number") config.maxMarkdownChars = raw.maxMarkdownChars;
	if (typeof raw.maxSummaryTokens === "number") config.maxSummaryTokens = raw.maxSummaryTokens;
	return config;
}

function envConfig(): Partial<WebFetchConfig> {
	const env = process.env;
	return cleanUndefined({
		maxUrlLength: parsePositiveInteger(env.PI_WEBFETCH_MAX_URL_LENGTH),
		maxBytes: parsePositiveInteger(env.PI_WEBFETCH_MAX_BYTES),
		timeoutMs: parsePositiveInteger(env.PI_WEBFETCH_TIMEOUT_MS),
		redirects: parseNonNegativeInteger(env.PI_WEBFETCH_REDIRECTS),
		cacheTtlMs: parsePositiveInteger(env.PI_WEBFETCH_CACHE_TTL_MS),
		cacheBytes: parsePositiveInteger(env.PI_WEBFETCH_CACHE_BYTES),
		maxMarkdownChars: parsePositiveInteger(env.PI_WEBFETCH_MAX_MARKDOWN_CHARS),
		maxSummaryTokens: parsePositiveInteger(env.PI_WEBFETCH_MAX_SUMMARY_TOKENS),
		allowPrivate: parseBoolean(env.PI_WEBFETCH_ALLOW_PRIVATE),
		allowHttp: parseBoolean(env.PI_WEBFETCH_ALLOW_HTTP),
		ignoreOffline: parseBoolean(env.PI_WEBFETCH_IGNORE_OFFLINE),
		rawFallback: parseBoolean(env.PI_WEBFETCH_RAW_FALLBACK),
		allowedDomains: parseDomainList(env.PI_WEBFETCH_ALLOWED_DOMAINS),
		blockedDomains: parseDomainList(env.PI_WEBFETCH_BLOCKED_DOMAINS),
		userAgent: env.PI_WEBFETCH_USER_AGENT?.trim() || undefined,
	});
}

function mergeConfig(base: WebFetchConfig, patch: Partial<WebFetchConfig> | undefined): WebFetchConfig {
	if (!patch) return base;
	return { ...base, ...cleanUndefined(patch) };
}

function normalizeConfig(config: WebFetchConfig): WebFetchConfig {
	return {
		...config,
		maxUrlLength: clampInteger(config.maxUrlLength, 1, 100_000),
		maxBytes: clampInteger(config.maxBytes, 1, 1024 * 1024 * 1024),
		timeoutMs: clampInteger(config.timeoutMs, 1, 10 * 60_000),
		redirects: clampInteger(config.redirects, 0, 50),
		cacheTtlMs: clampInteger(config.cacheTtlMs, 1, 24 * 60 * 60_000),
		cacheBytes: clampInteger(config.cacheBytes, 0, 1024 * 1024 * 1024),
		maxMarkdownChars: clampInteger(config.maxMarkdownChars, 1_000, 1_000_000),
		maxSummaryTokens: clampInteger(config.maxSummaryTokens, 256, 32_000),
		allowedDomains: normalizeDomainList(config.allowedDomains),
		blockedDomains: normalizeDomainList(config.blockedDomains),
		preapprovedDomains: normalizeDomainList(config.preapprovedDomains),
	};
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parseDomainList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	return normalizeDomainList(value.split(","));
}

function normalizeDomainList(values: string[]): string[] {
	return [...new Set(values.map(normalizeDomain).filter(Boolean))];
}

function normalizeDomain(value: string): string {
	let domain = value.trim().toLowerCase();
	if (domain.startsWith("*.")) domain = domain.slice(2);
	if (domain.startsWith(".")) domain = domain.slice(1);
	while (domain.endsWith(".")) domain = domain.slice(0, -1);
	return domain;
}

function cleanUndefined<T extends Record<string, unknown>>(value: T): T {
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) output[key] = item;
	}
	return output as T;
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
