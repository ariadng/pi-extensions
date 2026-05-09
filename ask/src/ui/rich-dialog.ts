import {
	Editor,
	type EditorTheme,
	Key,
	type Component,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { annotationsForAnswers } from "../format.js";
import { OTHER_LABEL, type AnswerAnnotation, type AskDialogResult, type NormalizedAskUserQuestionParams, type NormalizedQuestion } from "../types.js";

const PREVIEW_MIN_WIDTH = 88;
const MAX_PREVIEW_LINES = 12;

interface AnswerState {
	values: string[];
}

interface DisplayOption {
	label: string;
	description?: string;
	preview?: string;
	isOther?: boolean;
}

type InputMode = "other" | "notes" | undefined;

export function createAskDialog(
	params: NormalizedAskUserQuestionParams,
	tui: TUI,
	theme: Theme,
	_keybindings: KeybindingsManager,
	done: (result: AskDialogResult) => void,
): Component {
	const questions = params.questions;
	const hasAnyPreview = questions.some((question) => question.options.some((option) => option.preview));
	const needsReview = questions.length > 1 || questions.some((question) => question.multiSelect) || hasAnyPreview;
	const totalTabs = questions.length + (needsReview ? 1 : 0);
	const answers = new Map<string, AnswerState>();
	const notes = new Map<string, string>();
	for (const question of questions) {
		const preferred = params.preferredAnswers?.[question.question];
		if (preferred) answers.set(question.question, { values: parseAnswerValues(preferred) });
	}
	let currentTab = 0;
	let optionIndex = initialOptionIndex(questions[0], params.preferredAnswers);
	let inputMode: InputMode;
	let inputQuestion: NormalizedQuestion | undefined;
	let warning: string | undefined;
	let cachedLines: string[] | undefined;

	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const editor = new Editor(tui, editorTheme);

	editor.onSubmit = (value) => {
		const trimmed = value.trim();
		if (!inputQuestion) return;
		const answeredQuestion = inputQuestion;

		if (inputMode === "notes") {
			if (trimmed) notes.set(answeredQuestion.question, trimmed);
			else notes.delete(answeredQuestion.question);
			inputMode = undefined;
			inputQuestion = undefined;
			editor.setText("");
			warning = undefined;
			refresh();
			return;
		}

		if (!trimmed) {
			warning = "Type an answer or press Esc to return to the options.";
			refresh();
			return;
		}
		if (answeredQuestion.multiSelect) addAnswer(answeredQuestion, trimmed);
		else setAnswer(answeredQuestion, [trimmed]);
		inputMode = undefined;
		inputQuestion = undefined;
		editor.setText("");
		advanceAfterAnswer(answeredQuestion);
	};

	function refresh(): void {
		cachedLines = undefined;
		tui.requestRender();
	}

	function currentQuestion(): NormalizedQuestion | undefined {
		return questions[currentTab];
	}

	function currentOptions(): DisplayOption[] {
		const question = currentQuestion();
		if (!question) return [];
		return [...question.options, { label: OTHER_LABEL, description: "Write a custom answer", isOther: true }];
	}

	function resetOptionIndexForTab(): void {
		optionIndex = initialOptionIndex(currentQuestion(), params.preferredAnswers);
	}

	function answerFor(question: NormalizedQuestion): AnswerState {
		const existing = answers.get(question.question);
		if (existing) return existing;
		const created = { values: [] };
		answers.set(question.question, created);
		return created;
	}

	function setAnswer(question: NormalizedQuestion, values: string[]): void {
		answers.set(question.question, { values: values.filter(Boolean) });
		warning = undefined;
	}

	function addAnswer(question: NormalizedQuestion, value: string): void {
		const state = answerFor(question);
		if (!state.values.includes(value)) state.values.push(value);
		warning = undefined;
	}

	function toggleAnswer(question: NormalizedQuestion, value: string): void {
		const state = answerFor(question);
		if (state.values.includes(value)) state.values = state.values.filter((candidate) => candidate !== value);
		else state.values.push(value);
		if (state.values.length === 0) answers.delete(question.question);
		warning = undefined;
	}

	function isSelected(question: NormalizedQuestion, value: string): boolean {
		return answers.get(question.question)?.values.includes(value) === true;
	}

	function selectedAnswer(question: NormalizedQuestion): string | undefined {
		return answers.get(question.question)?.values[0];
	}

	function selectedOption(question: NormalizedQuestion): DisplayOption | undefined {
		const selected = selectedAnswer(question);
		return selected ? currentOptions().find((option) => option.label === selected) : undefined;
	}

	function allAnswered(): boolean {
		return questions.every((question) => (answers.get(question.question)?.values.length ?? 0) > 0);
	}

	function answersObject(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const question of questions) {
			const values = answers.get(question.question)?.values ?? [];
			if (values.length > 0) out[question.question] = values.join(", ");
		}
		return out;
	}

	function submit(status: "answered" | "cancelled" | "clarify", message?: string): void {
		const resultAnswers = answersObject();
		done({
			status,
			answers: resultAnswers,
			annotations: status === "answered" ? collectAnnotations(resultAnswers) : undefined,
			message,
		});
	}

	function collectAnnotations(resultAnswers: Record<string, string>): Record<string, AnswerAnnotation> | undefined {
		const annotations = annotationsForAnswers(questions, resultAnswers) ?? {};
		for (const [questionText, note] of notes.entries()) {
			annotations[questionText] = { ...annotations[questionText], notes: note };
		}
		return Object.keys(annotations).length > 0 ? annotations : undefined;
	}

	function advanceAfterAnswer(question: NormalizedQuestion | undefined): void {
		if (!needsReview && question && !question.multiSelect) {
			submit("answered");
			return;
		}
		if (currentTab < questions.length - 1) currentTab++;
		else currentTab = questions.length;
		resetOptionIndexForTab();
		refresh();
	}

	function handleInput(data: string): void {
		if (inputMode) {
			if (matchesKey(data, Key.escape)) {
				inputMode = undefined;
				inputQuestion = undefined;
				editor.setText("");
				warning = undefined;
				refresh();
				return;
			}
			editor.handleInput(data);
			refresh();
			return;
		}

		if (matchesKey(data, "c")) {
			submit("clarify", "The user wants to chat about or clarify these questions before answering.");
			return;
		}

		if (needsReview) {
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				currentTab = (currentTab + 1) % totalTabs;
				resetOptionIndexForTab();
				warning = undefined;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				currentTab = (currentTab - 1 + totalTabs) % totalTabs;
				resetOptionIndexForTab();
				warning = undefined;
				refresh();
				return;
			}
		}

		if (currentTab === questions.length) {
			if (matchesKey(data, Key.enter)) {
				if (allAnswered()) submit("answered");
				else {
					warning = `Answer ${questions.filter((question) => !answers.has(question.question)).map((question) => question.header).join(", ")} before submitting.`;
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.escape)) submit("cancelled");
			return;
		}

		const question = currentQuestion();
		const options = currentOptions();
		if (!question) return;

		if (matchesKey(data, "n")) {
			if (!question.options.some((option) => option.preview)) {
				warning = "Notes are available for preview questions only.";
				refresh();
				return;
			}
			if (!selectedAnswer(question)) {
				warning = "Select an option before adding notes.";
				refresh();
				return;
			}
			inputMode = "notes";
			inputQuestion = question;
			editor.setText(notes.get(question.question) ?? "");
			warning = undefined;
			refresh();
			return;
		}

		if (matchesKey(data, Key.up)) {
			optionIndex = Math.max(0, optionIndex - 1);
			refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			optionIndex = Math.min(options.length - 1, optionIndex + 1);
			refresh();
			return;
		}

		if (matchesKey(data, Key.enter) || (question.multiSelect && matchesKey(data, Key.space))) {
			const option = options[optionIndex];
			if (!option) return;
			if (option.isOther) {
				inputMode = "other";
				inputQuestion = question;
				editor.setText("");
				warning = undefined;
				refresh();
				return;
			}
			if (question.multiSelect) {
				toggleAnswer(question, option.label);
				refresh();
				return;
			}
			setAnswer(question, [option.label]);
			advanceAfterAnswer(question);
			return;
		}

		if (matchesKey(data, Key.escape)) submit("cancelled");
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;
		const safeWidth = Math.max(24, width);
		const lines: string[] = [];
		const add = (line: string) => lines.push(truncateToWidth(line, safeWidth));
		const question = currentQuestion();
		const options = currentOptions();

		add(theme.fg("accent", "─".repeat(safeWidth)));
		add(`${theme.fg("toolTitle", theme.bold(" AskUserQuestion"))}${theme.fg("muted", " — answer to continue")}`);

		if (needsReview) {
			const tabs = questions.map((candidate, index) => {
				const active = index === currentTab;
				const answered = answers.has(candidate.question);
				const text = ` ${answered ? "■" : "□"} ${candidate.header} `;
				return active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text);
			});
			const submitActive = currentTab === questions.length;
			const submit = submitActive ? theme.bg("selectedBg", theme.fg("text", " ✓ Submit ")) : theme.fg(allAnswered() ? "success" : "dim", " ✓ Submit ");
			add(` ${tabs.join(" ")} ${submit} ${theme.fg("dim", "C Chat")}`);
		}

		lines.push("");

		if (inputMode && inputQuestion) {
			renderEditor(add, safeWidth, inputQuestion);
		} else if (currentTab === questions.length) {
			renderReview(add);
		} else if (question) {
			add(theme.fg("text", question.question));
			if (question.multiSelect) add(theme.fg("muted", "Select one or more answers."));
			lines.push("");
			if (!question.multiSelect && question.options.some((option) => option.preview)) renderPreviewQuestion(add, safeWidth, question, options);
			else for (const line of buildOptionLines(question, options, safeWidth)) add(line);
		}

		if (warning) {
			lines.push("");
			add(theme.fg("warning", warning));
		}

		lines.push("");
		add(theme.fg("dim", footerHelp()));
		add(theme.fg("accent", "─".repeat(safeWidth)));

		cachedLines = lines;
		return lines;
	}

	function renderEditor(add: (line: string) => void, safeWidth: number, question: NormalizedQuestion): void {
		add(theme.fg("text", question.question));
		if (inputMode === "notes") {
			const answer = selectedAnswer(question);
			add(theme.fg("muted", `Notes for: ${answer ?? "selected option"}`));
		} else {
			linesBreak(add);
			for (const line of buildOptionLines(question, currentOptions(), safeWidth)) add(line);
		}
		linesBreak(add);
		add(theme.fg("muted", inputMode === "notes" ? "Notes:" : "Your custom answer:"));
		for (const line of editor.render(Math.max(10, safeWidth - 2))) add(` ${line}`);
	}

	function renderReview(add: (line: string) => void): void {
		add(theme.fg("accent", theme.bold("Review answers")));
		linesBreak(add);
		for (const candidate of questions) {
			const answer = answers.get(candidate.question)?.values.join(", ");
			add(`${theme.fg("muted", `${candidate.header}: `)}${answer ? theme.fg("text", answer) : theme.fg("warning", "unanswered")}`);
			const note = notes.get(candidate.question);
			if (note) add(theme.fg("dim", `  notes: ${note}`));
		}
		linesBreak(add);
		add(allAnswered() ? theme.fg("success", "Press Enter to submit") : theme.fg("warning", "Answer all questions before submitting"));
	}

	function renderPreviewQuestion(
		add: (line: string) => void,
		safeWidth: number,
		question: NormalizedQuestion,
		options: readonly DisplayOption[],
	): void {
		if (safeWidth >= PREVIEW_MIN_WIDTH) {
			const leftWidth = Math.max(32, Math.floor(safeWidth * 0.42));
			const rightWidth = Math.max(20, safeWidth - leftWidth - 3);
			const left = buildOptionLines(question, options, leftWidth);
			const right = buildPreviewLines(question, options, rightWidth);
			const rows = Math.max(left.length, right.length);
			for (let index = 0; index < rows; index++) {
				add(`${padVisible(left[index] ?? "", leftWidth)}${theme.fg("dim", " │ ")}${right[index] ?? ""}`);
			}
			return;
		}

		for (const line of buildOptionLines(question, options, safeWidth)) add(line);
		linesBreak(add);
		for (const line of buildPreviewLines(question, options, safeWidth)) add(line);
	}

	function buildOptionLines(question: NormalizedQuestion, options: readonly DisplayOption[], width: number): string[] {
		const out: string[] = [];
		for (let index = 0; index < options.length; index++) {
			const option = options[index];
			const focused = index === optionIndex;
			const selected = !option.isOther && isSelected(question, option.label);
			const prefix = focused ? theme.fg("accent", "> ") : "  ";
			const marker = question.multiSelect ? (selected ? theme.fg("success", "[x] ") : theme.fg("dim", "[ ] ")) : selected ? theme.fg("success", "✓ ") : "";
			const label = option.isOther && inputMode === "other" ? `${option.label} ✎` : option.label;
			const color = focused ? "accent" : selected ? "success" : "text";
			const noteMarker = selected && notes.has(question.question) ? theme.fg("dim", " · notes") : "";
			out.push(truncateToWidth(`${prefix}${marker}${theme.fg(color, label)}${option.preview ? theme.fg("dim", " · preview") : ""}${noteMarker}`, width));
			if (option.description) out.push(truncateToWidth(`    ${theme.fg("muted", option.description)}`, width));
		}
		return out;
	}

	function buildPreviewLines(question: NormalizedQuestion, options: readonly DisplayOption[], width: number): string[] {
		const selected = selectedOption(question);
		const focused = options[optionIndex]?.isOther ? undefined : options[optionIndex];
		const option = focused?.preview ? focused : selected?.preview ? selected : options.find((candidate) => candidate.preview);
		const out: string[] = [theme.fg("accent", theme.bold(option?.preview ? `Preview: ${option.label}` : "Preview"))];
		if (!option?.preview) {
			out.push(theme.fg("dim", "No preview for this option."));
			return out;
		}
		const wrapped = wrapTextWithAnsi(option.preview, Math.max(12, width));
		const visible = wrapped.slice(0, MAX_PREVIEW_LINES);
		for (const line of visible) out.push(truncateToWidth(line, width));
		if (wrapped.length > visible.length) out.push(theme.fg("dim", "… preview truncated"));
		const note = notes.get(question.question);
		if (note) {
			out.push("");
			out.push(theme.fg("muted", `Notes: ${truncateToWidth(note, width - 7)}`));
		}
		return out;
	}

	function footerHelp(): string {
		if (inputMode === "notes") return "Enter save notes • Esc return to options";
		if (inputMode === "other") return "Enter submit custom answer • Esc return to options";
		if (needsReview) return "Tab/←→ questions • ↑↓ select • Enter confirm/toggle • Space multi • N notes • C chat • Esc cancel";
		return "↑↓ select • Enter answer • C chat • Esc cancel";
	}

	function linesBreak(add: (line: string) => void): void {
		add("");
	}

	return {
		render,
		invalidate: () => {
			cachedLines = undefined;
		},
		handleInput,
	};
}

function initialOptionIndex(question: NormalizedQuestion | undefined, preferredAnswers: Record<string, string> | undefined): number {
	if (!question) return 0;
	const preferred = preferredAnswers?.[question.question];
	if (!preferred) return 0;
	const firstValue = parseAnswerValues(preferred)[0];
	const index = question.options.findIndex((option) => option.label === firstValue);
	return index >= 0 ? index : question.options.length;
}

function parseAnswerValues(answer: string): string[] {
	return answer.split(",").map((part) => part.trim()).filter(Boolean);
}

function padVisible(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? truncateToWidth(text, width) : `${text}${" ".repeat(width - visible)}`;
}
