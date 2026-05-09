import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
	ConfigScope,
	LoadedMcpConfig,
	McpServerConfig,
	McpTransport,
	ScopedMcpServerConfig,
	ScopedServerEntry,
} from "./types.js";
import { normalizeNameForMCP, validateServerName } from "./names.js";

const SCOPE_ORDER: ConfigScope[] = ["user", "project", "local", "dynamic"];
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;

export function getPiAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ? expandHome(process.env.PI_CODING_AGENT_DIR) : path.join(homedir(), ".pi", "agent");
}

export function getConfigPaths(cwd: string): Partial<Record<ConfigScope, string>> {
	return {
		user: path.join(getPiAgentDir(), "mcp.json"),
		project: path.join(cwd, ".mcp.json"),
		local: path.join(cwd, ".pi", "mcp.local.json"),
	};
}

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
		.join(",")}}`;
}

export function hashConfig(config: McpServerConfig): string {
	return `sha256:${createHash("sha256").update(stableStringify(config)).digest("hex")}`;
}

export function getTransportType(config: McpServerConfig): McpTransport {
	return (config.type ?? "stdio") as McpTransport;
}

export interface EnvExpansionResult<T> {
	value: T;
	missing: string[];
}

export function expandEnvInString(input: string, env: NodeJS.ProcessEnv = process.env): EnvExpansionResult<string> {
	const missing = new Set<string>();
	const value = input.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) => {
		const envValue = env[name];
		if (envValue !== undefined) return envValue;
		if (fallback !== undefined) return fallback;
		missing.add(name);
		return "";
	});
	return { value, missing: [...missing] };
}

export function expandEnvDeep<T>(input: T, env: NodeJS.ProcessEnv = process.env): EnvExpansionResult<T> {
	const missing = new Set<string>();
	function visit(value: unknown): unknown {
		if (typeof value === "string") {
			const expanded = expandEnvInString(value, env);
			for (const name of expanded.missing) missing.add(name);
			return expanded.value;
		}
		if (Array.isArray(value)) return value.map((item) => visit(item));
		if (value && typeof value === "object") {
			const output: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(value)) output[key] = visit(child);
			return output;
		}
		return value;
	}
	return { value: visit(input) as T, missing: [...missing] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	return Object.values(value).every((item) => typeof item === "string");
}

function validateOAuthConfig(name: string, value: unknown): { oauth?: Record<string, unknown>; errors: string[] } {
	const errors: string[] = [];
	if (value === undefined) return { errors };
	if (!isRecord(value)) return { errors: [`${name}: oauth must be an object`] };
	if (value.scope !== undefined && typeof value.scope !== "string") errors.push(`${name}: oauth.scope must be a string`);
	if (value.clientId !== undefined && typeof value.clientId !== "string") errors.push(`${name}: oauth.clientId must be a string`);
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") errors.push(`${name}: oauth.clientSecret must be a string`);
	if (value.clientMetadataUrl !== undefined && typeof value.clientMetadataUrl !== "string") errors.push(`${name}: oauth.clientMetadataUrl must be a string`);
	if (value.clientMetadata !== undefined && !isRecord(value.clientMetadata)) errors.push(`${name}: oauth.clientMetadata must be an object`);
	return { oauth: value, errors };
}

function validateStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateServerConfig(name: string, raw: unknown): { config?: McpServerConfig; errors: string[] } {
	const errors: string[] = [];
	const nameError = validateServerName(name);
	if (nameError) errors.push(`${name}: ${nameError}`);

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { errors: [...errors, `${name}: server config must be an object`] };
	}

	const input = raw as Record<string, unknown>;
	const type = input.type === undefined ? "stdio" : input.type;
	if (type !== "stdio" && type !== "http" && type !== "sse" && type !== "ws") {
		errors.push(`${name}: type must be one of stdio, http, sse, ws`);
		return { errors };
	}

	if (input.args !== undefined && !validateStringArray(input.args)) errors.push(`${name}: args must be an array of strings`);
	if (input.env !== undefined && !isStringRecord(input.env)) errors.push(`${name}: env must be an object with string values`);
	if (input.headers !== undefined && !isStringRecord(input.headers)) errors.push(`${name}: headers must be an object with string values`);
	if (input.headersHelper !== undefined && typeof input.headersHelper !== "string") errors.push(`${name}: headersHelper must be a string`);
	const oauthValidation = validateOAuthConfig(name, input.oauth);
	if (oauthValidation.errors.length > 0) errors.push(...oauthValidation.errors);

	if (type === "stdio") {
		if (typeof input.command !== "string" || input.command.length === 0) errors.push(`${name}: stdio servers require a non-empty command`);
		if (errors.length > 0) return { errors };
		return {
			config: {
				type: input.type === undefined ? undefined : "stdio",
				command: input.command as string,
				args: input.args as string[] | undefined,
				env: input.env as Record<string, string> | undefined,
			},
			errors,
		};
	}

	if (typeof input.url !== "string" || input.url.length === 0) errors.push(`${name}: ${type} servers require a non-empty url`);
	else {
		try {
			const url = new URL(input.url);
			if (type === "ws" && url.protocol !== "ws:" && url.protocol !== "wss:") errors.push(`${name}: ws url must use ws:// or wss://`);
			if ((type === "http" || type === "sse") && url.protocol !== "http:" && url.protocol !== "https:") {
				errors.push(`${name}: ${type} url must use http:// or https://`);
			}
		} catch {
			errors.push(`${name}: url is not valid`);
		}
	}
	if (errors.length > 0) return { errors };

	const network = {
		type,
		url: input.url as string,
		headers: input.headers as Record<string, string> | undefined,
		headersHelper: input.headersHelper as string | undefined,
		oauth: oauthValidation.oauth,
	};
	return { config: network as McpServerConfig, errors };
}

