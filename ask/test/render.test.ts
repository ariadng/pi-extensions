import assert from "node:assert/strict";
import test from "node:test";
import { renderAskResult } from "../src/render.ts";

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
};

test("renders stored answered details after resume", () => {
	const component = renderAskResult(
		{
			content: [{ type: "text", text: "stored result" }],
			details: {
				status: "answered",
				questions: [
					{
						question: "Which auth should we use?",
						header: "Auth",
						multiSelect: false,
						options: [
							{ label: "OAuth", description: "Use OAuth", preview: "OAuth preview" },
							{ label: "Password", description: "Use passwords" },
						],
					},
				],
				answers: { "Which auth should we use?": "OAuth" },
				annotations: { "Which auth should we use?": { preview: "OAuth preview", notes: "Prefer SSO" } },
			},
		},
		{ expanded: true, isPartial: false },
		fakeTheme as any,
	);

	const output = component.render(120).join("\n");
	assert.match(output, /Auth/);
	assert.match(output, /OAuth/);
	assert.match(output, /Prefer SSO/);
});
