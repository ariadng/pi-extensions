export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
export const OTHER_LABEL = "Type something.";

export type AskPreviewMode = "off" | "markdown" | "html";

export interface AskConfig {
	previewMode: AskPreviewMode;
	preferences: boolean;
}

export interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface Question {
	question: string;
	header?: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

export interface AskUserQuestionParams {
	questions: Question[];
	answers?: Record<string, string>;
	annotations?: Record<string, AnswerAnnotation>;
	metadata?: { source?: string };
}

export interface NormalizedQuestion extends Question {
	header: string;
	originalHeader?: string;
	multiSelect: boolean;
}

export interface NormalizedAskUserQuestionParams {
	questions: NormalizedQuestion[];
	metadata?: { source?: string };
	preferredAnswers?: Record<string, string>;
}

export interface AnswerAnnotation {
	preview?: string;
	notes?: string;
}

export type AskUserQuestionStatus = "answered" | "cancelled" | "clarify" | "no_ui" | "invalid";

export interface AskUserQuestionDetails {
	status: AskUserQuestionStatus;
	questions: NormalizedQuestion[];
	answers: Record<string, string>;
	annotations?: Record<string, AnswerAnnotation>;
	metadata?: { source?: string };
	message?: string;
}

export interface AskDialogResult {
	status: "answered" | "cancelled" | "clarify";
	answers: Record<string, string>;
	annotations?: Record<string, AnswerAnnotation>;
	message?: string;
}
