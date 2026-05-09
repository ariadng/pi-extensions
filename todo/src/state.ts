import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cloneTasks, cloneTodos, countInProgress, isAllCompleted } from "./format.js";
import type {
	Task,
	TaskAction,
	TaskDetails,
	TaskStateEntryData,
	TaskToolName,
	TodoConfig,
	TodoExtensionState,
	TodoItem,
	TodoMode,
	TodoStateEntryData,
	TodoWriteDetails,
} from "./types.js";

export const TODO_DETAILS_VERSION = 1;
export const TODO_SOURCE = "pi-todo";
export const TODO_WRITE_TOOL_NAME = "TodoWrite";
export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";
export const TASK_GET_TOOL_NAME = "TaskGet";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TASK_TOOL_NAMES = [
	TASK_CREATE_TOOL_NAME,
	TASK_UPDATE_TOOL_NAME,
	TASK_GET_TOOL_NAME,
	TASK_LIST_TOOL_NAME,
] as const;
export const TODO_STATE_CUSTOM_TYPE = "pi-todo-state";
export const TASK_STATE_CUSTOM_TYPE = "pi-todo-task-state";

export function createTodoState(config: TodoConfig): TodoExtensionState {
	return {
		mode: config.mode,
		todos: [],
		tasks: [],
		nextTaskId: 1,
		expanded: false,
		widgetVisible: config.widgetVisible,
		strict: config.strict,
		reminders: config.reminders,
		backend: config.backend,
		completedDisplayTodos: [],
		taskCompletedAt: {},
	};
}

export function cloneStateTodos(state: TodoExtensionState): TodoItem[] {
	return cloneTodos(state.todos);
}

export function cloneStateTasks(state: TodoExtensionState): Task[] {
	return cloneTasks(state.tasks);
}

export function resetCompletedDisplay(state: TodoExtensionState): void {
	state.lastCompletedAt = undefined;
	state.completedDisplayTodos = [];
}

export function applyTodoWriteSnapshot(state: TodoExtensionState, activeTodos: readonly TodoItem[]): void {
	state.todos = cloneTodos(activeTodos);
	resetCompletedDisplay(state);
}

export function setTodosFromSubmission(
	state: TodoExtensionState,
	submittedTodos: readonly TodoItem[],
): { activeTodos: TodoItem[]; completedDisplayTodos: TodoItem[] } {
	const submitted = cloneTodos(submittedTodos);
	const activeTodos = isAllCompleted(submitted) ? [] : submitted;

	state.todos = cloneTodos(activeTodos);
	if (activeTodos.length === 0 && submitted.length > 0) {
		state.lastCompletedAt = Date.now();
		state.completedDisplayTodos = submitted;
	} else {
		resetCompletedDisplay(state);
	}

	return { activeTodos: cloneTodos(activeTodos), completedDisplayTodos: cloneTodos(state.completedDisplayTodos) };
}

export function setActiveTodos(state: TodoExtensionState, todos: readonly TodoItem[]): void {
	state.todos = cloneTodos(todos);
	resetCompletedDisplay(state);
}

export function clearActiveTodos(state: TodoExtensionState): void {
	state.todos = [];
	resetCompletedDisplay(state);
}

export function setTasks(state: TodoExtensionState, tasks: readonly Task[], nextTaskId?: number): void {
	state.tasks = cloneTasks(tasks);
	if (nextTaskId !== undefined) state.nextTaskId = Math.max(1, nextTaskId);
}

export function clearTasks(state: TodoExtensionState): void {
	state.tasks = [];
	state.nextTaskId = Math.max(1, state.nextTaskId);
}

export function getInvariantWarnings(todos: readonly TodoItem[]): string[] {
	const warnings: string[] = [];
	const seenContent = new Set<string>();
	const duplicateContent = new Set<string>();

	for (const todo of todos) {
		const normalizedContent = todo.content.trim();
		if (normalizedContent.length === 0) warnings.push("TodoWrite item has empty content.");
		if (todo.activeForm.trim().length === 0) warnings.push(`TodoWrite item "${todo.content}" has empty activeForm.`);

		const key = normalizedContent.toLowerCase();
		if (key.length > 0) {
			if (seenContent.has(key)) duplicateContent.add(normalizedContent);
			seenContent.add(key);
		}
	}

	for (const duplicate of duplicateContent) {
		warnings.push(`TodoWrite has duplicate content: "${duplicate}".`);
	}

	const inProgressCount = countInProgress(todos);
	if (inProgressCount > 1) {
		warnings.push(`TodoWrite has ${inProgressCount} in_progress items; keep exactly one task in_progress when possible.`);
	}

	const pendingCount = todos.filter((todo) => todo.status === "pending").length;
	if (todos.length > 0 && pendingCount > 0 && inProgressCount === 0) {
		warnings.push("TodoWrite has pending items but no in_progress item; mark the current task in_progress when work begins.");
	}

	return dedupeWarnings(warnings);
}

export function getStrictTodoErrors(todos: readonly TodoItem[]): string[] {
	const errors: string[] = [];
	for (const todo of todos) {
		if (todo.content.trim().length === 0) errors.push("TodoWrite strict mode: content must not be empty.");
		if (todo.activeForm.trim().length === 0) {
			errors.push(`TodoWrite strict mode: activeForm must not be empty for "${todo.content}".`);
		}
	}

	const inProgressCount = countInProgress(todos);
	if (inProgressCount > 1) {
		errors.push(`TodoWrite strict mode: expected at most one in_progress item, got ${inProgressCount}.`);
	}

	return dedupeWarnings(errors);
}

