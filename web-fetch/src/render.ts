import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { WebFetchDetails, WebFetchInput } from "./schema.js";
import { formatBytes, normalizeHostnameForPolicy } from "./utils.js";

export function renderWebFetchCall(args: Partial<WebFetchInput> | undefined, theme: any): Text {
	if (!args?.url || typeof args.url !== "string") return new Text(theme.fg("toolTitle", theme.bold("WebFetch")), 0, 0);
	let host = "";
	let path = "";
	try {
		const url = new URL(args.url);
		host = normalizeHostnameForPolicy(url.hostname) || url.hostname;
		path = `${url.pathname}${url.search}`;
	} catch {
		return new Text(theme.fg("toolTitle", theme.bold("WebFetch ")) + theme.fg("muted", args.url), 0, 0);
	}
	const truncatedPath = path.length > 72 ? `${path.slice(0, 69)}...` : path;
	let text = theme.fg("toolTitle", theme.bold("WebFetch ")) + theme.fg("accent", host);
	if (truncatedPath && truncatedPath !== "/") text += theme.fg("dim", ` ${truncatedPath}`);
	return new Text(text, 0, 0);
}

export function renderWebFetchResult(
	result: AgentToolResult<WebFetchDetails>,
	options: ToolRenderResultOptions,
	theme: any,
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
	const details = result.details;
	if (!details) return new Text(theme.fg("dim", contentText(result).slice(0, 160)), 0, 0);

	let text: string;
	if (details.redirectUrl) {
		text = theme.fg("warning", `Redirect to ${hostFromUrl(details.redirectUrl)}`);
	} else if (details.contentKind === "binary" || details.persistedBinaryPath) {
		text = theme.fg("success", `Saved binary · ${details.contentType || "application/octet-stream"} · ${formatBytes(details.bytes)}`);
	} else {
		const statusText = `${details.status || ""}${details.statusText ? ` ${details.statusText}` : ""}`.trim() || "Fetched";
		text = theme.fg("success", `${statusText} · ${formatBytes(details.bytes)} · ${formatDuration(details.durationMs)}`);
	}

	if (details.cached) text += theme.fg("muted", " (cached)");
	if (details.truncated) text += theme.fg("warning", " (truncated)");
	if (details.summarizerModel) text += theme.fg("dim", ` · ${details.summarizerModel}`);

	if (options.expanded) {
		const lines = contentText(result).split("\n").slice(0, 24);
		if (details.title) text += `\n${theme.fg("muted", `Title: ${details.title}`)}`;
		text += `\n${theme.fg("dim", `URL: ${details.finalUrl || details.url}`)}`;
		if (details.fullContentPath) text += `\n${theme.fg("dim", `Full output: ${details.fullContentPath}`)}`;
		if (details.persistedBinaryPath) text += `\n${theme.fg("dim", `Binary: ${details.persistedBinaryPath}`)}`;
		if (lines.length > 0) text += `\n${lines.map((line) => theme.fg("dim", line)).join("\n")}`;
	}

	return new Text(text, 0, 0);
}

function contentText(result: AgentToolResult<WebFetchDetails>): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function hostFromUrl(url: string): string {
	try {
		return normalizeHostnameForPolicy(new URL(url).hostname) || url;
	} catch {
		return url;
	}
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
