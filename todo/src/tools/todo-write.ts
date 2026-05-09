import { defineTool } from "@earendil-works/pi-coding-agent";
import { cloneTodos, formatTodoWriteResultText } from "../format.js";
import { TODO_WRITE_DESCRIPTION, TODO_WRITE_PROMPT_GUIDELINES, TODO_WRITE_PROMPT_SNIPPET } from "../prompt.js";
import { renderTodoWriteCall, renderTodoWriteResult } from "../render.js";
import { TodoWriteParamsSchema } from "../schema.js";
import {
	cloneStateTodos,
	createTodoWriteDetails,
	getInvariantWarnings,
	getStrictTodoErrors,
	setTodosFromSubmission,
	TODO_WRITE_TOOL_NAME,
} from "../state.js";
import type { TodoExtensionState, TodoWriteDetails } from "../types.js";
import { updateTodoUI, updateTodoWorkingMessage } from "../ui.js";

export function createTodoWriteTool(state: TodoExtensionState) {
	let mutationQueue = Promise.resolve();

	function withTodoMutation<T>(fn: () => Promise<T> | T): Promise<T> {
		const run = mutationQueue.then(fn, fn);
		mutationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	return defineTool<typeof TodoWriteParamsSchema, TodoWriteDetails>({
		name: TODO_WRITE_TOOL_NAME,
		label: "Todo",
		description: TODO_WRITE_DESCRIPTION,
		promptSnippet: TODO_WRITE_PROMPT_SNIPPET,
		promptGuidelines: TODO_WRITE_PROMPT_GUIDELINES,
		parameters: TodoWriteParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return withTodoMutation(async () => {
				const oldTodos = cloneStateTodos(state);
				const submittedTodos = cloneTodos(params.todos);
				if (state.strict) {
					const strictErrors = getStrictTodoErrors(submittedTodos);
					if (strictErrors.length > 0) {
						throw new Error(strictErrors.join(" "));
					}
				}

				const invariantWarnings = getInvariantWarnings(submittedTodos);
				const { activeTodos } = setTodosFromSubmission(state, submittedTodos);
				const details = createTodoWriteDetails({
					oldTodos,
					submittedTodos,
					activeTodos,
					invariantWarnings,
				});

				updateTodoUI(ctx, state);
				updateTodoWorkingMessage(ctx, state);

				return {
					content: [{ type: "text", text: formatTodoWriteResultText(details) }],
					details,
				};
			});
		},

		renderCall(args, theme) {
			return renderTodoWriteCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderTodoWriteResult(result, options, theme);
		},
	});
}
