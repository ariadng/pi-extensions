import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { defaultWebFetchConfig } from "../src/config.js";
import { SummarizerUnavailableError } from "../src/errors.js";
import { applyPromptToMarkdown, buildSummarizerPrompt } from "../src/summarize.js";

const model = {
	id: "fake-model",
	name: "Fake Model",
	api: "openai-completions",
	provider: "fake",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
} as never;

function ctx(patch: Record<string, unknown> = {}) {
	return {
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "1" } }),
		},
		...patch,
	} as never;
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

test("builds conservative prompt with fetched content and user prompt", () => {
	const prompt = buildSummarizerPrompt("# Docs\nInstall with npm.", "List commands.");
	assert.match(prompt, /Web page content:/);
	assert.match(prompt, /# Docs/);
	assert.match(prompt, /List commands\./);
	assert.match(prompt, /based only on the content above/);
	assert.match(prompt, /Avoid long verbatim quotes/);
});

test("applies prompt with current Pi model auth and passes signal", async () => {
	let sawPrompt = "";
	let sawMaxTokens = 0;
	const controller = new AbortController();
	const result = await applyPromptToMarkdown(
		"# Install\nRun `npm install fixture`.",
		"What command is shown?",
		ctx(),
		defaultWebFetchConfig(),
		controller.signal,
		async (_model, context, options) => {
			sawPrompt = firstUserText(context);
			sawMaxTokens = options?.maxTokens as number;
			assert.equal(options?.apiKey, "test-key");
			assert.equal(options?.signal, controller.signal);
			return assistant("Use `npm install fixture`.");
		},
	);
	assert.equal(result.text, "Use `npm install fixture`.");
	assert.equal(result.summarizerModel, "fake/fake-model");
	assert.equal(result.inputTruncated, false);
	assert.match(sawPrompt, /What command is shown\?/);
	assert.equal(sawMaxTokens, 4096);
});

test("truncates markdown before model call", async () => {
	let sawPrompt = "";
	const config = { ...defaultWebFetchConfig(), maxMarkdownChars: 10 };
	const result = await applyPromptToMarkdown(
		"x".repeat(50),
		"Summarize",
		ctx(),
		config,
		undefined,
		async (_model, context) => {
			sawPrompt = firstUserText(context);
			return assistant("short");
		},
	);
	assert.equal(result.inputTruncated, true);
	assert.match(sawPrompt, /truncated to 10 characters/);
});

test("throws clear error when no summarizer auth is available", async () => {
	await assert.rejects(
		() => applyPromptToMarkdown("content", "prompt", ctx({ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) } }), defaultWebFetchConfig()),
		SummarizerUnavailableError,
	);
});

test("throws clear error when no current Pi model is available", async () => {
	await assert.rejects(
		() => applyPromptToMarkdown("content", "prompt", ctx({ model: undefined }), defaultWebFetchConfig()),
		(error: unknown) => error instanceof SummarizerUnavailableError && /current Pi model/.test(error.message),
	);
});

function firstUserText(context: { messages: Array<{ content: unknown }> }): string {
	const content = context.messages[0]?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const first = content[0];
	return first && typeof first === "object" && "type" in first && first.type === "text" && "text" in first && typeof first.text === "string"
		? first.text
		: "";
}
