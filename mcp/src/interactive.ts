import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getTransportType } from "./config.js";
import { buildMcpToolName } from "./names.js";
import { convertMcpResourceResult } from "./output.js";
import { deactivateServerTools, type McpExtensionRuntime } from "./tools.js";
import type { McpCachedPrompt, McpCachedResource, McpCachedTool, ServerSummary } from "./types.js";

function requireManager(runtime: McpExtensionRuntime) {
	if (!runtime.manager) throw new Error("MCP extension is not initialized yet");
	return runtime.manager;
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

function serverOption(summary: ServerSummary): string {
	return `${statusIcon(summary.status)} ${summary.name} · ${summary.status} · ${summary.transport} · ${summary.toolCount} tools · ${summary.resourceCount} resources · ${summary.promptCount} prompts`;
}

function toolOption(tool: McpCachedTool): string {
	const title = tool.title && tool.title !== tool.originalToolName ? ` · ${tool.title}` : "";
	return `${tool.piToolName}${title}`;
}

function resourceOption(resource: McpCachedResource): string {
	const label = resource.title ?? resource.name;
	const mime = resource.mimeType ? ` · ${resource.mimeType}` : "";
	return `${label} · ${resource.uri}${mime}`;
}

function promptOption(prompt: McpCachedPrompt): string {
	const title = prompt.title && prompt.title !== prompt.name ? ` · ${prompt.title}` : "";
	const required = (prompt.arguments ?? []).filter((argument) => argument.required).map((argument) => argument.name);
	const args = required.length > 0 ? ` · required: ${required.join(", ")}` : "";
	return `${prompt.piCommandName ?? buildMcpToolName(prompt.serverName, prompt.name)}${title}${args}`;
}

function safeJson(value: unknown, max = 2400): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2);
	} catch {
		text = String(value);
	}
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, type);
}

async function selectFromMap<T>(ctx: ExtensionCommandContext, title: string, entries: Array<{ label: string; value: T }>): Promise<T | undefined> {
	const labels = entries.map((entry) => entry.label);
	const selected = await ctx.ui.select(title, labels, { signal: ctx.signal });
	return entries.find((entry) => entry.label === selected)?.value;
}

function formatToolDetails(tool: McpCachedTool): string {
	const lines = [`MCP tool ${tool.piToolName}`, "", `Server: ${tool.serverName}`, `Original MCP tool: ${tool.originalToolName}`];
	if (tool.title) lines.push(`Title: ${tool.title}`);
	if (tool.description) lines.push("", "Description:", tool.description);
	if (tool.annotations && Object.keys(tool.annotations).length > 0) lines.push("", "Annotations:", safeJson(tool.annotations, 1000));
	lines.push("", "Input schema:", safeJson(tool.inputSchema));
	return lines.join("\n");
}

async function runToolList(runtime: McpExtensionRuntime, serverName: string, ctx: ExtensionCommandContext): Promise<void> {
	const manager = requireManager(runtime);
	for (;;) {
		const tools = manager.getManifest(serverName)?.tools ?? [];
		if (tools.length === 0) {
			notify(ctx, `No MCP tools available for ${serverName}.`, "info");
			return;
		}
		const selected = await selectFromMap<McpCachedTool | "back">(ctx, `MCP tools for ${serverName}`, [
			...tools.map((tool) => ({ label: toolOption(tool), value: tool })),
			{ label: "Back", value: "back" },
		]);
		if (!selected || selected === "back") return;
		notify(ctx, formatToolDetails(selected));
	}
}

