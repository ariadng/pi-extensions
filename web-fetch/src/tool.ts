import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { WebFetchCache } from "./cache.js";
import type { WebFetchConfig } from "./config.js";
import { OfflineModeError } from "./errors.js";
import { fetchWebContent, type FetchWebContentResult, type FetchedResult, type RedirectResult } from "./fetcher.js";
import {
	DEFAULT_OUTPUT_MAX_BYTES,
	DEFAULT_OUTPUT_MAX_LINES,
	formatTruncationNotice,
	truncateHead,
	writeTempTextFile,
} from "./output.js";
import { WEB_FETCH_DESCRIPTION, WEB_FETCH_PROMPT_GUIDELINES, WEB_FETCH_PROMPT_SNIPPET } from "./prompt.js";
import { renderWebFetchCall, renderWebFetchResult } from "./render.js";
import { WebFetchParams, type WebFetchDetails, type WebFetchInput } from "./schema.js";
import { applyPromptToMarkdown, type CompleteFn, type SummaryResult } from "./summarize.js";
import { formatBytes, normalizeHostnameForPolicy } from "./utils.js";

export type WebFetchRuntime = {
	config: WebFetchConfig;
	cache: WebFetchCache;
	complete?: CompleteFn;
};

export function createWebFetchTool(getRuntime: () => WebFetchRuntime) {
	return defineTool<typeof WebFetchParams, WebFetchDetails>({
		name: "WebFetch",
		label: "WebFetch",
		description: WEB_FETCH_DESCRIPTION,
		promptSnippet: WEB_FETCH_PROMPT_SNIPPET,
		promptGuidelines: WEB_FETCH_PROMPT_GUIDELINES,
		parameters: WebFetchParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeWebFetch(params as WebFetchInput, getRuntime(), ctx, signal, onUpdate);
		},
		renderCall(args, theme) {
			return renderWebFetchCall(args as Partial<WebFetchInput>, theme);
		},
		renderResult(result, options, theme) {
			return renderWebFetchResult(result, options, theme);
		},
	});
}

export async function executeWebFetch(
	params: WebFetchInput,
	runtime: WebFetchRuntime,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<WebFetchDetails>,
): Promise<AgentToolResult<WebFetchDetails>> {
	if (process.env.PI_OFFLINE === "1" && !runtime.config.ignoreOffline) throw new OfflineModeError();

	onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }], details: progressDetails(params.url) });
	const result = await fetchWebContent(params.url, { config: runtime.config, cache: runtime.cache, signal });

	if (result.kind === "redirect") return formatRedirectResult(result);
	if (result.contentKind === "binary") return formatBinaryResult(result);

	onUpdate?.({ content: [{ type: "text", text: `Applying prompt to fetched content from ${result.finalUrl}...` }], details: detailsFromResult(result) });
	try {
		const summary = await applyPromptToMarkdown(result.markdown, params.prompt, ctx, runtime.config, signal, runtime.complete);
		return formatSummaryResult(result, summary);
	} catch (error) {
		if (runtime.config.rawFallback) return formatRawFallbackResult(params, result, error);
		throw error;
	}
}

function progressDetails(url: string): WebFetchDetails {
	return {
		url,
		finalUrl: "",
		status: 0,
		statusText: "",
		contentType: "",
		bytes: 0,
		markdownBytes: 0,
		durationMs: 0,
		cached: false,
		redirected: false,
	};
}

function formatRedirectResult(result: RedirectResult): AgentToolResult<WebFetchDetails> {
	const text = [
		"REDIRECT DETECTED: The URL redirects to a different host, protocol, or port.",
		`Original URL: ${result.url}`,
		`Redirect URL: ${result.redirectUrl}`,
		`Status: ${result.status} ${result.statusText}`,
		"",
		"To complete the request, call WebFetch again with the redirected URL.",
	].join("\n");
	return {
		content: [{ type: "text", text }],
		details: detailsFromResult(result),
	};
}

