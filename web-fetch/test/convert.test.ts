import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { convertResponseBody } from "../src/convert.js";

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

test("converts HTML to readable markdown and strips noisy content", async () => {
	const html = `<!doctype html>
		<html><head><title>Fixture Page</title><style>.hidden{}</style><script>alert('x')</script></head>
		<body>
			<header>Site header</header>
			<nav>Navigation</nav>
			<main>
				<h1>Install Tool</h1>
				<p>Run <code>npm install fixture</code> from the <a href="/docs">docs</a>.</p>
				<ul><li>First</li><li hidden>Hidden item</li><li>Second</li></ul>
				<p style="display:none">Invisible</p>
			</main>
		</body></html>`;
	const converted = await convertResponseBody({ bytes: bytes(html), contentType: "text/html; charset=utf-8", finalUrl: "https://example.com/docs" });
	assert.equal(converted.contentKind, "text");
	assert.equal(converted.title, "Fixture Page");
	assert.match(converted.markdown, /# Install Tool/);
	assert.match(converted.markdown, /`npm install fixture`/);
	assert.match(converted.markdown, /\[docs\]\(\/docs\)/);
	assert.doesNotMatch(converted.markdown, /alert|Navigation|Site header|Invisible|Hidden item/);
});

test("pretty-prints JSON responses", async () => {
	const converted = await convertResponseBody({ bytes: bytes('{"name":"pi","items":[1,2]}'), contentType: "application/json", finalUrl: "https://example.com/data.json" });
	assert.match(converted.markdown, /"name": "pi"/);
	assert.match(converted.markdown, /\n  "items": \[/);
});

test("preserves plain text responses", async () => {
	const converted = await convertResponseBody({ bytes: bytes("hello\nworld"), contentType: "text/plain", finalUrl: "https://example.com/plain.txt" });
	assert.equal(converted.markdown, "hello\nworld");
});

test("persists binary content and returns a metadata note", async () => {
	const content = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]);
	const converted = await convertResponseBody({ bytes: content, contentType: "application/pdf", finalUrl: "https://example.com/file.pdf" });
	assert.equal(converted.contentKind, "binary");
	assert.ok(converted.persistedBinaryPath);
	await access(converted.persistedBinaryPath!);
	const saved = await readFile(converted.persistedBinaryPath!);
	assert.deepEqual([...saved], [...content]);
	assert.match(converted.markdown, /Fetched binary content \(application\/pdf/);
	assert.match(converted.markdown, /Saved to/);
});
