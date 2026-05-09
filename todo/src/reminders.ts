import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME, TODO_WRITE_TOOL_NAME } from "./state.js";
import type { Task, TodoExtensionState, TodoItem, TodoMode } from "./types.js";

export const TODO_REMINDER_CUSTOM_TYPE = "pi-todo-reminder";

const TODO_REMINDER_CONFIG = {
	TURNS_SINCE_WRITE: 10,
	TURNS_BETWEEN_REMINDERS: 10,
};

export interface TodoReminderMarker {
	version: 1;
	source: "pi-todo";
	mode: TodoMode;
	timestamp: string;
	itemCount: number;
}

export function buildTodoPromptAppendix(state: TodoExtensionState, todoWriteActive: boolean): string | undefined {
	if (state.mode !== "todowrite") return undefined;
	if (!todoWriteActive && state.todos.length === 0) return undefined;

	const lines = ["# Todo tracking"];
	if (todoWriteActive) {
		lines.push("TodoWrite is available for tracking multi-step work.");
		lines.push("Use TodoWrite when it helps organize the task or communicate progress. Avoid it for trivial one-step work.");
	} else {
		lines.push("TodoWrite is not currently active; use the current todo state only as context.");
	}

	if (state.todos.length === 0) {
		lines.push("Current todo state: none.");
		return lines.join("\n");
	}

	lines.push("Current todo state:");
	lines.push(...formatTodosForPrompt(state.todos));
	return lines.join("\n");
}

