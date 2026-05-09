import type { AnswerAnnotation, AskUserQuestionDetails, NormalizedQuestion } from "./types.js";

export function formatAnsweredContent(details: Pick<AskUserQuestionDetails, "questions" | "answers" | "annotations">): string {
	const lines = ["User has answered your questions:"];
	for (const question of details.questions) {
		const answer = details.answers[question.question];
		if (answer === undefined) continue;
		lines.push(`- ${JSON.stringify(question.question)} = ${JSON.stringify(answer)}`);
		const annotation = details.annotations?.[question.question];
		if (annotation?.preview) lines.push(indent(`selected preview:\n${annotation.preview}`, 2));
		if (annotation?.notes) lines.push(indent(`user notes: ${annotation.notes}`, 2));
	}
	lines.push("You can now continue with the user's answers in mind.");
	return lines.join("\n");
}

export function formatCancelledContent(details: Pick<AskUserQuestionDetails, "questions" | "answers" | "message">): string {
	const answered = Object.entries(details.answers);
	const lines = [details.message || "The user cancelled AskUserQuestion without answering all questions."];
	if (answered.length > 0) {
		lines.push("Answers gathered before cancellation:");
		for (const [question, answer] of answered) lines.push(`- ${JSON.stringify(question)} = ${JSON.stringify(answer)}`);
	}
	lines.push("Do not retry the exact same question. Continue with reasonable assumptions or ask a simpler question in your response.");
	return lines.join("\n");
}

export function formatClarifyContent(details: Pick<AskUserQuestionDetails, "questions" | "answers" | "message">): string {
	const lines = [details.message || "The user wants to discuss or clarify the questions before answering."];
	if (Object.keys(details.answers).length > 0) {
		lines.push("Current answers:");
		for (const [question, answer] of Object.entries(details.answers)) lines.push(`- ${JSON.stringify(question)} = ${JSON.stringify(answer)}`);
	}
	lines.push("Reformulate or continue the conversation accordingly.");
	return lines.join("\n");
}

export function formatNoUiContent(questions: readonly NormalizedQuestion[]): string {
	const lines = [
		"AskUserQuestion could not ask the user because interactive UI is unavailable in the current Pi mode.",
		"Questions that would have been asked:",
	];
	for (const question of questions) {
		lines.push(`- ${question.question}`);
		for (const option of question.options) lines.push(`  - ${option.label}: ${option.description}`);
	}
	lines.push("Continue with reasonable assumptions or ask the user directly in your response.");
	return lines.join("\n");
}

export function formatInvalidContent(errors: readonly string[], warnings: readonly string[]): string {
	const lines = ["AskUserQuestion input is invalid:"];
	for (const error of errors) lines.push(`- ${error}`);
	if (warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of warnings) lines.push(`- ${warning}`);
	}
	return lines.join("\n");
}

export function annotationsForAnswers(questions: readonly NormalizedQuestion[], answers: Record<string, string>): Record<string, AnswerAnnotation> | undefined {
	const annotations: Record<string, AnswerAnnotation> = {};
	for (const question of questions) {
		if (question.multiSelect) continue;
		const answer = answers[question.question];
		if (!answer) continue;
		const selected = question.options.find((option) => option.label === answer);
		if (selected?.preview) annotations[question.question] = { preview: selected.preview };
	}
	return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export function summarizeQuestions(questions: readonly NormalizedQuestion[]): string {
	const headers = questions.map((question) => question.header).filter(Boolean);
	return `${questions.length} question${questions.length === 1 ? "" : "s"}${headers.length > 0 ? ` (${headers.join(", ")})` : ""}`;
}

function indent(text: string, spaces: number): string {
	const prefix = " ".repeat(spaces);
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}
