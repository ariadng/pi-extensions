import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { convertMcpResourceResult, convertMcpToolResult } from "./output.js";
import { buildMcpToolName, withStableSuffix } from "./names.js";
import type { McpConnectionManager } from "./manager.js";
import type { ConfigScope, McpCachedResource, McpCachedTool, McpManifest, McpToolMapping, RuntimeToolRegistry, ServerSummary } from "./types.js";

const ListServersParams = Type.Object({
	includeTools: Type.Optional(Type.Boolean({ description: "Include cached/discovered tool names for each server" })),
});

const ActivateServerParams = Type.Object({
	server: Type.String({ description: "Configured MCP server name" }),
	refresh: Type.Optional(Type.Boolean({ description: "Reconnect and refresh the manifest even if already connected" })),
});

const ListResourcesParams = Type.Object({
	server: Type.Optional(Type.String({ description: "Optional MCP server name" })),
	activate: Type.Optional(Type.Boolean({ description: "Activate the named server before listing resources" })),
});

const ReadResourceParams = Type.Object({
	server: Type.String({ description: "MCP server name" }),
	uri: Type.String({ description: "Resource URI to read" }),
});

const AuthenticateParams = Type.Object({});

export interface McpExtensionRuntime {
	manager?: McpConnectionManager;
	registry: RuntimeToolRegistry;
}

export function createMcpRuntime(): McpExtensionRuntime {
	return {
		registry: {
			registeredProxyTools: new Set(),
			toolMappings: new Map(),
			registeredPromptCommands: new Set(),
			promptMappings: new Map(),
			registeredAuthTools: new Set(),
		},
	};
}

function requireManager(runtime: McpExtensionRuntime): McpConnectionManager {
	if (!runtime.manager) throw new Error("MCP extension is not initialized yet");
	return runtime.manager;
}

function scopeLabel(scope: ConfigScope): string {
	switch (scope) {
		case "user":
			return "User MCPs";
		case "project":
			return "Project MCPs";
		case "local":
			return "Project-local MCPs";
		case "dynamic":
			return "Dynamic MCPs";
	}
}

function statusIcon(status: ServerSummary["status"]): string {
	switch (status) {
		case "connected":
			return "✓";
		case "failed":
			return "✗";
		case "needs-auth":
			return "!";
		case "disabled":
			return "-";
		case "activating":
			return "…";
		default:
			return "○";
	}
}

function formatSummaryLine(summary: ServerSummary): string {
	const counts = [`${summary.toolCount} tools`, `${summary.resourceCount} resources`, `${summary.promptCount} prompts`].join(" · ");
	const error = summary.error ? ` · ${summary.error}` : "";
	return `  ${statusIcon(summary.status)} ${summary.name} · ${summary.status} · ${summary.transport} · ${counts}${error}`;
}

export function formatServerList(manager: McpConnectionManager, includeTools = false): string {
	const summaries = manager.getSummaries();
	if (summaries.length === 0) return "No MCP servers configured.";
	const sections: string[] = ["MCP servers"];
	for (const scope of ["project", "local", "user", "dynamic"] as ConfigScope[]) {
		const scoped = summaries.filter((summary) => summary.scope === scope);
		if (scoped.length === 0) continue;
		sections.push("", scopeLabel(scope));
		for (const summary of scoped) {
			sections.push(formatSummaryLine(summary));
			if (includeTools) {
				const manifest = manager.getManifest(summary.name);
				for (const tool of manifest?.tools ?? []) sections.push(`      - ${tool.piToolName} (${tool.originalToolName})`);
			}
		}
	}
	return sections.join("\n");
}

function chooseRegisteredPiToolName(runtime: McpExtensionRuntime, tool: McpCachedTool): string {
	const existing = runtime.registry.toolMappings.get(tool.piToolName);
	if (!existing || (existing.serverName === tool.serverName && existing.originalToolName === tool.originalToolName)) return tool.piToolName;
	let candidate = withStableSuffix(tool.piToolName, tool.serverName, tool.originalToolName);
	let counter = 1;
	while (runtime.registry.toolMappings.has(candidate)) candidate = withStableSuffix(tool.piToolName, tool.serverName, tool.originalToolName, String(counter++));
	return candidate;
}

function schemaForTool(tool: McpCachedTool) {
	return Type.Unsafe(tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} });
}

function truncateDescription(description: string | undefined): string {
	if (!description) return "MCP tool";
	return description.length > 2048 ? `${description.slice(0, 2045)}...` : description;
}

