import assert from "node:assert/strict";
import test from "node:test";
import { validateAndNormalizeParams } from "../src/schema.ts";

test("normalizes missing and long headers", () => {
	const result = validateAndNormalizeParams({
		questions: [
			{
				question: "Which database backend should we use?",
				header: "This header is too long",
				options: [
					{ label: "SQLite", description: "Simple local database" },
					{ label: "Postgres", description: "Production database" },
				],
			},
			{
				question: "Should we add tests?",
				options: [
					{ label: "Yes", description: "Add tests now" },
					{ label: "No", description: "Skip tests" },
				],
			},
		],
	});

	assert.deepEqual(result.errors, []);
	assert.ok((result.params?.questions[0].header.length ?? 99) <= 12);
	assert.equal(result.params?.questions[0].originalHeader, "This header is too long");
	assert.ok(result.params?.questions[1].header);
	assert.ok(result.warnings.some((warning) => warning.includes("omitted header")));
});

test("rejects duplicate question text and explicit Other labels", () => {
	const result = validateAndNormalizeParams({
		questions: [
			{
				question: "Choose one?",
				header: "Choose",
				options: [
					{ label: "A", description: "A" },
					{ label: "Other", description: "Custom" },
				],
			},
			{
				question: "Choose one?",
				header: "Again",
				options: [
					{ label: "B", description: "B" },
					{ label: "C", description: "C" },
				],
			},
		],
	});

	assert.ok(result.errors.some((error) => error.includes("Duplicate question text")));
	assert.ok(result.errors.some((error) => error.includes("explicit")));
});
