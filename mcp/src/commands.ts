import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { runInteractiveMcpMenu } from "./interactive.js";
import { registerCachedPromptCommands } from "./prompts.js";
import { deactivateServerTools, formatServerList, getResourcesForListing, registerCachedProxyTools, type McpExtensionRuntime } from "./tools.js";

const SUBCOMMANDS = ["list", "status", "activate", "auth", "clear-auth", "reconnect", "reload", "resources", "enable", "disable"];

function requireManager(runtime: McpExtensionRuntime) {
	if (!runtime.manager) throw new Error("MCP extension is not initialized yet");
	return runtime.manager;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, type);
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function completions(runtime: McpExtensionRuntime, prefix: string): AutocompleteItem[] | null {
	const parts = splitArgs(prefix);
	if (prefix.endsWith(" ")) parts.push("");
	if (parts.length <= 1) {
		const needle = parts[0] ?? "";
		return SUBCOMMANDS.filter((value) => value.startsWith(needle)).map((value) => ({ value, label: value }));
	}
	if (["activate", "auth", "clear-auth", "reconnect", "enable", "disable", "resources"].includes(parts[0])) {
		const manager = runtime.manager;
		if (!manager) return null;
		const subcommand = parts[0];
		const needle = parts[1] ?? "";
		const names = manager.getServerNames();
		const options = subcommand === "reconnect" || subcommand === "enable" || subcommand === "disable" || subcommand === "clear-auth" ? ["all", ...names] : names;
		return options
			.filter((value) => value.startsWith(needle))
			.map((value) => ({ value: `${subcommand} ${value}`, label: value }));
	}
	return null;
}

function formatResources(runtime: McpExtensionRuntime, server?: string): string {
	const resources = getResourcesForListing(requireManager(runtime), server);
	if (resources.length === 0) return server ? `No cached or connected MCP resources for ${server}.` : "No cached or connected MCP resources.";
	return [
		"MCP resources",
		...resources.map((resource) => {
			const label = resource.title ?? resource.name;
			const mime = resource.mimeType ? ` · ${resource.mimeType}` : "";
			return `- ${resource.serverName}: ${label} <${resource.uri}>${mime}`;
		}),
	].join("\n");
}

export function registerMcpCommand(pi: ExtensionAPI, runtime: McpExtensionRuntime): void {
	pi.registerCommand("mcp", {
		description: "Open the interactive MCP manager, or use /mcp list|status|activate|auth|clear-auth|reconnect|reload|resources|enable|disable",
		getArgumentCompletions: (prefix) => completions(runtime, prefix),
		handler: async (args, ctx) => {
			const parts = splitArgs(args);
			try {
				if (parts.length === 0) {
					await runInteractiveMcpMenu(pi, runtime, ctx);
					return;
				}
				const [subcommand, target] = parts;
				const manager = requireManager(runtime);
				switch (subcommand) {
					case "list":
					case "status":
					case "": {
						notify(ctx, formatServerList(manager, subcommand === "status"));
						return;
					}
					case "activate": {
						if (!target) {
							notify(ctx, "Usage: /mcp activate <server>", "warning");
							return;
						}
						const connected = await manager.activateServer(target, { refresh: false });
						notify(ctx, `Activated ${target}: ${connected.manifest.tools.length} tools, ${connected.manifest.resources.length} resources, ${connected.manifest.prompts.length} prompts.`);
						return;
					}
					case "auth": {
						if (!target) {
							notify(ctx, "Usage: /mcp auth <server>", "warning");
							return;
						}
						const result = await manager.startAuthFlow(target);
						notify(ctx, result.message, result.status === "authorized" ? "info" : "warning");
						return;
					}
					case "clear-auth": {
						if (!target) {
							notify(ctx, "Usage: /mcp clear-auth <server|all>", "warning");
							return;
						}
						if (target === "all") {
							await manager.clearAllAuth();
							notify(ctx, "Cleared stored MCP OAuth credentials for all configured servers.");
							return;
						}
						await manager.clearAuth(target);
						notify(ctx, `Cleared stored MCP OAuth credentials for ${target}.`);
						return;
					}
					case "reconnect": {
						if (!target) {
							notify(ctx, "Usage: /mcp reconnect <server|all>", "warning");
							return;
						}
						const names = target === "all" ? manager.getServerNames() : [target];
						const lines: string[] = [];
						for (const name of names) {
							try {
								const connected = await manager.reconnectServer(name);
								lines.push(`✓ ${name}: ${connected.manifest.tools.length} tools`);
							} catch (error) {
								lines.push(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
							}
						}
						notify(ctx, lines.join("\n"), lines.some((line) => line.startsWith("✗")) ? "warning" : "info");
						return;
					}
					case "reload": {
						const result = await manager.reload();
						registerCachedProxyTools(pi, runtime);
						registerCachedPromptCommands(pi, runtime);
						const lines = ["Reloaded MCP configuration."];
						if (result.warnings.length > 0) lines.push("Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
						if (result.errors.length > 0) lines.push("Errors:", ...result.errors.map((error) => `- ${error}`));
						notify(ctx, lines.join("\n"), result.errors.length > 0 ? "warning" : "info");
						return;
					}
					case "resources": {
						notify(ctx, formatResources(runtime, target));
						return;
					}
					case "disable": {
						if (!target) {
							notify(ctx, "Usage: /mcp disable <server|all>", "warning");
							return;
						}
						if (target === "all") {
							for (const name of manager.getServerNames()) deactivateServerTools(pi, runtime, name);
							await manager.setAllDisabled(true);
							notify(ctx, "Disabled all configured MCP servers.");
							return;
						}
						deactivateServerTools(pi, runtime, target);
						await manager.disableServer(target);
						notify(ctx, `Disabled MCP server ${target}.`);
						return;
					}
					case "enable": {
						if (!target) {
							notify(ctx, "Usage: /mcp enable <server|all>", "warning");
							return;
						}
						if (target === "all") {
							await manager.setAllDisabled(false);
							notify(ctx, "Enabled all configured MCP servers.");
							return;
						}
						await manager.enableServer(target);
						notify(ctx, `Enabled MCP server ${target}.`);
						return;
					}
					default:
						notify(ctx, `Unknown /mcp subcommand: ${subcommand}\nUsage: /mcp list|status|activate|auth|clear-auth|reconnect|reload|resources|enable|disable`, "warning");
				}
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
