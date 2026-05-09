import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
	annotationsForAnswers,
	formatAnsweredContent,
	formatCancelledContent,
	formatClarifyContent,
	formatInvalidContent,
	formatNoUiContent,
} from "./format.js";
import {
	ASK_USER_QUESTION_DESCRIPTION,
	ASK_USER_QUESTION_PROMPT_GUIDELINES,
	ASK_USER_QUESTION_PROMPT_SNIPPET,
} from "./prompt.js";
import { renderAskCall, renderAskResult } from "./render.js";
import { applyPreferredAnswers, type AskPreferencesStore } from "./preferences.js";
import {
	AskUserQuestionParamsSchema,
	normalizeHeader,
	validateAndNormalizeParams,
	type AskUserQuestionSchemaParams,
} from "./schema.js";
import { createAskDialog } from "./ui/rich-dialog.js";
import { askWithRpcDialogs } from "./ui/rpc-fallback.js";
import {
	ASK_USER_QUESTION_TOOL_NAME,
	type AskConfig,
	type AskDialogResult,
	type AskUserQuestionDetails,
	type AskUserQuestionParams,
	type NormalizedAskUserQuestionParams,
} from "./types.js";

export interface AskExecutionOptions {
	config: AskConfig;
	preferences?: AskPreferencesStore;
}

export function createAskUserQuestionTool(getOptions: () => AskExecutionOptions) {
	return defineTool<typeof AskUserQuestionParamsSchema, AskUserQuestionDetails>({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask",
		description: ASK_USER_QUESTION_DESCRIPTION,
		promptSnippet: ASK_USER_QUESTION_PROMPT_SNIPPET,
		promptGuidelines: ASK_USER_QUESTION_PROMPT_GUIDELINES,
		parameters: AskUserQuestionParamsSchema,
		executionMode: "sequential",
		prepareArguments(args) {
			return normalizeRawArguments(args) as AskUserQuestionSchemaParams;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeAskUserQuestion(params as AskUserQuestionParams, ctx, signal, getOptions());
		},
		renderCall(args, theme) {
			return renderAskCall(args as AskUserQuestionParams, theme);
		},
		renderResult(result, options, theme) {
			return renderAskResult(result, options, theme);
		},
	});
}

export async function executeAskUserQuestion(
	params: AskUserQuestionParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	options: AskExecutionOptions = { config: { previewMode: "markdown", preferences: false } },
): Promise<AgentToolResult<AskUserQuestionDetails>> {
	const validation = validateAndNormalizeParams(params, options.config);
	if (!validation.params) {
		const details: AskUserQuestionDetails = {
			status: "invalid",
			questions: [],
			answers: {},
			metadata: params.metadata,
			message: validation.errors.join("\n"),
		};
		return { content: [{ type: "text", text: formatInvalidContent(validation.errors, validation.warnings) }], details };
	}

	const normalizedParams = options.config.preferences && options.preferences
		? applyPreferredAnswers(validation.params, options.preferences)
		: validation.params;

	if (!ctx.hasUI) {
		const details: AskUserQuestionDetails = {
			status: "no_ui",
			questions: normalizedParams.questions,
			answers: {},
			metadata: validation.params.metadata,
			message: "Interactive UI is unavailable in the current Pi mode.",
		};
		return { content: [{ type: "text", text: formatNoUiContent(normalizedParams.questions) }], details };
	}

	const dialogResult = await askWithBestAvailableUI(ctx, normalizedParams, signal);
	const details = createDetails(normalizedParams, dialogResult);
	if (options.config.preferences) options.preferences?.record(details);
	return { content: [{ type: "text", text: formatDetailsContent(details) }], details };
}

export async function askWithBestAvailableUI(
	ctx: ExtensionContext,
	params: NormalizedAskUserQuestionParams,
	signal?: AbortSignal,
): Promise<AskDialogResult> {
	let factoryInvoked = false;
	try {
		const richResult = await ctx.ui.custom<AskDialogResult | undefined>((tui, theme, keybindings, done) => {
			factoryInvoked = true;
			return createAskDialog(params, tui, theme, keybindings, done);
		});
		if (factoryInvoked && richResult) return richResult;
	} catch {
		// Fall through to the dialog-method fallback. RPC mode cannot render custom
		// TUI components, and some hosts may throw instead of returning undefined.
	}

	return askWithRpcDialogs(ctx, params, signal);
}

function createDetails(params: NormalizedAskUserQuestionParams, result: AskDialogResult): AskUserQuestionDetails {
	const annotations = result.annotations ?? (result.status === "answered" ? annotationsForAnswers(params.questions, result.answers) : undefined);
	return {
		status: result.status,
		questions: params.questions,
		answers: result.answers,
		annotations,
		metadata: params.metadata,
		message: result.message,
	};
}

function formatDetailsContent(details: AskUserQuestionDetails): string {
	switch (details.status) {
		case "answered":
			return formatAnsweredContent(details);
		case "clarify":
			return formatClarifyContent(details);
		case "cancelled":
			return formatCancelledContent(details);
		case "no_ui":
			return formatNoUiContent(details.questions);
		case "invalid":
			return details.message || "AskUserQuestion input is invalid.";
	}
}

function normalizeRawArguments(args: unknown): AskUserQuestionParams {
	if (!args || typeof args !== "object") return { questions: [] };
	const candidate = args as Record<string, unknown>;
	const rawQuestions = Array.isArray(candidate.questions) ? candidate.questions : [];
	const questions = rawQuestions.map((rawQuestion, index) => normalizeRawQuestion(rawQuestion, index));
	return {
		questions,
		metadata: normalizeMetadata(candidate.metadata),
	};
}

function normalizeRawQuestion(rawQuestion: unknown, index: number): AskUserQuestionParams["questions"][number] {
	const questionObject = rawQuestion && typeof rawQuestion === "object" ? (rawQuestion as Record<string, unknown>) : {};
	const questionText = String(questionObject.question ?? "").trim();
	const header = normalizeHeader(typeof questionObject.header === "string" ? questionObject.header : undefined, questionText, index);
	const rawOptions = Array.isArray(questionObject.options) ? questionObject.options : [];
	return {
		question: questionText,
		header,
		multiSelect: questionObject.multiSelect === true,
		options: rawOptions.map(normalizeRawOption),
	};
}

function normalizeRawOption(rawOption: unknown): AskUserQuestionParams["questions"][number]["options"][number] {
	if (typeof rawOption === "string") return { label: rawOption.trim(), description: rawOption.trim() };
	const optionObject = rawOption && typeof rawOption === "object" ? (rawOption as Record<string, unknown>) : {};
	const label = String(optionObject.label ?? "").trim();
	const description = typeof optionObject.description === "string" && optionObject.description.trim()
		? optionObject.description.trim()
		: label;
	const preview = typeof optionObject.preview === "string" && optionObject.preview.trim() ? optionObject.preview : undefined;
	return preview ? { label, description, preview } : { label, description };
}

function normalizeMetadata(metadata: unknown): AskUserQuestionParams["metadata"] {
	if (!metadata || typeof metadata !== "object") return undefined;
	const source = (metadata as Record<string, unknown>).source;
	return typeof source === "string" ? { source } : undefined;
}