async function loadConfigFile(scope: ConfigScope, filePath: string): Promise<{ entries: ScopedServerEntry[]; warnings: string[]; errors: string[] }> {
	const warnings: string[] = [];
	const errors: string[] = [];
	const entries: ScopedServerEntry[] = [];

	if (!existsSync(filePath)) return { entries, warnings, errors };

	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		return { entries, warnings, errors: [`${filePath}: failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { entries, warnings, errors: [`${filePath}: config must be an object`] };
	}
	const root = parsed as Record<string, unknown>;
	if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) {
		return { entries, warnings, errors: [`${filePath}: mcpServers must be an object`] };
	}

	for (const [name, rawConfig] of Object.entries(root.mcpServers as Record<string, unknown>)) {
		const expanded = expandEnvDeep(rawConfig);
		for (const missing of expanded.missing) warnings.push(`${filePath}: ${name} references missing environment variable ${missing}`);

		const validated = validateServerConfig(name, expanded.value);
		if (!validated.config) {
			errors.push(...validated.errors.map((error) => `${filePath}: ${error}`));
			continue;
		}

		const configHash = hashConfig(validated.config);
		entries.push({
			name,
			config: {
				...validated.config,
				scope,
				configPath: filePath,
				configHash,
			} as ScopedMcpServerConfig,
		});
	}

	return { entries, warnings, errors };
}

export async function loadMcpConfig(cwd: string): Promise<LoadedMcpConfig> {
	const paths = getConfigPaths(cwd);
	const byScope: Record<ConfigScope, ScopedServerEntry[]> = { user: [], project: [], local: [], dynamic: [] };
	const warnings: string[] = [];
	const errors: string[] = [];

	for (const scope of SCOPE_ORDER) {
		const filePath = paths[scope];
		if (!filePath) continue;
		const result = await loadConfigFile(scope, filePath);
		byScope[scope].push(...result.entries);
		warnings.push(...result.warnings);
		errors.push(...result.errors);
	}

	const servers = new Map<string, ScopedMcpServerConfig>();
	for (const scope of SCOPE_ORDER) {
		for (const entry of byScope[scope]) servers.set(entry.name, entry.config);
	}

	const normalizedToServer = new Map<string, string>();
	for (const name of servers.keys()) {
		const normalized = normalizeNameForMCP(name);
		const existing = normalizedToServer.get(normalized);
		if (existing && existing !== name) {
			warnings.push(`server names ${existing} and ${name} both normalize to ${normalized}; conflicting proxy names will receive stable suffixes`);
		} else {
			normalizedToServer.set(normalized, name);
		}
	}

	return { servers, byScope, warnings, errors, paths };
}

export function formatConfigError(errors: string[]): string {
	return errors.length === 1 ? errors[0] : errors.map((error) => `- ${error}`).join("\n");
}
