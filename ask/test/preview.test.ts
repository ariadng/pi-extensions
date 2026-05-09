import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHtmlPreview } from "../src/preview.ts";
import { validateAndNormalizeParams } from "../src/schema.ts";

test("sanitizes safe HTML preview fragments", () => {
	const result = sanitizeHtmlPreview("<div><h3>Hello</h3><p>A &amp; B</p></div>", "preview");
	assert.equal(result.error, undefined);
	assert.match(result.preview ?? "", /Hello/);
	assert.match(result.preview ?? "", /A & B/);
	assert.doesNotMatch(result.preview ?? "", /<div>/);
});

test("rejects unsafe HTML preview fragments", () => {
	assert.match(sanitizeHtmlPreview("<script>alert(1)</script>", "preview").error ?? "", /script/i);
	assert.match(sanitizeHtmlPreview("<!DOCTYPE html><p>x</p>", "preview").error ?? "", /DOCTYPE/i);
	assert.match(sanitizeHtmlPreview("plain text", "preview").error ?? "", /tag/i);
});

test("validation applies html preview sanitization", () => {
	const result = validateAndNormalizeParams(
		{
			questions: [
				{
					question: "Which layout?",
					header: "Layout",
					options: [
						{ label: "Compact", description: "Compact", preview: "<p>Compact &amp; fast</p>" },
						{ label: "Roomy", description: "Roomy", preview: "<p>Roomy</p>" },
					],
				},
			],
		},
		{ previewMode: "html" },
	);
	assert.deepEqual(result.errors, []);
	assert.equal(result.params?.questions[0].options[0].preview, "Compact & fast");
});
