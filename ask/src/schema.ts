import { Type, type Static } from "@earendil-works/pi-ai";
import { processPreview } from "./preview.js";
import type { AskConfig, AskUserQuestionParams, NormalizedAskUserQuestionParams, NormalizedQuestion } from "./types.js";

export const AnswerAnnotationSchema = Type.Object(
	{
		preview: Type.Optional(Type.String({ description: "Optional preview text selected by the user" })),
		notes: Type.Optional(Type.String({ description: "Optional user notes about the selected answer" })),
	},
	{ additionalProperties: false },
);

export const QuestionOptionSchema = Type.Object(
	{
		label: Type.String({ minLength: 1, description: "Concise display text for this option" }),
		description: Type.String({ minLength: 1, description: "Context, trade-offs, or explanation for this option" }),
		preview: Type.Optional(Type.String({ description: "Optional markdown preview for this option" })),
	},
	{ additionalProperties: false },
);

export const QuestionSchema = Type.Object(
	{
		question: Type.String({ minLength: 1, description: "Full question text to ask the user" }),
		header: Type.Optional(Type.String({ minLength: 1, maxLength: 12, description: "Short tab/chip label, max 12 characters; derived if omitted" })),
		options: Type.Array(QuestionOptionSchema, { minItems: 2, maxItems: 4, description: "Two to four concrete answer options" }),
		multiSelect: Type.Optional(Type.Boolean({ description: "True when multiple options may apply" })),
	},
	{ additionalProperties: false },
);

export const AskUserQuestionParamsSchema = Type.Object(
	{
		questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4, description: "One to four questions to ask the user" }),
		answers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Internal/compat field; ignored and overwritten by user answers" })),
		annotations: Type.Optional(Type.Record(Type.String(), AnswerAnnotationSchema, { description: "Internal/compat annotation field" })),
		metadata: Type.Optional(
			Type.Object(
				{
					source: Type.Optional(Type.String({ description: "Optional source tag" })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type AskUserQuestionSchemaParams = Static<typeof AskUserQuestionParamsSchema>;

export interface ValidationResult {
	params?: NormalizedAskUserQuestionParams;
	errors: string[];
	warnings: string[];
}

export function validateAndNormalizeParams(
	params: AskUserQuestionParams,
	config: Pick<AskConfig, "previewMode"> = { previewMode: "markdown" },
): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const questions = Array.isArray(params.questions) ? params.questions : [];

	if (questions.length < 1) errors.push("AskUserQuestion requires at least one question.");
	if (questions.length > 4) errors.push("AskUserQuestion supports at most four questions per call.");

	const seenQuestions = new Set<string>();
	const normalizedQuestions: NormalizedQuestion[] = [];

	questions.forEach((question, index) => {
		const questionText = String(question.question ?? "").trim();
		const originalHeader = typeof question.header === "string" ? question.header.trim() : undefined;
		const header = normalizeHeader(originalHeader, questionText, index);
		const multiSelect = question.multiSelect === true;
		const options = Array.isArray(question.options) ? question.options : [];

		if (!questionText) errors.push(`Question ${index + 1} has empty question text.`);
		if (!originalHeader) warnings.push(`Question ${index + 1} omitted header; using ${JSON.stringify(header)}.`);
		else if (originalHeader !== header) warnings.push(`Question ${index + 1} header was truncated to ${JSON.stringify(header)}.`);
		if (seenQuestions.has(questionText)) errors.push(`Duplicate question text: ${JSON.stringify(questionText)}.`);
		if (questionText) seenQuestions.add(questionText);
		if (options.length < 2) errors.push(`Question ${index + 1} must include at least two options.`);
		if (options.length > 4) errors.push(`Question ${index + 1} must include at most four options.`);
		if (!questionText.endsWith("?")) warnings.push(`Question ${index + 1} should usually end with a question mark.`);

		const seenLabels = new Set<string>();
		const normalizedOptions = options.map((option, optionIndex) => {
			const label = String(option.label ?? "").trim();
			const description = String(option.description ?? "").trim();
			const rawPreview = typeof option.preview === "string" && option.preview.length > 0 ? option.preview : undefined;
			const processedPreview = processPreview(rawPreview, config.previewMode, `Question ${index + 1}, option ${optionIndex + 1}`);
			const labelKey = label.toLowerCase();

			if (!label) errors.push(`Question ${index + 1}, option ${optionIndex + 1} has an empty label.`);
			if (!description) errors.push(`Question ${index + 1}, option ${optionIndex + 1} has an empty description.`);
			if (processedPreview.error) errors.push(processedPreview.error);
			if (processedPreview.warning) warnings.push(processedPreview.warning);
			if (seenLabels.has(labelKey)) errors.push(`Question ${index + 1} has duplicate option label: ${JSON.stringify(label)}.`);
			if (label) seenLabels.add(labelKey);
			if (isExplicitOtherLabel(label)) {
				errors.push(`Question ${index + 1} includes an explicit ${JSON.stringify(label)} option; omit it because Pi adds ${JSON.stringify("Type something.")} automatically.`);
			}
			return processedPreview.preview ? { label, description, preview: processedPreview.preview } : { label, description };
		});

		if (multiSelect && normalizedOptions.some((option) => option.preview)) {
			errors.push(`Question ${index + 1} is multi-select and includes option previews; previews are only supported for single-select questions in this version.`);
		}

		normalizedQuestions.push({
			question: questionText,
			header,
			originalHeader: originalHeader && originalHeader !== header ? originalHeader : undefined,
			options: normalizedOptions,
			multiSelect,
		});
	});

	return {
		params: errors.length === 0 ? { questions: normalizedQuestions, metadata: params.metadata } : undefined,
		errors,
		warnings,
	};
}

export function normalizeHeader(header: string | undefined, questionText: string, index = 0): string {
	const source = header?.trim() || deriveHeader(questionText, index);
	return truncatePlain(source, 12) || `Q${index + 1}`;
}

function deriveHeader(questionText: string, index: number): string {
	const cleaned = questionText
		.replace(/[?!.]+$/u, "")
		.replace(/^(which|what|how|should|do|does|would|could|can)\s+/iu, "")
		.trim();
	const firstWords = cleaned.split(/\s+/u).filter(Boolean).slice(0, 2).join(" ");
	return firstWords || `Q${index + 1}`;
}

function truncatePlain(value: string, max: number): string {
	return value.length <= max ? value : value.slice(0, max).trimEnd();
}

function isExplicitOtherLabel(label: string): boolean {
	const normalized = label.trim().toLowerCase().replace(/[.!?]+$/u, "");
	return normalized === "other" || normalized === "type something" || normalized === "type your answer" || normalized === "custom";
}