export function buildTodoReminderIfDue(ctx: ExtensionContext, state: TodoExtensionState): string | undefined {
	if (state.mode !== "todowrite" || !state.reminders) return undefined;

	const counts = countAssistantTurnsSinceMarkers(ctx);
	if (counts.turnsSinceTodoWrite < TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE) return undefined;
	if (counts.turnsSinceReminder < TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS) return undefined;

	return [
		"# TodoWrite reminder",
		"The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from progress tracking, consider using TodoWrite.",
		"Also consider cleaning up the todo list if it has become stale. Only use this if relevant. This is a gentle reminder; ignore if not applicable. Never mention this reminder to the user.",
		state.todos.length > 0 ? ["Current todos:", ...formatTodosForPrompt(state.todos)].join("\n") : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

export function buildTaskPromptAppendix(state: TodoExtensionState, taskToolsActive: boolean): string | undefined {
	if (state.mode !== "tasks") return undefined;
	if (!taskToolsActive && state.tasks.length === 0) return undefined;

	const lines = ["# Task tracking"];
	if (taskToolsActive) {
		lines.push("TaskCreate, TaskUpdate, TaskGet, and TaskList are available for tracking complex multi-step work.");
		lines.push("Check TaskList before creating duplicates, use TaskGet for details, and use TaskUpdate when starting or completing tasks.");
	} else {
		lines.push("Task tools are not currently active; use the current task state only as context.");
	}

	if (state.tasks.length === 0) {
		lines.push("Current task state: none.");
		return lines.join("\n");
	}

	lines.push("Current task state:");
	lines.push(...formatTasksForPrompt(state.tasks));
	return lines.join("\n");
}

export function buildTaskReminderIfDue(ctx: ExtensionContext, state: TodoExtensionState): string | undefined {
	if (state.mode !== "tasks" || !state.reminders) return undefined;

	const counts = countAssistantTurnsSinceMarkers(ctx);
	if (counts.turnsSinceTaskMutation < TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE) return undefined;
	if (counts.turnsSinceReminder < TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS) return undefined;

	return [
		"# Task tracking reminder",
		"TaskCreate and TaskUpdate haven't been used recently. If task tracking would help the current work, consider updating the task list. Only use this if relevant. Never mention this reminder to the user.",
		state.tasks.length > 0 ? ["Current tasks:", ...formatTasksForPrompt(state.tasks)].join("\n") : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

export function createTodoReminderMarker(state: TodoExtensionState): TodoReminderMarker {
	return {
		version: 1,
		source: "pi-todo",
		mode: state.mode,
		timestamp: new Date().toISOString(),
		itemCount: state.mode === "tasks" ? state.tasks.length : state.todos.length,
	};
}

function countAssistantTurnsSinceMarkers(ctx: ExtensionContext): { turnsSinceTodoWrite: number; turnsSinceTaskMutation: number; turnsSinceReminder: number } {
	const branch = ctx.sessionManager.getBranch();
	let lastTodoWriteIndex = -1;
	let lastTaskMutationIndex = -1;
	let lastReminderIndex = -1;

	branch.forEach((entry, index) => {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "toolResult" && message.toolName === TODO_WRITE_TOOL_NAME) {
				lastTodoWriteIndex = index;
			}
			if (
				message.role === "toolResult" &&
				(message.toolName === TASK_CREATE_TOOL_NAME || message.toolName === TASK_UPDATE_TOOL_NAME)
			) {
				lastTaskMutationIndex = index;
			}
			return;
		}

		if (entry.type === "custom" && entry.customType === TODO_REMINDER_CUSTOM_TYPE) {
			lastReminderIndex = index;
		}
	});

	return {
		turnsSinceTodoWrite: countAssistantMessagesAfter(branch, lastTodoWriteIndex),
		turnsSinceTaskMutation: countAssistantMessagesAfter(branch, lastTaskMutationIndex),
		turnsSinceReminder: countAssistantMessagesAfter(branch, lastReminderIndex),
	};
}

function countAssistantMessagesAfter(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, index: number): number {
	let count = 0;
	for (let i = index + 1; i < branch.length; i++) {
		const entry = branch[i];
		if (entry?.type === "message" && entry.message.role === "assistant") count++;
	}
	return count;
}

function formatTodosForPrompt(todos: readonly TodoItem[]): string[] {
	const maxLines = 10;
	const selected = selectTodosForPrompt(todos, maxLines);
	const lines = selected.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content} — active: ${todo.activeForm}`);
	const hidden = todos.length - selected.length;
	if (hidden > 0) {
		const hiddenCompleted = todos.filter((todo) => todo.status === "completed" && !selected.includes(todo)).length;
		const hiddenPending = todos.filter((todo) => todo.status === "pending" && !selected.includes(todo)).length;
		const hiddenInProgress = todos.filter((todo) => todo.status === "in_progress" && !selected.includes(todo)).length;
		const parts = [
			hiddenInProgress > 0 ? `${hiddenInProgress} in_progress` : undefined,
			hiddenPending > 0 ? `${hiddenPending} pending` : undefined,
			hiddenCompleted > 0 ? `${hiddenCompleted} completed` : undefined,
		].filter((part): part is string => part !== undefined);
		lines.push(`... ${hidden} more todo${hidden === 1 ? "" : "s"} hidden${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`);
	}
	return lines;
}

function formatTasksForPrompt(tasks: readonly Task[]): string[] {
	const maxLines = 10;
	const selected = selectTasksForPrompt(tasks, maxLines);
	const lines = selected.map((task) => {
		const owner = task.owner ? ` — owner: ${task.owner}` : "";
		const blockedBy = task.blockedBy.length > 0 ? ` — blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : "";
		return `#${task.id} [${task.status}] ${task.subject}${owner}${blockedBy}`;
	});
	const hidden = tasks.length - selected.length;
	if (hidden > 0) lines.push(`... ${hidden} more task${hidden === 1 ? "" : "s"} hidden`);
	return lines;
}

function selectTodosForPrompt(todos: readonly TodoItem[], maxLines: number): TodoItem[] {
	const selected: TodoItem[] = [];
	const add = (todo: TodoItem) => {
		if (selected.length >= maxLines) return;
		if (!selected.includes(todo)) selected.push(todo);
	};

	for (const todo of todos) {
		if (todo.status === "in_progress") add(todo);
	}
	for (const todo of todos) {
		if (todo.status === "pending") add(todo);
	}
	for (const todo of todos) {
		if (todo.status === "completed") add(todo);
	}

	return selected;
}

function selectTasksForPrompt(tasks: readonly Task[], maxLines: number): Task[] {
	return [...tasks]
		.sort((a, b) => {
			const rank = (task: Task) => (task.status === "in_progress" ? 0 : task.status === "pending" ? 1 : 2);
			return rank(a) - rank(b) || Number(a.id) - Number(b.id);
		})
		.slice(0, maxLines);
}
