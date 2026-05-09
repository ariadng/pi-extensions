import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { executeAskUserQuestion, type AskExecutionOptions } from "./tool.js";
import type { AskUserQuestionParams } from "./types.js";

export function registerAskCommands(pi: ExtensionAPI, getOptions: () => AskExecutionOptions): void {
	pi.registerCommand("ask-demo", {
		description: "Show a local AskUserQuestion demo dialog",
		handler: async (_args, ctx) => {
			await runAskDemo(ctx, getOptions());
		},
	});

	pi.registerCommand("ask-config", {
		description: "Show pi-ask configuration",
		handler: async (_args, ctx) => {
			const options = getOptions();
			ctx.ui.notify(
				`pi-ask: AskUserQuestion is registered and auto-allowed when active. Preview=${options.config.previewMode}. Preferences=${options.config.preferences ? "on" : "off"}${options.preferences ? ` (${options.preferences.path()})` : ""}. Alias: none.`,
				"info",
			);
		},
	});

	pi.registerCommand("ask-clear-preferences", {
		description: "Clear stored AskUserQuestion default-answer preferences",
		handler: async (_args, ctx) => {
			const options = getOptions();
			options.preferences?.clear();
			ctx.ui.notify("Cleared pi-ask preferences.", "info");
		},
	});

	pi.registerCommand("ask-last", {
		description: "Convert the most recent assistant text questions into an AskUserQuestion dialog",
		handler: async (_args, ctx) => {
			await runAskLast(ctx, getOptions());
		},
	});
}

async function runAskDemo(ctx: ExtensionCommandContext, options: AskExecutionOptions): Promise<void> {
	const params: AskUserQuestionParams = {
		questions: [
			{
				question: "Which implementation style should this demo pretend to use?",
				header: "Style",
				options: [
					{
						label: "Minimal (Recommended)",
						description: "Smallest safe change with straightforward behavior.",
						preview: options.config.previewMode === "html"
							? "<section><h3>Minimal approach</h3><ul><li>Keep the implementation compact</li><li>Prefer predictable defaults</li><li>Add only required UI affordances</li></ul></section>"
							: "### Minimal approach\n\n- Keep the implementation compact\n- Prefer predictable defaults\n- Add only required UI affordances",
					},
					{
						label: "Polished",
						description: "Adds more UI affordances and explanatory text.",
						preview: options.config.previewMode === "html"
							? "<section><h3>Polished approach</h3><ul><li>More explanatory copy</li><li>Extra keyboard hints</li><li>More complete visual review before submit</li></ul></section>"
							: "### Polished approach\n\n- More explanatory copy\n- Extra keyboard hints\n- More complete visual review before submit",
					},
				],
			},
			{
				question: "Which extras should be included?",
				header: "Extras",
				multiSelect: true,
				options: [
					{ label: "Docs", description: "Document usage and caveats." },
					{ label: "Smoke tests", description: "Run quick RPC checks after implementation." },
					{ label: "Examples", description: "Add copy-paste examples for users." },
				],
			},
		],
		metadata: { source: "ask-demo" },
	};

	const result = await executeAskUserQuestion(params, ctx, undefined, options);
	const text = result.content.find((item) => item.type === "text")?.text ?? "Ask demo finished.";
	ctx.ui.notify(text, result.details.status === "answered" ? "info" : "warning");
}

async function runAskLast(ctx: ExtensionCommandContext, options: AskExecutionOptions): Promise<void> {
	const text = findLastAssistantText(ctx);
	if (!text) {
		ctx.ui.notify("No recent assistant text found to convert into AskUserQuestion.", "warning");
		return;
	}
	const questions = extractQuestions(text);
	if (questions.length === 0) {
		ctx.ui.notify("No clear questions found in the most recent assistant text.", "warning");
		return;
	}
	const result = await executeAskUserQuestion({ questions, metadata: { source: "ask-last" } }, ctx, undefined, options);
	const resultText = result.content.find((item) => item.type === "text")?.text ?? "Ask-last finished.";
	ctx.ui.notify(resultText, result.details.status === "answered" ? "info" : "warning");
}

function findLastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (const entry of [...branch].reverse()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		const parts = message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text.trim())
			.filter(Boolean);
		if (parts.length > 0) return parts.join("\n\n");
	}
	return undefined;
}

function extractQuestions(text: string): AskUserQuestionParams["questions"] {
	const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
	const questions: AskUserQuestionParams["questions"] = [];
	for (let index = 0; index < lines.length && questions.length < 4; index++) {
		const question = cleanQuestionLine(lines[index]);
		if (!question) continue;
		const options: string[] = [];
		for (let cursor = index + 1; cursor < lines.length && options.length < 4; cursor++) {
			const option = cleanOptionLine(lines[cursor]);
			if (option) options.push(option);
			else if (options.length > 0 || cleanQuestionLine(lines[cursor])) break;
		}
		const normalizedOptions = options.length >= 2 ? options : ["Yes", "No"];
		questions.push({
			question,
			header: deriveHeader(question, questions.length),
			options: normalizedOptions.slice(0, 4).map((option) => ({ label: option, description: option })),
		});
	}
	return questions;
}

function cleanQuestionLine(line: string): string | undefined {
	const cleaned = line.replace(/^[-*•\d.)\s]+/u, "").trim();
	if (!cleaned.endsWith("?")) return undefined;
	if (cleaned.length < 6) return undefined;
	return cleaned;
}

function cleanOptionLine(line: string): string | undefined {
	const match = line.match(/^(?:[-*•]\s+|\d+[.)]\s+|[A-Da-d][.)]\s+|\[[ xX]\]\s+)(.+)$/u);
	if (!match) return undefined;
	const option = match[1].trim().replace(/\s+$/u, "");
	if (!option || option.endsWith("?")) return undefined;
	return option.slice(0, 120);
}

function deriveHeader(question: string, index: number): string {
	const cleaned = question
		.replace(/[?!.]+$/u, "")
		.replace(/^(which|what|how|should|do|does|would|could|can)\s+/iu, "")
		.trim();
	return cleaned.split(/\s+/u).filter(Boolean).slice(0, 2).join(" ").slice(0, 12) || `Q${index + 1}`;
}
