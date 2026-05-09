import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { AskUserQuestionDetails, NormalizedAskUserQuestionParams, NormalizedQuestion } from "./types.js";

interface StoredPreference {
	answer: string;
	updatedAt: string;
	count: number;
}

interface PreferenceFile {
	version: 1;
	answers: Record<string, StoredPreference>;
}

export class AskPreferencesStore {
	private data: PreferenceFile | undefined;
	constructor(private readonly filePath = defaultPreferencesPath()) {}

	preferredAnswers(params: NormalizedAskUserQuestionParams): Record<string, string> | undefined {
		const data = this.load();
		const out: Record<string, string> = {};
		for (const question of params.questions) {
			const preference = data.answers[questionPreferenceKey(question)];
			if (!preference) continue;
			if (!isStillValidPreference(question, preference.answer)) continue;
			out[question.question] = preference.answer;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}

	record(details: AskUserQuestionDetails): void {
		if (details.status !== "answered") return;
		const data = this.load();
		let changed = false;
		for (const question of details.questions) {
			const answer = details.answers[question.question];
			if (!answer) continue;
			const key = questionPreferenceKey(question);
			const previous = data.answers[key];
			data.answers[key] = {
				answer,
				updatedAt: new Date().toISOString(),
				count: (previous?.count ?? 0) + 1,
			};
			changed = true;
		}
		if (changed) this.save(data);
	}

	clear(): void {
		this.data = { version: 1, answers: {} };
		this.save(this.data);
	}

	path(): string {
		return this.filePath;
	}

	private load(): PreferenceFile {
		if (this.data) return this.data;
		try {
			if (existsSync(this.filePath)) {
				const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PreferenceFile>;
				if (parsed.version === 1 && parsed.answers && typeof parsed.answers === "object") {
					this.data = { version: 1, answers: parsed.answers as Record<string, StoredPreference> };
					return this.data;
				}
			}
		} catch {
			// Ignore corrupt preference files and start fresh.
		}
		this.data = { version: 1, answers: {} };
		return this.data;
	}

	private save(data: PreferenceFile): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	}
}

export function applyPreferredAnswers(
	params: NormalizedAskUserQuestionParams,
	store: AskPreferencesStore,
): NormalizedAskUserQuestionParams {
	const preferredAnswers = store.preferredAnswers(params);
	return preferredAnswers ? { ...params, preferredAnswers } : params;
}

export function defaultPreferencesPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || ".", ".pi", "agent");
	return join(agentDir, "ask", "preferences.json");
}

function questionPreferenceKey(question: NormalizedQuestion): string {
	const material = JSON.stringify({
		question: question.question,
		multiSelect: question.multiSelect,
		options: question.options.map((option) => option.label),
	});
	return createHash("sha256").update(material).digest("hex");
}

function isStillValidPreference(question: NormalizedQuestion, answer: string): boolean {
	if (question.multiSelect) {
		const labels = new Set(question.options.map((option) => option.label));
		return answer.split(",").map((part) => part.trim()).every((part) => labels.has(part) || part.length > 0);
	}
	return question.options.some((option) => option.label === answer) || answer.trim().length > 0;
}
