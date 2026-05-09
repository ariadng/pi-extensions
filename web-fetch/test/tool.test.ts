import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { access } from "node:fs/promises";
import { WebFetchCache } from "../src/cache.js";
import { defaultWebFetchConfig } from "../src/config.js";
import { createWebFetchTool, executeWebFetch } from "../src/tool.js";
import { startWebFetchTestServer } from "../src/test-server.js";

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

const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	model,
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
} as any;

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

test("createWebFetchTool registers Claude-compatible tool metadata", () => {
	const config = defaultWebFetchConfig();
	const tool = createWebFetchTool(() => ({ config, cache: new WebFetchCache(config.cacheTtlMs, config.cacheBytes) }));
	assert.equal(tool.name, "WebFetch");
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["url", "prompt"]);
});

test("executeWebFetch summarizes fetched content and metadata", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.setHeader("content-type", "text/plain");
		response.end("tool fixture body");
	});
	try {
		const config = { ...defaultWebFetchConfig(), allowPrivate: true, allowHttp: true };
		const result = await executeWebFetch(
			{ url: server.url, prompt: "What does the page say?" },
			{
				config,
				cache: new WebFetchCache(config.cacheTtlMs, config.cacheBytes),
				complete: async () => assistant("The page says: tool fixture body."),
			},
			ctx,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /The page says: tool fixture body/);
		assert.match(text, /Metadata: fetched/);
		assert.equal(result.details.status, 200);
		assert.equal(result.details.cached, false);
		assert.equal(result.details.summarizerModel, "fake/fake-model");
	} finally {
		await server.close();
	}
});

test("executeWebFetch can raw-fallback when summarizer auth is missing", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.setHeader("content-type", "text/plain");
		response.end("fallback body");
	});
	try {
		const config = { ...defaultWebFetchConfig(), allowPrivate: true, allowHttp: true, rawFallback: true };
		const result = await executeWebFetch(
			{ url: server.url, prompt: "What does the page say?" },
			{ config, cache: new WebFetchCache(config.cacheTtlMs, config.cacheBytes) },
			{ ...ctx, model: undefined },
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /could not apply the prompt/);
		assert.match(text, /fallback body/);
	} finally {
		await server.close();
	}
});

test("executeWebFetch returns binary path without summarization", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.setHeader("content-type", "application/pdf");
		response.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]));
	});
	try {
		const config = { ...defaultWebFetchConfig(), allowPrivate: true, allowHttp: true };
		const result = await executeWebFetch(
			{ url: server.url, prompt: "Summarize" },
			{ config, cache: new WebFetchCache(config.cacheTtlMs, config.cacheBytes) },
			ctx,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /Fetched binary content/);
		assert.ok(result.details.persistedBinaryPath);
		await access(result.details.persistedBinaryPath!);
		assert.equal(result.details.contentKind, "binary");
	} finally {
		await server.close();
	}
});
