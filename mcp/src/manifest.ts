import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpToolName, stableSuffix, withStableSuffix } from "./names.js";
import type { McpCachedPrompt, McpCachedResource, McpCachedTool, McpManifest, ScopedMcpServerConfig } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function copyAnnotations(value: unknown): Record<string, unknown> | undefined {
	return asRecord(value);
}

function uniquePiToolName(serverName: string, originalToolName: string, seen: Set<string>): string {
	const base = buildMcpToolName(serverName, originalToolName);
	if (!seen.has(base)) {
		seen.add(base);
		return base;
	}
	let candidate = withStableSuffix(base, serverName, originalToolName);
	let counter = 1;
	while (seen.has(candidate)) {
		candidate = `${base}_${stableSuffix(serverName, originalToolName, String(counter++))}`;
	}
	seen.add(candidate);
	return candidate;
}

async function listAll<T>(load: (cursor?: string) => Promise<{ nextCursor?: string } & Record<string, unknown>>, field: string): Promise<T[]> {
	const values: T[] = [];
	let cursor: string | undefined;
	for (;;) {
		const result = await load(cursor);
		const page = result[field];
		if (Array.isArray(page)) values.push(...(page as T[]));
		cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
		if (!cursor) break;
	}
	return values;
}

export async function discoverManifest(
	client: Client,
	serverName: string,
	config: ScopedMcpServerConfig,
	requestTimeoutMs: number,
): Promise<McpManifest> {
	const capabilities = client.getServerCapabilities() ?? ({} as ServerCapabilities);
	const seenToolNames = new Set<string>();
	const tools: McpCachedTool[] = [];
	const resources: McpCachedResource[] = [];
	const prompts: McpCachedPrompt[] = [];
	const seenPromptNames = new Set<string>();

	if (capabilities.tools) {
		const listed = await listAll<Record<string, unknown>>(
			(cursor) => client.listTools(cursor ? { cursor } : undefined, { timeout: requestTimeoutMs }) as Promise<{ nextCursor?: string } & Record<string, unknown>>,
			"tools",
		);
		for (const tool of listed) {
			if (typeof tool.name !== "string") continue;
			tools.push({
				piToolName: uniquePiToolName(serverName, tool.name, seenToolNames),
				serverName,
				originalToolName: tool.name,
				title: typeof tool.title === "string" ? tool.title : undefined,
				description: typeof tool.description === "string" ? tool.description : undefined,
				inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
				annotations: copyAnnotations(tool.annotations),
			});
		}
	}

	if (capabilities.resources) {
		const listed = await listAll<Record<string, unknown>>(
			(cursor) => client.listResources(cursor ? { cursor } : undefined, { timeout: requestTimeoutMs }) as Promise<{ nextCursor?: string } & Record<string, unknown>>,
			"resources",
		);
		for (const resource of listed) {
			if (typeof resource.uri !== "string" || typeof resource.name !== "string") continue;
			resources.push({
				serverName,
				uri: resource.uri,
				name: resource.name,
				title: typeof resource.title === "string" ? resource.title : undefined,
				description: typeof resource.description === "string" ? resource.description : undefined,
				mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined,
				size: typeof resource.size === "number" ? resource.size : undefined,
			});
		}
	}

	if (capabilities.prompts) {
		const listed = await listAll<Record<string, unknown>>(
			(cursor) => client.listPrompts(cursor ? { cursor } : undefined, { timeout: requestTimeoutMs }) as Promise<{ nextCursor?: string } & Record<string, unknown>>,
			"prompts",
		);
		for (const prompt of listed) {
			if (typeof prompt.name !== "string") continue;
			prompts.push({
				piCommandName: uniquePiToolName(serverName, prompt.name, seenPromptNames),
				serverName,
				name: prompt.name,
				title: typeof prompt.title === "string" ? prompt.title : undefined,
				description: typeof prompt.description === "string" ? prompt.description : undefined,
				arguments: Array.isArray(prompt.arguments)
					? prompt.arguments
							.filter((argument): argument is Record<string, unknown> => Boolean(argument) && typeof argument === "object" && !Array.isArray(argument))
							.map((argument) => ({
								name: typeof argument.name === "string" ? argument.name : "argument",
								description: typeof argument.description === "string" ? argument.description : undefined,
								required: typeof argument.required === "boolean" ? argument.required : undefined,
							}))
					: undefined,
			});
		}
	}

	return {
		configHash: config.configHash,
		discoveredAt: new Date().toISOString(),
		capabilities,
		tools,
		resources,
		prompts,
	};
}

export function summarizeManifest(manifest: McpManifest | undefined): string {
	if (!manifest) return "0 tools · 0 resources · 0 prompts";
	return `${manifest.tools.length} tools · ${manifest.resources.length} resources · ${manifest.prompts.length} prompts`;
}
