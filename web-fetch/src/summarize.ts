import { complete, type Api, type AssistantMessage, type Context, type Model, type ProviderStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WebFetchConfig } from "./config.js";
import { SummarizerUnavailableError } from "./errors.js";

export type CompleteFn = (
	model: Model<Api>,
	context: Context,
	options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export type SummaryResult = {
	text: string;
	summarizerModel: string;
	inputTruncated: boolean;
	markdownChars: number;
};

export async function applyPromptToMarkdown(
	markdown: string,
	userPrompt: string,
	ctx: ExtensionContext,
	config: WebFetchConfig,
	signal?: AbortSignal,
	completeFn: CompleteFn = complete as CompleteFn,
): Promise<SummaryResult> {
	const model = resolveSummarizerModel(ctx);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new SummarizerUnavailableError(`WebFetch fetched content but could not apply the prompt: ${auth.error}`);
	if (!auth.apiKey) {
		throw new SummarizerUnavailableError(
			`WebFetch fetched content but could not apply the prompt because no API key/auth is available for ${formatModel(model)}.`,
		);
	}

	const limitedMarkdown = limitMarkdown(markdown, config.maxMarkdownChars);
	const modelPrompt = buildSummarizerPrompt(limitedMarkdown.content, userPrompt, limitedMarkdown.truncated);
	const response = await completeFn(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: modelPrompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: config.maxSummaryTokens,
			signal,
		},
	);

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new SummarizerUnavailableError(`WebFetch summarizer failed: ${response.errorMessage || response.stopReason}`);
	}

	const text = response.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();

	if (!text) throw new SummarizerUnavailableError("WebFetch summarizer returned an empty response.");

	return {
		text,
		summarizerModel: formatModel(model),
		inputTruncated: limitedMarkdown.truncated,
		markdownChars: limitedMarkdown.content.length,
	};
}

export function buildSummarizerPrompt(markdownContent: string, userPrompt: string, wasTruncated = false): string {
	const truncationNotice = wasTruncated
		? "\n\nNote: The fetched page content was truncated before this prompt due to WebFetch size limits."
		: "";
	return `Web page content:\n---\n${markdownContent}\n---${truncationNotice}\n\n${userPrompt}\n\nProvide a concise response based only on the content above. Include relevant details, commands, examples, and source-specific facts when useful. If the page content is insufficient, say so. Avoid long verbatim quotes; use short quotes only when necessary and do not reproduce song lyrics.`;
}

export function resolveSummarizerModel(ctx: ExtensionContext): Model<Api> {
	if (ctx.model) return ctx.model as Model<Api>;
	throw new SummarizerUnavailableError("WebFetch fetched content but could not apply the prompt because no current Pi model is available.");
}

function limitMarkdown(markdown: string, maxChars: number): { content: string; truncated: boolean } {
	if (markdown.length <= maxChars) return { content: markdown, truncated: false };
	return {
		content: `${markdown.slice(0, maxChars)}\n\n[WebFetch markdown truncated to ${maxChars} characters before summarization.]`,
		truncated: true,
	};
}

function formatModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}
