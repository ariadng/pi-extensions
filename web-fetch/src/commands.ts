import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchWebContent } from "./fetcher.js";
import type { WebFetchRuntime } from "./tool.js";
import { formatBytes } from "./utils.js";

export function registerWebFetchCommands(pi: ExtensionAPI, runtime: WebFetchRuntime): void {
	pi.registerCommand("webfetch", {
		description: "WebFetch status, clear-cache, config, or test <url>",
		handler: async (args, ctx) => {
			await handleWebFetchCommand(args, ctx, runtime);
		},
	});
}

export async function handleWebFetchCommand(args: string, ctx: Pick<ExtensionCommandContext, "ui">, runtime: WebFetchRuntime): Promise<void> {
	const [subcommand = "status", ...rest] = splitArgs(args);
	switch (subcommand) {
		case "status":
			ctx.ui.notify(formatWebFetchStatus(runtime), "info");
			return;
		case "clear-cache":
		case "clear":
			runtime.cache.clear();
			ctx.ui.notify("WebFetch cache cleared.", "info");
			return;
		case "config":
			ctx.ui.notify(formatWebFetchConfig(runtime), "info");
			return;
		case "test":
			await runWebFetchTest(rest.join(" "), ctx, runtime);
			return;
		case "help":
		case "--help":
		case "-h":
			ctx.ui.notify(formatWebFetchHelp(), "info");
			return;
		default:
			ctx.ui.notify(`Unknown /webfetch subcommand: ${subcommand}\n\n${formatWebFetchHelp()}`, "warning");
	}
}

export function formatWebFetchStatus(runtime: WebFetchRuntime): string {
	const stats = runtime.cache.stats();
	const config = runtime.config;
	return [
		"WebFetch status",
		`Cache: ${stats.entries} entries, ${formatBytes(stats.bytes)} / ${formatBytes(stats.maxBytes)}, TTL ${formatDuration(stats.ttlMs)}`,
		`Safety: private=${config.allowPrivate ? "allowed" : "blocked"}, http=${config.allowHttp ? "allowed" : "upgraded-to-https"}, offline=${config.ignoreOffline ? "ignored" : "respected"}`,
		`Limits: url=${config.maxUrlLength} chars, response=${formatBytes(config.maxBytes)}, redirects=${config.redirects}, timeout=${formatDuration(config.timeoutMs)}, markdown=${config.maxMarkdownChars.toLocaleString()} chars`,
		`Summarizer: current Pi model, rawFallback=${config.rawFallback ? "on" : "off"}`,
	].join("\n");
}

export function formatWebFetchConfig(runtime: WebFetchRuntime): string {
	return JSON.stringify(runtime.config, null, 2);
}

export function formatWebFetchHelp(): string {
	return [
		"Usage: /webfetch <subcommand>",
		"",
		"Subcommands:",
		"  status        Show cache and safety settings",
		"  clear-cache   Clear the in-memory fetched-content cache",
		"  config        Show effective WebFetch configuration",
		"  test <url>    Fetch and convert a URL without secondary-model summarization",
	].join("\n");
}

async function runWebFetchTest(url: string, ctx: Pick<ExtensionCommandContext, "ui">, runtime: WebFetchRuntime): Promise<void> {
	if (!url.trim()) {
		ctx.ui.notify("Usage: /webfetch test <url>", "warning");
		return;
	}
	try {
		const result = await fetchWebContent(url.trim(), { config: runtime.config, cache: runtime.cache });
		if (result.kind === "redirect") {
			ctx.ui.notify(`Redirect detected: ${result.status} ${result.statusText}\n${result.url} -> ${result.redirectUrl}`, "warning");
			return;
		}
		ctx.ui.notify(
			[
				"WebFetch test succeeded",
				`URL: ${result.finalUrl}`,
				`Status: ${result.status} ${result.statusText}`,
				`Type: ${result.contentType || "unknown"}`,
				`Bytes: ${formatBytes(result.bytes)} fetched, ${formatBytes(result.markdownBytes)} converted`,
				result.title ? `Title: ${result.title}` : undefined,
				result.persistedBinaryPath ? `Binary: ${result.persistedBinaryPath}` : undefined,
				`Cache: ${result.cached ? "hit" : "miss"}`,
			].filter((line): line is string => Boolean(line)).join("\n"),
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`WebFetch test failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/u).filter(Boolean);
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = seconds / 60;
	return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
}
