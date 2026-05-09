import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { summarizeQuestions } from "./format.js";
import type { AskUserQuestionDetails, AskUserQuestionParams, NormalizedQuestion } from "./types.js";

export function renderAskCall(args: AskUserQuestionParams, theme: Theme): Text {
	const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
	const questions = rawQuestions.map((question) => ({
		question: question.question,
		header: question.header,
		options: question.options,
		multiSelect: question.multiSelect === true,
	})) as NormalizedQuestion[];
	let text = theme.fg("toolTitle", theme.bold("AskUserQuestion ")) + theme.fg("muted", summarizeQuestions(questions));
	if (questions.length > 0) {
		const labels = questions.map((question) => question.header || question.question).join(", ");
		text += theme.fg("dim", ` ${truncateToWidth(labels, 48)}`);
	}
	return new Text(text, 0, 0);
}

export function renderAskResult(result: AgentToolResult<AskUserQuestionDetails>, options: ToolRenderResultOptions, theme: Theme): Text {
	const details = result.details;
	if (!details) {
		const text = result.content.find((item) => item.type === "text")?.text ?? "";
		return new Text(text, 0, 0);
	}

	if (details.status === "answered") {
		const lines = details.questions.map((question) => {
			const answer = details.answers[question.question] ?? "";
			return `${theme.fg("success", "✓ ")}${theme.fg("muted", `${question.header}: `)}${theme.fg("accent", answer)}`;
		});
		if (options.expanded && details.annotations) {
			for (const [question, annotation] of Object.entries(details.annotations)) {
				if (annotation.preview) lines.push(theme.fg("dim", `preview for ${question}: ${truncateToWidth(annotation.preview.replace(/\s+/gu, " "), 100)}`));
				if (annotation.notes) lines.push(theme.fg("dim", `notes for ${question}: ${annotation.notes}`));
			}
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	const statusText: Record<AskUserQuestionDetails["status"], string> = {
		answered: "answered",
		cancelled: "cancelled",
		clarify: "clarify requested",
		no_ui: "UI unavailable",
		invalid: "invalid input",
	};
	const color = details.status === "invalid" || details.status === "no_ui" || details.status === "cancelled" ? "warning" : "muted";
	return new Text(theme.fg(color, `⚠ ${statusText[details.status]}`), 0, 0);
}
