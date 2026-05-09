import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { countCompleted, formatCounts } from "./format.js";
import type { Task, TodoExtensionState, TodoItem, TodoStatus } from "./types.js";

const STATUS_KEY = "pi-todo";
const WIDGET_KEY = "pi-todo";
const DONE_DISPLAY_MS = 5_000;
const RECENT_TASK_COMPLETED_MS = 30_000;
const DEFAULT_TASK_DISPLAY_LIMIT = 10;
const DEFAULT_WIDGET_WIDTH = 100;

let doneDisplayTimer: ReturnType<typeof setTimeout> | undefined;

export function updateTodoUI(ctx: ExtensionContext, state: TodoExtensionState): void {
	if (!ctx.hasUI) return;

	if (state.mode === "tasks") {
		if (!state.widgetVisible || state.tasks.length === 0) {
			clearTodoUI(ctx);
			return;
		}
		if (state.tasks.every((task) => task.status === "completed")) {
			if (isDoneDisplayFresh(state)) {
				setCompletedTaskUI(ctx, state);
				scheduleDoneDisplayClear(ctx, state);
			} else {
				clearTodoUI(ctx);
			}
			return;
		}
		clearDoneDisplayTimer();
		setTaskUI(ctx, state);
		return;
	}

	if (state.mode !== "todowrite" || !state.widgetVisible) {
		clearTodoUI(ctx);
		return;
	}

	if (state.todos.length > 0) {
		clearDoneDisplayTimer();
		setActiveTodoUI(ctx, state);
		return;
	}

	if (state.completedDisplayTodos.length > 0 && isDoneDisplayFresh(state)) {
		setCompletedTodoUI(ctx, state.completedDisplayTodos);
		scheduleDoneDisplayClear(ctx, state);
		return;
	}

	clearTodoUI(ctx);
}

export function clearTodoUI(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function updateTodoWorkingMessage(ctx: ExtensionContext, state: TodoExtensionState): void {
	if (!ctx.hasUI) return;
	if (state.mode === "todowrite") {
		const current = state.todos.find((todo) => todo.status === "in_progress");
		if (current) {
			ctx.ui.setWorkingMessage(current.activeForm || current.content);
		} else {
			ctx.ui.setWorkingMessage();
		}
		return;
	}

	if (state.mode === "tasks") {
		const current = state.tasks.find((task) => task.status === "in_progress");
		if (current) {
			ctx.ui.setWorkingMessage(current.activeForm || current.subject);
		} else {
			ctx.ui.setWorkingMessage();
		}
		return;
	}

	ctx.ui.setWorkingMessage();
}

export function clearTodoWorkingMessage(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWorkingMessage();
}

export function toggleTodoWidget(ctx: ExtensionContext, state: TodoExtensionState): void {
	if (state.mode === "off") {
		ctx.ui.notify("pi-todo is disabled.", "warning");
		return;
	}

	const hasItems = state.mode === "tasks" ? state.tasks.length > 0 : state.todos.length > 0 || state.completedDisplayTodos.length > 0;
	if (!hasItems) {
		ctx.ui.notify(state.mode === "tasks" ? "No tasks to show." : "No todos to show.", "info");
		return;
	}

	if (!state.widgetVisible) {
		state.widgetVisible = true;
		state.expanded = false;
		ctx.ui.notify("Todo widget shown.", "info");
	} else if (!state.expanded) {
		state.expanded = true;
		ctx.ui.notify("Todo widget expanded.", "info");
	} else {
		state.widgetVisible = false;
		state.expanded = false;
		ctx.ui.notify("Todo widget hidden.", "info");
	}

	updateTodoUI(ctx, state);
}

function setActiveTodoUI(ctx: ExtensionContext, state: TodoExtensionState): void {
	const todos = state.todos;
	const completed = countCompleted(todos);
	const total = todos.length;
	const inProgress = todos.find((todo) => todo.status === "in_progress");
	const statusColor = inProgress ? "accent" : "muted";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(statusColor, `todo: ${completed}/${total}`));
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(todos, ctx.ui.theme, state.expanded));
}

function setCompletedTodoUI(ctx: ExtensionContext, todos: readonly TodoItem[]): void {
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "todo: done"));
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(todos, ctx.ui.theme, false, true));
}

function setTaskUI(ctx: ExtensionContext, state: TodoExtensionState): void {
	const completed = state.tasks.filter((task) => task.status === "completed").length;
	const total = state.tasks.length;
	const inProgress = state.tasks.find((task) => task.status === "in_progress");
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(inProgress ? "accent" : "muted", `tasks: ${completed}/${total}`));
	ctx.ui.setWidget(WIDGET_KEY, buildTaskWidgetLines(state, ctx.ui.theme));
}

function setCompletedTaskUI(ctx: ExtensionContext, state: TodoExtensionState): void {
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "tasks: done"));
	ctx.ui.setWidget(WIDGET_KEY, buildTaskWidgetLines(state, ctx.ui.theme, true));
}

