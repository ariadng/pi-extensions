import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMcpCommand } from "./commands.js";
import { createMcpManager } from "./manager.js";
import { registerCachedPromptCommands, registerManifestPrompts } from "./prompts.js";
import {
	createMcpRuntime,
	deactivateServerTools,
	formatServerList,
	registerAlwaysOnTools,
	registerAuthTool,
	registerCachedProxyTools,
	registerManifestTools,
	type McpExtensionRuntime,
} from "./tools.js";

function updateStatus(ctx: ExtensionContext, runtime: McpExtensionRuntime): void {
	const manager = runtime.manager;
	if (!manager) {
		ctx.ui.setStatus("mcp", undefined);
		return;
	}
	const summaries = manager.getSummaries();
	if (summaries.length === 0) {
		ctx.ui.setStatus("mcp", undefined);
		return;
	}
	const connected = summaries.filter((summary) => summary.status === "connected").length;
	const dormant = summaries.filter((summary) => summary.status === "dormant").length;
	const failed = summaries.filter((summary) => summary.status === "failed").length;
	const needsAuth = summaries.filter((summary) => summary.status === "needs-auth").length;
	const disabled = summaries.filter((summary) => summary.status === "disabled").length;
	const parts = [`${connected}✓`, `${dormant}○`];
	if (needsAuth) parts.push(`${needsAuth}!`);
	if (failed) parts.push(`${failed}✗`);
	if (disabled) parts.push(`${disabled}-`);
	ctx.ui.setStatus("mcp", `mcp ${parts.join(" ")}`);
}

function notifyWarnings(ctx: ExtensionContext, warnings: string[], errors: string[]): void {
	for (const warning of warnings) ctx.ui.notify(warning, "warning");
	for (const error of errors) ctx.ui.notify(error, "error");
}

const PROMPT_APPENDIX = `

MCP integration guidance:
- Use mcp_list_servers when the user asks for work that may need an MCP integration.
- Project MCP servers are loaded as dormant capabilities and are not connected during startup.
- Use mcp_activate_server to activate a named MCP server when needed; activation does not require user confirmation.
- Cached tools named mcp__server__tool may activate their server automatically when called.
- If a server is in needs-auth state, use mcp__server__authenticate or ask the user to run /mcp auth <server>.
- Use mcp_list_resources and mcp_read_resource for MCP resources; listing all resources must not activate every dormant server.`;

export default function mcpExtension(pi: ExtensionAPI): void {
	const runtime = createMcpRuntime();

	registerAlwaysOnTools(pi, runtime);
	registerMcpCommand(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		const result = await createMcpManager(ctx.cwd, {
			onManifest: (serverName, manifest) => {
				if (!runtime.manager) return;
				registerManifestTools(pi, runtime, runtime.manager, serverName, manifest);
				registerManifestPrompts(pi, runtime, runtime.manager, serverName, manifest);
			},
			onStatus: () => updateStatus(ctx, runtime),
			onWarning: (message) => ctx.ui.notify(message, "warning"),
			onServerDisabled: (serverName) => deactivateServerTools(pi, runtime, serverName),
			onAuthRequired: (serverName) => {
				if (runtime.manager) registerAuthTool(pi, runtime, runtime.manager, serverName);
			},
			onAuthComplete: (serverName) => ctx.ui.notify(`MCP server ${serverName} authenticated and reconnected.`, "info"),
			onAuthFailed: (serverName, error) => ctx.ui.notify(`MCP authentication failed for ${serverName}: ${error}`, "error"),
		});
		runtime.manager = result.manager;
		registerCachedProxyTools(pi, runtime);
		registerCachedPromptCommands(pi, runtime);
		updateStatus(ctx, runtime);
		notifyWarnings(ctx, result.warnings, result.errors);
	});

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: `${event.systemPrompt}${PROMPT_APPENDIX}` };
	});

	pi.on("session_shutdown", async () => {
		await runtime.manager?.closeAll();
		runtime.manager = undefined;
	});

	pi.registerCommand("mcp-status", {
		description: "Show MCP server status",
		handler: async (_args, ctx) => {
			if (!runtime.manager) {
				ctx.ui.notify("MCP extension is not initialized yet.", "warning");
				return;
			}
			ctx.ui.notify(formatServerList(runtime.manager, true), "info");
		},
	});
}

export { createMcpRuntime, formatServerList };