function dedupeWarnings(warnings: readonly string[]): string[] {
	return [...new Set(warnings)];
}

export function createTodoWriteDetails(params: {
	oldTodos: readonly TodoItem[];
	submittedTodos: readonly TodoItem[];
	activeTodos: readonly TodoItem[];
	invariantWarnings: readonly string[];
}): TodoWriteDetails {
	return {
		version: TODO_DETAILS_VERSION,
		source: TODO_SOURCE,
		tool: TODO_WRITE_TOOL_NAME,
		oldTodos: cloneTodos(params.oldTodos),
		submittedTodos: cloneTodos(params.submittedTodos),
		activeTodos: cloneTodos(params.activeTodos),
		invariantWarnings: [...params.invariantWarnings],
		timestamp: new Date().toISOString(),
	};
}

export function isTodoWriteDetails(value: unknown): value is TodoWriteDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<TodoWriteDetails>;
	return (
		details.version === TODO_DETAILS_VERSION &&
		details.source === TODO_SOURCE &&
		details.tool === TODO_WRITE_TOOL_NAME &&
		Array.isArray(details.activeTodos)
	);
}

export function createTodoStateEntryData(action: TodoStateEntryData["action"], activeTodos: readonly TodoItem[]): TodoStateEntryData {
	return {
		version: TODO_DETAILS_VERSION,
		source: TODO_SOURCE,
		action,
		activeTodos: cloneTodos(activeTodos),
		timestamp: new Date().toISOString(),
	};
}

export function isTodoStateEntryData(value: unknown): value is TodoStateEntryData {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<TodoStateEntryData>;
	return (
		data.version === TODO_DETAILS_VERSION &&
		data.source === TODO_SOURCE &&
		(data.action === "clear" || data.action === "set") &&
		Array.isArray(data.activeTodos)
	);
}

export function createTaskDetails(params: {
	tool: TaskToolName;
	action: TaskAction;
	before?: readonly Task[];
	after: readonly Task[];
	nextTaskId: number;
	output?: unknown;
	invariantWarnings?: readonly string[];
}): TaskDetails {
	return {
		version: TODO_DETAILS_VERSION,
		source: TODO_SOURCE,
		tool: params.tool,
		action: params.action,
		before: params.before ? cloneTasks(params.before) : undefined,
		after: cloneTasks(params.after),
		nextTaskId: params.nextTaskId,
		output: params.output,
		invariantWarnings: params.invariantWarnings ? [...params.invariantWarnings] : undefined,
		timestamp: new Date().toISOString(),
	};
}

export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<TaskDetails>;
	return (
		details.version === TODO_DETAILS_VERSION &&
		details.source === TODO_SOURCE &&
		isTaskToolName(details.tool) &&
		Array.isArray(details.after) &&
		typeof details.nextTaskId === "number"
	);
}

export function createTaskStateEntryData(
	action: TaskStateEntryData["action"],
	tasks: readonly Task[],
	nextTaskId: number,
): TaskStateEntryData {
	return {
		version: TODO_DETAILS_VERSION,
		source: TODO_SOURCE,
		action,
		tasks: cloneTasks(tasks),
		nextTaskId,
		timestamp: new Date().toISOString(),
	};
}

export function isTaskStateEntryData(value: unknown): value is TaskStateEntryData {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<TaskStateEntryData>;
	return (
		data.version === TODO_DETAILS_VERSION &&
		data.source === TODO_SOURCE &&
		(data.action === "clear" || data.action === "set") &&
		Array.isArray(data.tasks) &&
		typeof data.nextTaskId === "number"
	);
}

export function isTaskToolName(value: unknown): value is TaskToolName {
	return typeof value === "string" && TASK_TOOL_NAMES.includes(value as TaskToolName);
}

export function reconstructState(ctx: ExtensionContext, state: TodoExtensionState): void {
	state.todos = [];
	state.tasks = [];
	state.nextTaskId = 1;
	state.taskCompletedAt = {};
	resetCompletedDisplay(state);

	for (const entry of ctx.sessionManager.getBranch()) {
		if (state.mode === "todowrite") {
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role !== "toolResult" || message.toolName !== TODO_WRITE_TOOL_NAME) continue;
				if (!isTodoWriteDetails(message.details)) continue;

				state.todos = cloneTodos(message.details.activeTodos);
				continue;
			}

			if (entry.type === "custom" && entry.customType === TODO_STATE_CUSTOM_TYPE && isTodoStateEntryData(entry.data)) {
				state.todos = cloneTodos(entry.data.activeTodos);
			}
			continue;
		}

		if (state.mode === "tasks") {
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role !== "toolResult" || !isTaskToolName(message.toolName)) continue;
				if (!isTaskDetails(message.details)) continue;

				state.tasks = cloneTasks(message.details.after);
				state.nextTaskId = Math.max(1, message.details.nextTaskId);
				for (const task of state.tasks) {
					if (task.status === "completed" && state.taskCompletedAt[task.id] === undefined) state.taskCompletedAt[task.id] = 0;
				}
				continue;
			}

			if (entry.type === "custom" && entry.customType === TASK_STATE_CUSTOM_TYPE && isTaskStateEntryData(entry.data)) {
				state.tasks = cloneTasks(entry.data.tasks);
				state.nextTaskId = Math.max(1, entry.data.nextTaskId);
				for (const task of state.tasks) {
					if (task.status === "completed" && state.taskCompletedAt[task.id] === undefined) state.taskCompletedAt[task.id] = 0;
				}
			}
		}
	}
}

export function normalizeMode(value: string | undefined): TodoMode | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "todowrite" || normalized === "tasks" || normalized === "off") return normalized;
	return undefined;
}