function buildWidgetLines(
	todos: readonly TodoItem[],
	theme: Theme,
	expanded: boolean,
	completedSnapshot = false,
): string[] {
	const completed = countCompleted(todos);
	const maxItems = expanded ? todos.length : 6;
	const visibleTodos = todos.slice(0, maxItems);
	const lines = [theme.fg(completedSnapshot ? "success" : "muted", `Todos ${formatCounts(todos)}`)];

	for (const todo of visibleTodos) {
		lines.push(formatWidgetTodo(todo, theme));
	}

	if (visibleTodos.length < todos.length) {
		lines.push(theme.fg("dim", `… +${todos.length - visibleTodos.length} more`));
	}

	return lines;
}

function formatWidgetTodo(todo: TodoItem, theme: Theme): string {
	const marker = markerForStatus(todo.status, theme);
	const content = todo.status === "completed" ? theme.fg("dim", theme.strikethrough(todo.content)) : todo.content;
	return `${marker} ${content}`;
}

function buildTaskWidgetLines(state: TodoExtensionState, theme: Theme, completedSnapshot = false): string[] {
	const tasks = state.tasks;
	const completed = tasks.filter((task) => task.status === "completed").length;
	const maxItems = state.expanded ? DEFAULT_TASK_DISPLAY_LIMIT : Math.min(6, DEFAULT_TASK_DISPLAY_LIMIT);
	const visibleTasks = sortTasksForWidget(tasks, state).slice(0, maxItems);
	const lines = [theme.fg(completedSnapshot ? "success" : "muted", `Tasks ${completed}/${tasks.length}`)];

	for (const task of visibleTasks) {
		lines.push(formatTaskWidgetLine(task, tasks, theme));
	}

	if (visibleTasks.length < tasks.length) {
		lines.push(theme.fg("dim", summarizeHiddenTasks(tasks.slice(visibleTasks.length))));
	}

	return lines;
}

function formatTaskWidgetLine(task: Task, allTasks: readonly Task[], theme: Theme): string {
	const marker = markerForStatus(task.status, theme);
	const subject = task.status === "completed" ? theme.fg("dim", theme.strikethrough(task.subject)) : task.subject;
	const blockers = unresolvedBlockers(task, allTasks);
	const blockedBy = blockers.length > 0 ? theme.fg("warning", ` blocked by ${blockers.map((id) => `#${id}`).join(", ")}`) : "";
	const owner = task.owner ? theme.fg("dim", ` @${task.owner}`) : "";
	const line = `${marker} ${theme.fg("accent", `#${task.id}`)} ${subject}${owner}${blockedBy}`;
	return truncateToWidth(line, DEFAULT_WIDGET_WIDTH);
}

function summarizeHiddenTasks(tasks: readonly Task[]): string {
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const parts = [
		formatHiddenCount(counts.get("in_progress") ?? 0, "in progress"),
		formatHiddenCount(counts.get("pending") ?? 0, "pending"),
		formatHiddenCount(counts.get("completed") ?? 0, "completed"),
	].filter((part): part is string => Boolean(part));
	return `… +${tasks.length}${parts.length > 0 ? ` ${parts.join(", ")}` : ""}`;
}

function formatHiddenCount(count: number, label: string): string | undefined {
	return count > 0 ? `${count} ${label}` : undefined;
}

function sortTasksForWidget(tasks: readonly Task[], state: TodoExtensionState): Task[] {
	return [...tasks].sort((a, b) => taskSortRank(a, tasks, state) - taskSortRank(b, tasks, state) || Number(a.id) - Number(b.id));
}

function taskSortRank(task: Task, allTasks: readonly Task[], state: TodoExtensionState): number {
	if (task.status === "completed" && isRecentlyCompleted(task, state)) return 0;
	if (task.status === "in_progress") return 1;
	if (task.status === "pending" && unresolvedBlockers(task, allTasks).length === 0) return 2;
	if (task.status === "pending") return 3;
	return 4;
}

function isRecentlyCompleted(task: Task, state: TodoExtensionState): boolean {
	const completedAt = state.taskCompletedAt[task.id];
	return completedAt !== undefined && completedAt > 0 && Date.now() - completedAt <= RECENT_TASK_COMPLETED_MS;
}

function unresolvedBlockers(task: Task, allTasks: readonly Task[]): string[] {
	return task.blockedBy.filter((id) => allTasks.find((candidate) => candidate.id === id)?.status !== "completed");
}

function markerForStatus(status: TodoStatus, theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "in_progress":
			return theme.fg("accent", "●");
		case "pending":
			return theme.fg("dim", "○");
	}
}

function isDoneDisplayFresh(state: TodoExtensionState): boolean {
	return state.lastCompletedAt !== undefined && Date.now() - state.lastCompletedAt < DONE_DISPLAY_MS;
}

function scheduleDoneDisplayClear(ctx: ExtensionContext, state: TodoExtensionState): void {
	clearDoneDisplayTimer();
	const marker = state.lastCompletedAt;
	doneDisplayTimer = setTimeout(() => {
		const activeTodoList = state.mode === "todowrite" && state.todos.length > 0;
		const activeTaskList = state.mode === "tasks" && state.tasks.some((task) => task.status !== "completed");
		if (state.lastCompletedAt !== marker || activeTodoList || activeTaskList) return;
		state.lastCompletedAt = undefined;
		state.completedDisplayTodos = [];
		clearTodoUI(ctx);
	}, DONE_DISPLAY_MS);
}

function clearDoneDisplayTimer(): void {
	if (doneDisplayTimer !== undefined) {
		clearTimeout(doneDisplayTimer);
		doneDisplayTimer = undefined;
	}
}