async function runResourceList(runtime: McpExtensionRuntime, serverName: string, ctx: ExtensionCommandContext): Promise<void> {
	const manager = requireManager(runtime);
	for (;;) {
		const resources = manager.getManifest(serverName)?.resources ?? [];
		if (resources.length === 0) {
			notify(ctx, `No MCP resources available for ${serverName}.`, "info");
			return;
		}
		const selected = await selectFromMap<McpCachedResource | "back">(ctx, `MCP resources for ${serverName}`, [
			...resources.map((resource) => ({ label: resourceOption(resource), value: resource })),
			{ label: "Back", value: "back" },
		]);
		if (!selected || selected === "back") return;
		const read = await ctx.ui.confirm(`Read ${selected.name}?`, selected.uri, { signal: ctx.signal });
		if (!read) continue;
		try {
			const result = await manager.readResource(serverName, selected.uri, ctx.signal);
			const converted = await convertMcpResourceResult(result, "resource");
			notify(ctx, converted.text);
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}
}

async function runPromptList(runtime: McpExtensionRuntime, serverName: string, ctx: ExtensionCommandContext): Promise<void> {
	const manager = requireManager(runtime);
	for (;;) {
		const prompts = manager.getManifest(serverName)?.prompts ?? [];
		if (prompts.length === 0) {
			notify(ctx, `No MCP prompts available for ${serverName}.`, "info");
			return;
		}
		const selected = await selectFromMap<McpCachedPrompt | "back">(ctx, `MCP prompts for ${serverName}`, [
			...prompts.map((prompt) => ({ label: promptOption(prompt), value: prompt })),
			{ label: "Back", value: "back" },
		]);
		if (!selected || selected === "back") return;
		const commandName = selected.piCommandName ?? buildMcpToolName(selected.serverName, selected.name);
		const args = (selected.arguments ?? []).map((argument) => `${argument.name}=`).join(" ");
		notify(ctx, [`MCP prompt ${selected.serverName}/${selected.name}`, "", `Slash command: /${commandName}${args ? ` ${args}` : ""}`, selected.description ? `\n${selected.description}` : ""].join("\n"));
	}
}

type ServerAction = "activate" | "reconnect" | "auth" | "clear-auth" | "tools" | "resources" | "prompts" | "disable" | "enable" | "back";

function buildServerActions(runtime: McpExtensionRuntime, serverName: string): Array<{ label: string; value: ServerAction }> {
	const manager = requireManager(runtime);
	const state = manager.getServerState(serverName);
	const config = manager.getServerConfig(serverName);
	const manifest = manager.getManifest(serverName);
	const actions: Array<{ label: string; value: ServerAction }> = [];
	const isDisabled = state?.type === "disabled";
	const isConnected = state?.type === "connected";
	const isNetwork = config ? getTransportType(config) !== "stdio" : false;

	if (!isDisabled && !isConnected) actions.push({ label: "Activate", value: "activate" });
	if (!isDisabled && (isConnected || state?.type === "failed" || state?.type === "needs-auth")) actions.push({ label: "Reconnect", value: "reconnect" });
	if (isNetwork) actions.push({ label: state?.type === "needs-auth" ? "Authenticate" : "Authenticate / re-authenticate", value: "auth" });
	if (isNetwork) actions.push({ label: "Clear auth", value: "clear-auth" });
	if ((manifest?.tools.length ?? 0) > 0) actions.push({ label: `View tools (${manifest?.tools.length ?? 0})`, value: "tools" });
	if ((manifest?.resources.length ?? 0) > 0) actions.push({ label: `View resources (${manifest?.resources.length ?? 0})`, value: "resources" });
	if ((manifest?.prompts.length ?? 0) > 0) actions.push({ label: `View prompts (${manifest?.prompts.length ?? 0})`, value: "prompts" });
	actions.push({ label: isDisabled ? "Enable" : "Disable", value: isDisabled ? "enable" : "disable" });
	actions.push({ label: "Back", value: "back" });
	return actions;
}

async function runServerMenu(pi: ExtensionAPI, runtime: McpExtensionRuntime, serverName: string, ctx: ExtensionCommandContext): Promise<void> {
	const manager = requireManager(runtime);
	for (;;) {
		const summary = manager.getSummaries().find((item) => item.name === serverName);
		const title = summary ? `MCP server ${serverOption(summary)}` : `MCP server ${serverName}`;
		const action = await selectFromMap<ServerAction>(ctx, title, buildServerActions(runtime, serverName));
		if (!action || action === "back") return;
		try {
			switch (action) {
				case "activate": {
					const connected = await manager.activateServer(serverName, { signal: ctx.signal });
					notify(ctx, `Activated ${serverName}: ${connected.manifest.tools.length} tools, ${connected.manifest.resources.length} resources, ${connected.manifest.prompts.length} prompts.`);
					break;
				}
				case "reconnect": {
					const connected = await manager.reconnectServer(serverName, ctx.signal);
					notify(ctx, `Reconnected ${serverName}: ${connected.manifest.tools.length} tools, ${connected.manifest.resources.length} resources, ${connected.manifest.prompts.length} prompts.`);
					break;
				}
				case "auth": {
					const result = await manager.startAuthFlow(serverName);
					notify(ctx, result.message, result.status === "authorized" ? "info" : "warning");
					break;
				}
				case "clear-auth":
					await manager.clearAuth(serverName);
					notify(ctx, `Cleared stored MCP OAuth credentials for ${serverName}.`);
					break;
				case "tools":
					await runToolList(runtime, serverName, ctx);
					break;
				case "resources":
					await runResourceList(runtime, serverName, ctx);
					break;
				case "prompts":
					await runPromptList(runtime, serverName, ctx);
					break;
				case "disable":
					deactivateServerTools(pi, runtime, serverName);
					await manager.disableServer(serverName);
					notify(ctx, `Disabled MCP server ${serverName}.`);
					return;
				case "enable":
					await manager.enableServer(serverName);
					notify(ctx, `Enabled MCP server ${serverName}.`);
					return;
			}
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}
}

export async function runInteractiveMcpMenu(pi: ExtensionAPI, runtime: McpExtensionRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const manager = requireManager(runtime);
	for (;;) {
		const summaries = manager.getSummaries();
		if (summaries.length === 0) {
			notify(ctx, "No MCP servers configured.");
			return;
		}
		const selected = await selectFromMap<string | "close">(ctx, "MCP servers", [
			...summaries.map((summary) => ({ label: serverOption(summary), value: summary.name })),
			{ label: "Close", value: "close" },
		]);
		if (!selected || selected === "close") return;
		await runServerMenu(pi, runtime, selected, ctx);
	}
}
