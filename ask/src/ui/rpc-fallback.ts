import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { annotationsForAnswers } from "../format.js";
import { OTHER_LABEL, type AskDialogResult, type NormalizedAskUserQuestionParams, type NormalizedQuestion } from "../types.js";

const CHAT_LABEL = "Chat about this";

type DialogChoice =
	| { status: "answer"; answer: string }
	| { status: "cancelled" }
	| { status: "clarify" };

export async function askWithRpcDialogs(
	ctx: ExtensionContext,
	params: NormalizedAskUserQuestionParams,
	signal?: AbortSignal,
): Promise<AskDialogResult> {
	const answers: Record<string, string> = {};

	for (const question of params.questions) {
		const preferred = params.preferredAnswers?.[question.question];
		const choice = question.multiSelect
			? await askMultiSelect(ctx, question, preferred, signal)
			: await askSingleSelect(ctx, question, preferred, signal);
		if (choice.status === "cancelled") {
			return {
				status: "cancelled",
				answers,
				message: "The user cancelled AskUserQuestion before answering all questions.",
			};
		}
		if (choice.status === "clarify") {
			return {
				status: "clarify",
				answers,
				message: "The user wants to chat about or clarify these questions before answering.",
			};
		}
		answers[question.question] = choice.answer;
	}

	return {
		status: "answered",
		answers,
		annotations: annotationsForAnswers(params.questions, answers),
	};
}

async function askSingleSelect(
	ctx: ExtensionContext,
	question: NormalizedQuestion,
	preferred: string | undefined,
	signal?: AbortSignal,
): Promise<DialogChoice> {
	const previousLabel = preferred ? `Use previous: ${preferred}` : undefined;
	const labels = [...(previousLabel ? [previousLabel] : []), ...question.options.map((option) => option.label), OTHER_LABEL, CHAT_LABEL];
	const selected = await ctx.ui.select(formatTitle(question), labels, { signal });
	if (selected === undefined) return { status: "cancelled" };
	if (selected === CHAT_LABEL) return { status: "clarify" };
	if (previousLabel && selected === previousLabel) return { status: "answer", answer: preferred! };
	if (selected === OTHER_LABEL) {
		const custom = await askOther(ctx, question, signal);
		return custom === undefined ? { status: "cancelled" } : { status: "answer", answer: custom };
	}
	return { status: "answer", answer: selected };
}

async function askMultiSelect(
	ctx: ExtensionContext,
	question: NormalizedQuestion,
	preferred: string | undefined,
	signal?: AbortSignal,
): Promise<DialogChoice> {
	const selected = new Set<string>();
	const previousLabel = preferred ? `Use previous: ${preferred}` : undefined;
	while (true) {
		const labels = question.options.map((option) => `${selected.has(option.label) ? "✓" : "○"} ${option.label}`);
		const doneLabel = selected.size > 0 ? `Done (${Array.from(selected).join(", ")})` : "Done";
		const choice = await ctx.ui.select(formatTitle(question), [...(previousLabel ? [previousLabel] : []), ...labels, OTHER_LABEL, doneLabel, CHAT_LABEL], { signal });
		if (choice === undefined) return { status: "cancelled" };
		if (choice === CHAT_LABEL) return { status: "clarify" };
		if (previousLabel && choice === previousLabel) return { status: "answer", answer: preferred! };
		if (choice === doneLabel) {
			if (selected.size > 0) return { status: "answer", answer: Array.from(selected).join(", ") };
			ctx.ui.notify("Select at least one answer, choose Chat about this, or cancel the question.", "warning");
			continue;
		}
		if (choice === OTHER_LABEL) {
			const custom = await askOther(ctx, question, signal);
			if (custom === undefined) return { status: "cancelled" };
			if (custom.trim()) selected.add(custom.trim());
			continue;
		}
		const label = choice.replace(/^[✓○]\s/u, "");
		if (selected.has(label)) selected.delete(label);
		else selected.add(label);
	}
}

async function askOther(ctx: ExtensionContext, question: NormalizedQuestion, signal?: AbortSignal): Promise<string | undefined> {
	const answer = await ctx.ui.input(`${question.header}: custom answer`, "Type your answer", { signal });
	const trimmed = answer?.trim();
	return trimmed || undefined;
}

function formatTitle(question: NormalizedQuestion): string {
	const suffix = question.multiSelect ? " (select one or more)" : "";
	return `${question.question}${suffix}`;
}
