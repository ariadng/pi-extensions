import { createHash } from "node:crypto";

export function normalizeNameForMCP(name: string): string {
	const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	return normalized.length > 0 ? normalized : "unnamed";
}

export function getMcpPrefix(serverName: string): string {
	return `mcp__${normalizeNameForMCP(serverName)}__`;
}

export function buildMcpToolName(serverName: string, toolName: string): string {
	return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`;
}

export function stableSuffix(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 8);
}

export function withStableSuffix(name: string, ...parts: string[]): string {
	return `${name}_${stableSuffix(...parts)}`;
}

export function validateServerName(name: string): string | undefined {
	if (!name.trim()) return "server name must not be empty";
	if (name.includes("__")) return "server name must not contain double underscores";
	if (name.length > 128) return "server name must be 128 characters or shorter";
	return undefined;
}
