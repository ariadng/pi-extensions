import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { applyPreferredAnswers, AskPreferencesStore } from "../src/preferences.ts";
import type { AskUserQuestionDetails, NormalizedAskUserQuestionParams } from "../src/types.ts";

test("stores and reapplies preferred answers", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ask-pref-"));
	const store = new AskPreferencesStore(join(dir, "preferences.json"));
	const params: NormalizedAskUserQuestionParams = {
		questions: [
			{
				question: "Which auth?",
				header: "Auth",
				multiSelect: false,
				options: [
					{ label: "OAuth", description: "OAuth" },
					{ label: "Password", description: "Password" },
				],
			},
		],
	};
	const details: AskUserQuestionDetails = {
		status: "answered",
		questions: params.questions,
		answers: { "Which auth?": "OAuth" },
	};

	store.record(details);
	const withPrefs = applyPreferredAnswers(params, store);
	assert.equal(withPrefs.preferredAnswers?.["Which auth?"], "OAuth");
});
