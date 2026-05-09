import assert from "node:assert/strict";
import test from "node:test";
import { WebFetchCache } from "../src/cache.js";
import { defaultWebFetchConfig, type WebFetchConfig } from "../src/config.js";
import { RequestTimeoutError, ResponseTooLargeError, TooManyRedirectsError, WebFetchError } from "../src/errors.js";
import { fetchWebContent } from "../src/fetcher.js";
import { startWebFetchTestServer } from "../src/test-server.js";

function config(patch: Partial<WebFetchConfig> = {}): WebFetchConfig {
	return {
		...defaultWebFetchConfig(),
		allowPrivate: true,
		allowHttp: true,
		timeoutMs: 1_000,
		...patch,
	};
}

function cache(config: WebFetchConfig): WebFetchCache {
	return new WebFetchCache(config.cacheTtlMs, config.cacheBytes);
}

test("fetches bounded text and caches repeated requests", async () => {
	let hits = 0;
	const server = await startWebFetchTestServer((request, response) => {
		hits += 1;
		assert.equal(request.url, "/text");
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("hello from fixture");
	});
	try {
		const cfg = config();
		const store = cache(cfg);
		const first = await fetchWebContent(`${server.url}/text`, { config: cfg, cache: store });
		assert.equal(first.kind, "fetched");
		assert.equal(first.cached, false);
		assert.equal(first.markdown, "hello from fixture");
		const second = await fetchWebContent(`${server.url}/text`, { config: cfg, cache: store });
		assert.equal(second.kind, "fetched");
		assert.equal(second.cached, true);
		assert.equal(hits, 1);
	} finally {
		await server.close();
	}
});

test("enforces decoded byte cap", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.setHeader("content-type", "text/plain");
		response.end("123456789");
	});
	try {
		const cfg = config({ maxBytes: 5 });
		await assert.rejects(() => fetchWebContent(server.url, { config: cfg, cache: cache(cfg) }), ResponseTooLargeError);
	} finally {
		await server.close();
	}
});

test("follows same-host redirects", async () => {
	const server = await startWebFetchTestServer((request, response) => {
		if (request.url === "/a") {
			response.statusCode = 302;
			response.setHeader("location", "/b");
			response.end();
			return;
		}
		response.setHeader("content-type", "text/plain");
		response.end("redirect target");
	});
	try {
		const cfg = config();
		const result = await fetchWebContent(`${server.url}/a`, { config: cfg, cache: cache(cfg) });
		assert.equal(result.kind, "fetched");
		assert.equal(result.redirected, true);
		assert.equal(result.finalUrl, `${server.url}/b`);
		assert.equal(result.markdown, "redirect target");
	} finally {
		await server.close();
	}
});

test("returns cross-host redirects without fetching target", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.statusCode = 302;
		response.setHeader("location", "http://example.com/target");
		response.end();
	});
	try {
		const cfg = config();
		const result = await fetchWebContent(server.url, { config: cfg, cache: cache(cfg) });
		assert.equal(result.kind, "redirect");
		assert.equal(result.redirectUrl, "http://example.com/target");
		assert.equal(result.status, 302);
	} finally {
		await server.close();
	}
});

test("fails after redirect limit", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.statusCode = 302;
		response.setHeader("location", "/loop");
		response.end();
	});
	try {
		const cfg = config({ redirects: 1 });
		await assert.rejects(() => fetchWebContent(`${server.url}/loop`, { config: cfg, cache: cache(cfg) }), TooManyRedirectsError);
	} finally {
		await server.close();
	}
});

test("times out slow responses", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.setHeader("content-type", "text/plain");
		setTimeout(() => response.end("late"), 100);
	});
	try {
		const cfg = config({ timeoutMs: 20 });
		await assert.rejects(() => fetchWebContent(server.url, { config: cfg, cache: cache(cfg) }), RequestTimeoutError);
	} finally {
		await server.close();
	}
});

test("honors caller abort signal", async () => {
	const server = await startWebFetchTestServer((_request, response) => {
		response.setHeader("content-type", "text/plain");
		setTimeout(() => response.end("late"), 100);
	});
	try {
		const cfg = config({ timeoutMs: 1_000 });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(
			() => fetchWebContent(server.url, { config: cfg, cache: cache(cfg), signal: controller.signal }),
			(error: unknown) => error instanceof WebFetchError && error.code === "ABORTED",
		);
	} finally {
		await server.close();
	}
});