async function formatSummaryResult(result: FetchedResult, summary: SummaryResult): Promise<AgentToolResult<WebFetchDetails>> {
	const fullText = [
		summary.text,
		summary.inputTruncated ? `Note: fetched markdown was truncated to ${summary.markdownChars.toLocaleString()} characters before summarization.` : undefined,
		formatMetadata(result, summary.summarizerModel),
	].filter((line): line is string => Boolean(line)).join("\n\n");

	const { text, truncated, fullContentPath } = await truncateToolOutput(fullText, result.finalUrl);
	return {
		content: [{ type: "text", text }],
		details: {
			...detailsFromResult(result),
			summarizerModel: summary.summarizerModel,
			summarizerInputTruncated: summary.inputTruncated || undefined,
			truncated: truncated || undefined,
			fullContentPath,
		},
	};
}

async function formatBinaryResult(result: FetchedResult): Promise<AgentToolResult<WebFetchDetails>> {
	const fullText = [result.markdown, formatMetadata(result)].join("\n\n");
	const { text, truncated, fullContentPath } = await truncateToolOutput(fullText, result.finalUrl);
	return {
		content: [{ type: "text", text }],
		details: { ...detailsFromResult(result), truncated: truncated || undefined, fullContentPath },
	};
}

async function formatRawFallbackResult(
	params: WebFetchInput,
	result: FetchedResult,
	error: unknown,
): Promise<AgentToolResult<WebFetchDetails>> {
	const message = error instanceof Error ? error.message : String(error);
	const fullText = [
		`WebFetch fetched the content but could not apply the prompt with a secondary model: ${message}`,
		"PI_WEBFETCH_RAW_FALLBACK=1 is enabled, so truncated fetched markdown is returned instead.",
		"",
		`Prompt to answer from this fetched content: ${params.prompt}`,
		"---",
		result.markdown,
		"---",
		formatMetadata(result),
	].join("\n");

	const { text, truncated, fullContentPath } = await truncateToolOutput(fullText, result.finalUrl);
	return {
		content: [{ type: "text", text }],
		details: { ...detailsFromResult(result), truncated: truncated || undefined, fullContentPath },
	};
}

async function truncateToolOutput(fullText: string, finalUrl: string): Promise<{ text: string; truncated: boolean; fullContentPath?: string }> {
	const truncation = truncateHead(fullText, { maxBytes: DEFAULT_OUTPUT_MAX_BYTES, maxLines: DEFAULT_OUTPUT_MAX_LINES });
	if (!truncation.truncated) return { text: truncation.content, truncated: false };
	const host = normalizeHostnameForPolicy(new URL(finalUrl).hostname) || "webfetch";
	const fullContentPath = await writeTempTextFile("pi-webfetch-", `${host}-content.txt`, fullText);
	return { text: `${truncation.content}\n\n${formatTruncationNotice(truncation, fullContentPath)}`, truncated: true, fullContentPath };
}

function detailsFromResult(result: FetchWebContentResult): WebFetchDetails {
	return {
		url: result.url,
		finalUrl: result.finalUrl,
		status: result.status,
		statusText: result.statusText,
		contentType: result.contentType,
		bytes: result.bytes,
		markdownBytes: result.markdownBytes,
		title: result.title,
		durationMs: result.durationMs,
		cached: result.cached,
		redirected: result.redirected,
		redirectUrl: result.kind === "redirect" ? result.redirectUrl : undefined,
		persistedBinaryPath: result.kind === "fetched" ? result.persistedBinaryPath : undefined,
		cacheKey: result.cacheKey,
		contentKind: result.contentKind,
	};
}

function formatMetadata(result: FetchedResult, summarizerModel?: string): string {
	const parts = [
		`Metadata: fetched ${result.finalUrl}`,
		`(${result.status} ${result.statusText || ""}, ${result.contentType || "unknown content type"}, ${formatBytes(result.bytes)}, ${result.durationMs}ms${result.cached ? ", cached" : ""})`,
	];
	if (result.title) parts.push(`title=${JSON.stringify(result.title)}`);
	if (summarizerModel) parts.push(`summarizer=${summarizerModel}`);
	return parts.join(" ");
}
