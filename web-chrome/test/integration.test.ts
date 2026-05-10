import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverChromeExecutable } from "../src/chrome/executable.js";
import { BrowserManager } from "../src/chrome/browser-manager.js";

async function fixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.url === "/api") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: true, message: "hello" }));
			return;
		}

		res.setHeader("content-type", "text/html");
		res.end(`<!doctype html>
<title>web-chrome fixture</title>
<h1>Hello fixture</h1>
<label>Email <input id="email" placeholder="Email"></label>
<button id="increment" onclick="document.getElementById('count').textContent=String(Number(document.getElementById('count').textContent)+1); console.log('clicked'); fetch('/api').then(r=>r.json()).then(v=>console.log(v.message));">Increment</button>
<span id="count">0</span>
<div style="height:1400px">Long page</div>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP fixture server address");
	return {
		url: `http://127.0.0.1:${address.port}/`,
		close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

test("BrowserManager integration covers navigation, actions, console, network, screenshot, and evaluate", { timeout: 90_000 }, async (t) => {
	if (process.env.PI_WEB_CHROME_SKIP_INTEGRATION === "1") {
		t.skip("PI_WEB_CHROME_SKIP_INTEGRATION=1");
		return;
	}

	try {
		await discoverChromeExecutable();
	} catch (error) {
		t.skip(`Chrome executable not available: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	const oldArtifactDir = process.env.PI_WEB_CHROME_ARTIFACT_DIR;
	const artifactDir = await mkdtemp(join(tmpdir(), "web-chrome-integration-artifacts-"));
	process.env.PI_WEB_CHROME_ARTIFACT_DIR = artifactDir;
	const fixture = await fixtureServer();
	const manager = new BrowserManager();

	try {
		const launch = await manager.launch({ profileMode: "ephemeral", timeoutMs: 20_000 }, process.cwd());
		assert.equal(launch.connected, true);

		const nav = await manager.navigate({ url: fixture.url, waitUntil: "load", timeoutMs: 10_000 });
		assert.equal(nav.tab.url, fixture.url);

		const evaluated = await manager.evaluate({ expression: "({ title: document.title, buttons: document.querySelectorAll('button').length })" }, process.cwd());
		assert.match(evaluated.resultText, /web-chrome fixture/);

		const longEvaluation = await manager.evaluate({ expression: "'x'.repeat(60000)" }, process.cwd());
		assert.equal(longEvaluation.truncation.truncated, true);
		assert.ok(longEvaluation.artifactPath);
		assert.equal(existsSync(longEvaluation.artifactPath), true);

		const snapshot = await manager.snapshot({ maxNodes: 20 });
		assert.match(snapshot.snapshot, /Hello fixture/);
		const emailRef = snapshot.data.nodes.find((node) => node.role === "textbox")?.ref;
		const buttonRef = snapshot.data.nodes.find((node) => node.role === "button")?.ref;
		assert.ok(emailRef);
		assert.ok(buttonRef);

		await manager.typeText({ ref: emailRef, text: "person@example.test", clear: true });
		await manager.click({ ref: buttonRef });
		await manager.waitFor({ text: "1", timeoutMs: 5_000 });

		const consoleEntries = await manager.console({ all: true });
		assert.ok(consoleEntries.entries.some((entry) => entry.text.includes("clicked")));

		const network = await manager.network({ includeStatic: true, limit: 20 }, process.cwd());
		const apiRequest = network.requests.find((request) => request.url.endsWith("/api"));
		assert.ok(apiRequest);

		const body = await manager.network({ bodyRequestId: apiRequest.requestId, includeBody: true, includeStatic: true }, process.cwd());
		assert.match(body.body?.body ?? "", /hello/);

		const screenshot = await manager.screenshot({ fullPage: false }, process.cwd());
		assert.equal(existsSync(screenshot.path), true);
		assert.ok(screenshot.width > 0);
		assert.ok(screenshot.height > 0);
	} finally {
		await manager.close({ target: "browser" }).catch(() => undefined);
		await fixture.close().catch(() => undefined);
		await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
		if (oldArtifactDir === undefined) delete process.env.PI_WEB_CHROME_ARTIFACT_DIR;
		else process.env.PI_WEB_CHROME_ARTIFACT_DIR = oldArtifactDir;
	}
});
