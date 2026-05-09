import assert from "node:assert/strict";
import test from "node:test";
import { WebFetchCache } from "../src/cache.js";
import { formatWebFetchConfig, formatWebFetchStatus, handleWebFetchCommand } from "../src/commands.js";
import { defaultWebFetchConfig } from "../src/config.js";
import { startWebFetchTestServer } from "../src/test-server.js";
import type { WebFetchRuntime } from "../src/tool.js";

function runtime() {
	const config = { ...defaultWebFetchConfig(), allowPrivate: true, allowHttp: true };
	return { config, cache: new WebFetchCache(config.cacheTtlMs, config.cacheBytes) } satisfies WebFetchRuntime;
}

test("formats status and config", () => {
	const rt = runtime();
	assert.match(formatWebFetchStatus(rt), /WebFetch status/);
	assert.match(formatWebFetchStatus(rt), /private=allowed/);
	assert.match(formatWebFetchConfig(rt), /"allowPrivate": true/);
});

test("handles status and clear-cache commands", async () => {
	const rt = runtime();
	rt.cache.set("https://example.com", {
		url: "https://example.com",
		finalUrl: "https://example.com",
		status: 200,
		statusText: "OK",
		contentType: "text/plain",
		bytes: 2,
		markdown: "ok",
		markdownBytes: 2,
		fetchedAt: Date.now(),
		redirected: false,
		contentKind: "text",
	});
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = { ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } } as never;
	await handleWebFetchCommand("status", ctx, rt);
	await handleWebFetchCommand("clear-cache", ctx, rt);
	assert.match(notifications[0].message, /Cache: 1 entries/);
	assert.match(notifications[1].message, /cache cleared/i);
	assert.equal(rt.cache.stats().entries, 0);
});

test("/webfetch test fetches and converts without summarization", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.setHeader("content-type", "text/html");
		response.end("<html><head><title>Command Fixture</title></head><body><h1>Hello</h1></body></html>");
	});
	try {
		const rt = runtime();
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = { ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } } as never;
		await handleWebFetchCommand(`test ${server.url}`, ctx, rt);
		assert.equal(notifications[0].level, "info");
		assert.match(notifications[0].message, /WebFetch test succeeded/);
		assert.match(notifications[0].message, /Title: Command Fixture/);
	} finally {
		await server.close();
	}
});
