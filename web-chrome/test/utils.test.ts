import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { looksLikeDefaultChromeProfile } from "../src/config.js";
import { applySnapshotRefs, formatSnapshot, type SnapshotData } from "../src/chrome/snapshot.js";
import { cleanupWebChromeStorage } from "../src/util/cleanup.js";
import { redactHeaders, redactUrl } from "../src/util/redact.js";
import { truncateText } from "../src/util/truncate.js";

function sampleSnapshot(): SnapshotData {
	return {
		title: "Checkout",
		url: "https://example.test/checkout",
		viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 100 },
		nodes: [
			{ role: "button", name: "Continue", selector: "#continue", box: { x: 10, y: 20, width: 100, height: 30 } },
			{ role: "textbox", name: "Email", selector: "#email", value: "" },
		],
		totalNodes: 2,
		truncated: false,
	};
}

test("redactHeaders redacts sensitive headers case-insensitively", () => {
	assert.deepEqual(redactHeaders({ Authorization: "Bearer secret", Cookie: "a=b", Accept: "text/html" }), {
		Authorization: "[REDACTED]",
		Cookie: "[REDACTED]",
		Accept: "text/html",
	});
	assert.equal(redactHeaders({ Authorization: "Bearer secret" }, true)?.Authorization, "Bearer secret");
});

test("redactUrl redacts token-like query parameters", () => {
	const redacted = redactUrl("https://example.test/path?token=abc123&safe=hello&x=abcdefghijklmnopqrstuvwxyz123456");
	assert.match(redacted, /token=%5BREDACTED%5D/);
	assert.match(redacted, /safe=hello/);
	assert.match(redacted, /x=%5BREDACTED%5D/);
	assert.equal(redactUrl("https://example.test/?token=abc", true), "https://example.test/?token=abc");
});

test("truncateText honors byte and line limits", () => {
	const result = truncateText("a\nb\nc\nd", { maxLines: 2, maxBytes: 10 });
	assert.equal(result.content, "a\nb");
	assert.equal(result.truncated, true);
	const bytes = truncateText("😀😀😀", { maxBytes: 5, maxLines: 10 });
	assert.equal(bytes.content, "😀");
	assert.equal(bytes.truncated, true);
});

test("snapshot refs and formatting are stable for a generated snapshot", () => {
	const refs: string[] = [];
	const withRefs = applySnapshotRefs(sampleSnapshot(), (node) => {
		const ref = `c${refs.length + 1}`;
		refs.push(`${ref}:${node.selector}`);
		return ref;
	});
	assert.deepEqual(refs, ["c1:#continue", "c2:#email"]);
	assert.equal(withRefs.nodes[0]?.ref, "c1");
	const formatted = formatSnapshot(withRefs);
	assert.match(formatted, /Page: "Checkout"/);
	assert.match(formatted, /button "Continue" \[ref=c1\]/);
	assert.match(formatted, /textbox "Email"/);
});

test("looksLikeDefaultChromeProfile detects common default profile roots", () => {
	assert.equal(looksLikeDefaultChromeProfile("/Users/me/Library/Application Support/Google/Chrome"), true);
	assert.equal(looksLikeDefaultChromeProfile("/home/me/.config/google-chrome"), true);
	assert.equal(looksLikeDefaultChromeProfile("/Users/me/.pi/agent/web-chrome/profiles/named-oauth"), false);
});

test("cleanupWebChromeStorage removes artifact override contents", async () => {
	const oldArtifactDir = process.env.PI_WEB_CHROME_ARTIFACT_DIR;
	const root = await mkdtemp(join(tmpdir(), "web-chrome-artifacts-"));
	process.env.PI_WEB_CHROME_ARTIFACT_DIR = root;
	try {
		await writeFile(join(root, "artifact.txt"), "secret", "utf8");
		const result = await cleanupWebChromeStorage({ scope: "artifacts" });
		assert.deepEqual(result.removed, [root]);
		await assert.rejects(() => readdir(root), /ENOENT/);
	} finally {
		if (oldArtifactDir === undefined) delete process.env.PI_WEB_CHROME_ARTIFACT_DIR;
		else process.env.PI_WEB_CHROME_ARTIFACT_DIR = oldArtifactDir;
	}
});
