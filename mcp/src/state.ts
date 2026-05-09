import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPiAgentDir } from "./config.js";
import type { McpManifest, McpProjectState, McpStateFile, ScopedMcpServerConfig } from "./types.js";

export const STATE_VERSION = 1 as const;

export function getStateFilePath(): string {
	return process.env.PI_MCP_STATE_FILE ? process.env.PI_MCP_STATE_FILE : path.join(getPiAgentDir(), "mcp-state.json");
}

export function createEmptyProjectState(): McpProjectState {
	return { disabledServers: [], manifestCache: {} };
}

export function createEmptyState(): McpStateFile {
	return { version: STATE_VERSION, projects: {}, global: createEmptyProjectState() };
}

function normalizeProjectState(value: unknown): McpProjectState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return createEmptyProjectState();
	const input = value as Partial<McpProjectState>;
	return {
		disabledServers: Array.isArray(input.disabledServers) ? input.disabledServers.filter((item): item is string => typeof item === "string") : [],
		manifestCache: input.manifestCache && typeof input.manifestCache === "object" && !Array.isArray(input.manifestCache) ? input.manifestCache : {},
	};
}

export async function loadMcpState(): Promise<{ state: McpStateFile; warnings: string[] }> {
	const filePath = getStateFilePath();
	if (!existsSync(filePath)) return { state: createEmptyState(), warnings: [] };
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<McpStateFile>;
		const state: McpStateFile = {
			version: STATE_VERSION,
			projects: {},
			global: normalizeProjectState(parsed.global),
		};
		if (parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)) {
			for (const [cwd, projectState] of Object.entries(parsed.projects)) state.projects[cwd] = normalizeProjectState(projectState);
		}
		return { state, warnings: [] };
	} catch (error) {
		return {
			state: createEmptyState(),
			warnings: [`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}. Starting with empty MCP state.`],
		};
	}
}

export async function saveMcpState(state: McpStateFile): Promise<void> {
	const filePath = getStateFilePath();
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function getProjectState(state: McpStateFile, cwd: string): McpProjectState {
	state.projects[cwd] ??= createEmptyProjectState();
	return state.projects[cwd];
}

function disabledSetForConfig(state: McpStateFile, cwd: string, config: ScopedMcpServerConfig): Set<string> {
	const project = getProjectState(state, cwd);
	return new Set(config.scope === "user" ? state.global.disabledServers : project.disabledServers);
}

export function isServerDisabled(state: McpStateFile, cwd: string, name: string, config: ScopedMcpServerConfig): boolean {
	if (state.global.disabledServers.includes(name)) return true;
	if (config.scope !== "user" && getProjectState(state, cwd).disabledServers.includes(name)) return true;
	return disabledSetForConfig(state, cwd, config).has(name);
}

export function setServerDisabled(state: McpStateFile, cwd: string, name: string, config: ScopedMcpServerConfig, disabled: boolean): void {
	const bucket = config.scope === "user" ? state.global.disabledServers : getProjectState(state, cwd).disabledServers;
	const index = bucket.indexOf(name);
	if (disabled && index === -1) bucket.push(name);
	if (!disabled && index !== -1) bucket.splice(index, 1);
}

export function setAllServersDisabled(
	state: McpStateFile,
	cwd: string,
	servers: Map<string, ScopedMcpServerConfig>,
	disabled: boolean,
): void {
	for (const [name, config] of servers) setServerDisabled(state, cwd, name, config, disabled);
}

export function getCachedManifest(state: McpStateFile, cwd: string, name: string, config: ScopedMcpServerConfig): McpManifest | undefined {
	const caches = [getProjectState(state, cwd).manifestCache, state.global.manifestCache];
	for (const cache of caches) {
		const manifest = cache[name];
		if (manifest?.configHash === config.configHash) return manifest;
	}
	return undefined;
}

export function setCachedManifest(state: McpStateFile, cwd: string, name: string, config: ScopedMcpServerConfig, manifest: McpManifest): void {
	const bucket = config.scope === "user" ? state.global.manifestCache : getProjectState(state, cwd).manifestCache;
	bucket[name] = manifest;
}

export function deleteCachedManifest(state: McpStateFile, cwd: string, name: string, config: ScopedMcpServerConfig): void {
	const project = getProjectState(state, cwd);
	delete project.manifestCache[name];
	if (config.scope === "user") delete state.global.manifestCache[name];
}