function deactivateTools(pi: ExtensionAPI, names: Set<string>): void {
	if (names.size === 0) return;
	const active = pi.getActiveTools();
	const next = active.filter((name) => !names.has(name));
	if (next.length !== active.length) pi.setActiveTools(next);
}

export function deactivateServerTools(pi: ExtensionAPI, runtime: McpExtensionRuntime, serverName: string): void {
	const names = new Set<string>();
	for (const [piToolName, mapping] of runtime.registry.toolMappings) {
		if (mapping.serverName === serverName) names.add(piToolName);
	}
	names.add(getAuthToolName(serverName));
	deactivateTools(pi, names);
}

export function getAuthToolName(serverName: string): string {
	return buildMcpToolName(serverName, "authenticate");
}

export function deactivateAuthTool(pi: ExtensionAPI, runtime: McpExtensionRuntime, serverName: string): void {
	const name = getAuthToolName(serverName);
	deactivateTools(pi, new Set([name]));
	runtime.registry.registeredAuthTools.delete(name);
}

export function registerAuthTool(pi: ExtensionAPI, runtime: McpExtensionRuntime, manager: McpConnectionManager, serverName: string): void {
	const name = getAuthToolName(serverName);
	runtime.registry.registeredAuthTools.add(name);
	pi.registerTool({
		name,
		label: `Authenticate MCP ${serverName}`,
		description: `Start OAuth authentication for the ${serverName} MCP server and return an authorization URL.`,
		promptSnippet: `Authenticate the ${serverName} MCP server. This starts OAuth and returns an authorization URL for the user to open.`,
		parameters: AuthenticateParams,
		executionMode: "sequential",
		async execute() {
			const result = await manager.startAuthFlow(serverName);
			return { content: [{ type: "text", text: result.message }], details: { status: result.status, authUrl: result.authUrl } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(name)) + theme.fg("muted", ` → OAuth for ${serverName}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Starting MCP OAuth..."), 0, 0);
			const first = result.content[0];
			const text = first?.type === "text" ? first.text.split("\n")[0] : "OAuth started";
			return new Text(theme.fg("success", text), 0, 0);
		},
	} satisfies ToolDefinition<typeof AuthenticateParams, any>);
}

export function registerManifestTools(pi: ExtensionAPI, runtime: McpExtensionRuntime, manager: McpConnectionManager, _serverName: string, manifest: McpManifest): void {
	deactivateAuthTool(pi, runtime, _serverName);
	const newNames = new Set<string>();
	for (const tool of manifest.tools) {
		const piToolName = chooseRegisteredPiToolName(runtime, tool);
		const mapping: McpToolMapping = { piToolName, serverName: tool.serverName, originalToolName: tool.originalToolName };
		newNames.add(piToolName);
		runtime.registry.toolMappings.set(piToolName, mapping);
		runtime.registry.registeredProxyTools.add(piToolName);

		const title = tool.title ?? tool.originalToolName;
		const description = truncateDescription(tool.description ?? `Call MCP tool ${tool.originalToolName} on server ${tool.serverName}`);
		const executionMode = tool.annotations?.readOnlyHint === true ? "parallel" : "sequential";

		pi.registerTool({
			name: piToolName,
			label: `MCP ${title}`,
			description,
			promptSnippet: `${description} (MCP server: ${tool.serverName})`,
			parameters: schemaForTool(tool),
			executionMode,
			async execute(_toolCallId, params, signal) {
				const result = await manager.callTool(mapping, params as Record<string, unknown>, signal);
				const converted = await convertMcpToolResult(result, piToolName);
				if (converted.isError) throw new Error(converted.text);
				return { content: converted.content, details: converted.details };
			},
			renderCall(args, theme) {
				let text = theme.fg("toolTitle", theme.bold(piToolName));
				text += theme.fg("muted", ` → ${tool.serverName}/${tool.originalToolName}`);
				const keys = args && typeof args === "object" ? Object.keys(args as Record<string, unknown>) : [];
				if (keys.length > 0) text += theme.fg("dim", ` (${keys.join(", ")})`);
				return new Text(text, 0, 0);
			},
			renderResult(result, { isPartial }, theme) {
				if (isPartial) return new Text(theme.fg("warning", "Calling MCP tool..."), 0, 0);
				const first = result.content[0];
				const text = first?.type === "text" ? first.text.split("\n")[0] : "MCP tool returned non-text content";
				return new Text(theme.fg("success", text), 0, 0);
			},
		} satisfies ToolDefinition<any, any>);
	}

	const stale = new Set<string>();
	for (const [piToolName, mapping] of runtime.registry.toolMappings) {
		if (mapping.serverName === _serverName && !newNames.has(piToolName)) stale.add(piToolName);
	}
	deactivateTools(pi, stale);
	for (const piToolName of stale) {
		runtime.registry.toolMappings.delete(piToolName);
		runtime.registry.registeredProxyTools.delete(piToolName);
	}
}

export function registerCachedProxyTools(pi: ExtensionAPI, runtime: McpExtensionRuntime): void {
	const manager = requireManager(runtime);
	for (const serverName of manager.getServerNames()) {
		const manifest = manager.getManifest(serverName);
		if (manifest) registerManifestTools(pi, runtime, manager, serverName, manifest);
	}
}

function formatActivationResult(serverName: string, manifest: McpManifest): string {
	const lines = [`Activated MCP server ${serverName}.`, `Tools: ${manifest.tools.length}`, `Resources: ${manifest.resources.length}`, `Prompts: ${manifest.prompts.length}`];
	if (manifest.tools.length > 0) lines.push("", ...manifest.tools.map((tool) => `- ${tool.piToolName}: ${tool.description ?? tool.originalToolName}`));
	return lines.join("\n");
}

function formatResources(resources: McpCachedResource[]): string {
	if (resources.length === 0) return "No MCP resources available.";
	return [
		"MCP resources",
		...resources.map((resource) => {
			const label = resource.title ?? resource.name;
			const mime = resource.mimeType ? ` · ${resource.mimeType}` : "";
			return `- ${resource.serverName}: ${label} <${resource.uri}>${mime}`;
		}),
	].join("\n");
}

export function getResourcesForListing(manager: McpConnectionManager, server?: string): McpCachedResource[] {
	const names = server ? [server] : manager.getServerNames();
	const resources: McpCachedResource[] = [];
	for (const name of names) resources.push(...(manager.getManifest(name)?.resources ?? []));
	return resources;
}

export function registerAlwaysOnTools(pi: ExtensionAPI, runtime: McpExtensionRuntime): void {
	pi.registerTool({
		name: "mcp_list_servers",
		label: "MCP Servers",
		description: "List configured MCP servers without activating dormant servers.",
		promptSnippet: "List configured dormant, connected, failed, or disabled MCP servers without connecting to them.",
		promptGuidelines: [
			"Use mcp_list_servers when the user asks about available MCP integrations or when a task may need an MCP server.",
		],
		parameters: ListServersParams,
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			const manager = requireManager(runtime);
			return { content: [{ type: "text", text: formatServerList(manager, params.includeTools === true) }], details: manager.getSummaries() };
		},
	});

	pi.registerTool({
		name: "mcp_activate_server",
		label: "Activate MCP",
		description: "Activate a dormant MCP server and discover its tools/resources/prompts. This does not ask for permission.",
		promptSnippet: "Activate a configured MCP server lazily and discover tools/resources/prompts.",
		promptGuidelines: [
			"Use mcp_activate_server when the user asks for work that may need an MCP integration. Project MCP servers are dormant until activated; activation does not require user confirmation.",
		],
		parameters: ActivateServerParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const manager = requireManager(runtime);
			const connected = await manager.activateServer(params.server, { refresh: params.refresh === true, signal });
			return { content: [{ type: "text", text: formatActivationResult(params.server, connected.manifest) }], details: connected.manifest };
		},
	});

	pi.registerTool({
		name: "mcp_list_resources",
		label: "MCP Resources",
		description: "List MCP resources from a named server or from connected/cached manifests. Does not activate all dormant servers.",
		promptSnippet: "List MCP resources from cached or connected servers without activating every server.",
		parameters: ListResourcesParams,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			const manager = requireManager(runtime);
			if (params.server && params.activate === true) await manager.refreshResources(params.server, signal);
			return { content: [{ type: "text", text: formatResources(getResourcesForListing(manager, params.server)) }], details: { resources: getResourcesForListing(manager, params.server) } };
		},
	});

	pi.registerTool({
		name: "mcp_read_resource",
		label: "Read MCP Resource",
		description: "Read a resource from an MCP server by server name and URI. Activates the named server if needed.",
		promptSnippet: "Read a specific MCP resource by server and URI, activating that server lazily if needed.",
		parameters: ReadResourceParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const manager = requireManager(runtime);
			const result = await manager.readResource(params.server, params.uri, signal);
			const converted = await convertMcpResourceResult(result, "resource");
			return { content: converted.content, details: converted.details };
		},
	});
}
