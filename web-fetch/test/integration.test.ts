import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { WebFetchCache } from "../src/cache.js";
import { defaultWebFetchConfig } from "../src/config.js";
import webFetchExtension from "../src/index.js";
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

test("end-to-end HTML fetch converts before summarization", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(`<!doctype html><html><head><title>Install Docs</title><script>bad()</script><style>body{}</style></head><body><nav>Skip nav</nav><main><h1>Install</h1><p>Run <code>npm install pi-webfetch</code>.</p></main></body></html>`);
	});
	try {
		const config = { ...defaultWebFetchConfig(), allowPrivate: true, allowHttp: true };
		let prompt = "";
		const result = await executeWebFetch(
			{ url: server.url, prompt: "Return the install command." },
			{
				config,
				cache: new WebFetchCache(config.cacheTtlMs, config.cacheBytes),
				complete: async (_model, context) => {
					prompt = firstUserText(context);
					return assistant("Run `npm install pi-webfetch`.");
				},
			},
			ctx,
		);
		assert.match(prompt, /# Install/);
		assert.match(prompt, /`npm install pi-webfetch`/);
		assert.doesNotMatch(prompt, /bad\(\)|Skip nav|body\{\}/);
		assert.equal(result.details.title, "Install Docs");
		assert.equal(result.details.summarizerModel, "fake/fake-model");
	} finally {
		await server.close();
	}
});

test("extension smoke registers WebFetch and /webfetch command", () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const flags: string[] = [];
	const config = defaultWebFetchConfig();
	const tool = createWebFetchTool(() => ({ config, cache: new WebFetchCache(config.cacheTtlMs, config.cacheBytes) }));
	assert.equal(tool.name, "WebFetch");
	assert.deepEqual(Object.keys(tool.parameters.properties), ["url", "prompt"]);
	const pi = {
		registerFlag: (name: string) => flags.push(name),
		registerTool: (registeredTool: { name: string }) => tools.push(registeredTool.name),
		registerCommand: (name: string) => commands.push(name),
		on: () => undefined,
		getFlag: () => false,
	};
	webFetchExtension(pi as never);
	assert.deepEqual(tools, ["WebFetch"]);
	assert.deepEqual(commands, ["webfetch"]);
	assert.deepEqual(flags, ["webfetch-allow-private", "webfetch-allow-http"]);
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
