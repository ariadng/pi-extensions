import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { cloneTasks, formatCounts, formatTaskListPlain, formatTodoListPlain, isAllCompleted } from "./format.js";
import {
	clearActiveTodos,
	clearTasks,
	createTaskStateEntryData,
	createTodoStateEntryData,
	getStrictTodoErrors,
	reconstructState,
	setActiveTodos,
	setTasks,
	TASK_STATE_CUSTOM_TYPE,
	TODO_STATE_CUSTOM_TYPE,
} from "./state.js";
import type { TaskFileBackend } from "./backend.js";
import type { Task, TodoExtensionState, TodoItem, TodoMode, TodoStatus } from "./types.js";
import { clearTodoUI, toggleTodoWidget, updateTodoUI, updateTodoWorkingMessage } from "./ui.js";

class TodoListComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly state: TodoExtensionState,
		private readonly theme: Theme,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") this.onClose();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];
		lines.push("");
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "───") + th.fg("accent", th.bold(this.state.mode === "tasks" ? " Tasks " : " Todos ")) + th.fg("borderMuted", "─".repeat(Math.max(0, width - 12))),
				width,
			),
		);
		lines.push("");

		if (this.state.mode === "tasks") renderTasksInto(lines, this.state.tasks, th, width);
		else renderTodosInto(lines, this.state.todos, th, width);

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Esc/q close • /todo hide • /todo clear")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

interface TodoCommandOptions {
	setMode?: (mode: TodoMode, ctx: ExtensionContext) => Promise<void> | void;
	taskBackend?: TaskFileBackend;
}

export function registerTodoCommands(pi: ExtensionAPI, state: TodoExtensionState, options: TodoCommandOptions = {}): void {
	pi.registerCommand("todo", {
		description: "Show or manage TodoWrite/task state: /todo [list|show|hide|expand|collapse|clear|strict|mode|export|import]",
		handler: async (args, ctx) => {
			reconstructState(ctx, state);
			if (state.mode === "tasks") options.taskBackend?.refresh(ctx, state);
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const command = tokens[0]?.toLowerCase() ?? "view";
			const rest = tokens.slice(1).join(" ");

			if (command === "strict") {
				handleStrict(rest, ctx, state);
				return;
			}

			if (command === "mode") {
				await handleMode(rest, ctx, state, options);
				return;
			}

			if (state.mode === "off") {
				clearTodoUI(ctx);
				ctx.ui.notify("pi-todo is disabled for this run.", "info");
				return;
			}

			switch (command) {
				case "view":
				case "open":
					await showTodoView(ctx, state);
					return;

				case "list":
					ctx.ui.notify(state.mode === "tasks" ? formatTaskListPlain(state.tasks) : formatTodoListPlain(state.todos), "info");
					return;

				case "show":
					state.widgetVisible = true;
					state.expanded = false;
					updateTodoUI(ctx, state);
					ctx.ui.notify("Todo widget shown.", "info");
					return;

				case "hide":
					state.widgetVisible = false;
					state.expanded = false;
					updateTodoUI(ctx, state);
					ctx.ui.notify("Todo widget hidden.", "info");
					return;

				case "expand":
					state.widgetVisible = true;
					state.expanded = true;
					updateTodoUI(ctx, state);
					ctx.ui.notify("Todo widget expanded.", "info");
					return;

				case "collapse":
					state.widgetVisible = true;
					state.expanded = false;
					updateTodoUI(ctx, state);
					ctx.ui.notify("Todo widget collapsed.", "info");
					return;

				case "toggle":
					toggleTodoWidget(ctx, state);
					return;

				case "clear":
					await handleClear(pi, rest, ctx, state, options.taskBackend);
					return;

				case "export":
					handleExport(rest, ctx, state);
					return;

				case "import":
					await handleImport(pi, rest, ctx, state, options.taskBackend);
					return;

				default:
					ctx.ui.notify("Usage: /todo [list|show|hide|expand|collapse|clear|strict|mode|export|import]", "warning");
			}
		},
	});
}

function handleStrict(args: string, ctx: ExtensionContext, state: TodoExtensionState): void {
	const value = args.trim().toLowerCase();
	if (!value) {
		ctx.ui.notify(`Todo strict mode is ${state.strict ? "on" : "off"}.`, "info");
		return;
	}
	if (value !== "on" && value !== "off") {
		ctx.ui.notify("Usage: /todo strict [on|off]", "warning");
		return;
	}
	state.strict = value === "on";
	ctx.ui.notify(`Todo strict mode ${state.strict ? "enabled" : "disabled"}.`, "info");
}

async function handleMode(
	args: string,
	ctx: ExtensionContext,
	state: TodoExtensionState,
	options: TodoCommandOptions,
): Promise<void> {
	const value = args.trim().toLowerCase();
	if (!value) {
		ctx.ui.notify(`pi-todo mode: ${state.mode}. Use /todo mode todowrite|tasks|off. Task backend: ${state.backend}.`, "info");
		return;
	}
	if (value !== "todowrite" && value !== "tasks" && value !== "off") {
		ctx.ui.notify("Usage: /todo mode [todowrite|tasks|off]", "warning");
		return;
	}
	await options.setMode?.(value, ctx);
	updateTodoUI(ctx, state);
	updateTodoWorkingMessage(ctx, state);
	ctx.ui.notify(`pi-todo mode set to ${value}.`, "info");
}

async function handleClear(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionContext,
	state: TodoExtensionState,
	backend?: TaskFileBackend,
): Promise<void> {
	const target = args.trim().toLowerCase() || "all";
	if (target !== "all" && target !== "completed") {
		ctx.ui.notify("Usage: /todo clear [completed|all]", "warning");
		return;
	}

	if (state.mode === "tasks") {
		await mutateTasks(ctx, state, backend, () => {
			if (target === "completed") {
				const completedIds = new Set(state.tasks.filter((task) => task.status === "completed").map((task) => task.id));
				state.tasks = state.tasks
					.filter((task) => !completedIds.has(task.id))
					.map((task) => ({
						...task,
						blocks: task.blocks.filter((id) => !completedIds.has(id)),
						blockedBy: task.blockedBy.filter((id) => !completedIds.has(id)),
					}));
				for (const id of completedIds) delete state.taskCompletedAt[id];
			} else {
				clearTasks(state);
				state.taskCompletedAt = {};
			}
			pi.appendEntry(TASK_STATE_CUSTOM_TYPE, createTaskStateEntryData(target === "completed" ? "set" : "clear", state.tasks, state.nextTaskId));
		});
	} else {
		if (target === "completed") setActiveTodos(state, state.todos.filter((todo) => todo.status !== "completed"));
		else clearActiveTodos(state);
		pi.appendEntry(TODO_STATE_CUSTOM_TYPE, createTodoStateEntryData(target === "completed" ? "set" : "clear", state.todos));
	}

	updateTodoUI(ctx, state);
	updateTodoWorkingMessage(ctx, state);
	ctx.ui.notify(target === "completed" ? "Completed items cleared for this branch." : "Todo/task list cleared for this branch.", "info");
}

function handleExport(args: string, ctx: ExtensionContext, state: TodoExtensionState): void {
	const file = resolve(ctx.cwd, args.trim() || (state.mode === "tasks" ? "TASKS.md" : "TODO.md"));
	const markdown = state.mode === "tasks" ? exportTasksMarkdown(state.tasks) : exportTodosMarkdown(state.todos);
	try {
		writeFileSync(file, markdown, "utf8");
	} catch (error) {
		ctx.ui.notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	ctx.ui.notify(`Exported ${state.mode === "tasks" ? state.tasks.length : state.todos.length} item(s) to ${file}`, "info");
}

async function handleImport(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionContext,
	state: TodoExtensionState,
	backend?: TaskFileBackend,
): Promise<void> {
	const input = args.trim();
	if (!input) {
		ctx.ui.notify("Usage: /todo import <file>", "warning");
		return;
	}

	const file = resolve(ctx.cwd, input);
	let markdown: string;
	try {
		markdown = readFileSync(file, "utf8");
	} catch (error) {
		ctx.ui.notify(`Import failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const todos = parseMarkdownTodos(markdown);

	if (state.mode === "tasks") {
		await mutateTasks(ctx, state, backend, () => {
			const importedTasks = todos.map<Task>((todo) => ({
				id: String(state.nextTaskId++),
				subject: todo.content,
				description: todo.content,
				activeForm: todo.activeForm,
				status: todo.status,
				blocks: [],
				blockedBy: [],
			}));
			state.taskCompletedAt = Object.fromEntries(
				importedTasks.filter((task) => task.status === "completed").map((task) => [task.id, Date.now()]),
			);
			setTasks(state, importedTasks, state.nextTaskId);
			pi.appendEntry(TASK_STATE_CUSTOM_TYPE, createTaskStateEntryData("set", state.tasks, state.nextTaskId));
		});
	} else {
		if (state.strict) {
			const strictErrors = getStrictTodoErrors(todos);
			if (strictErrors.length > 0) {
				ctx.ui.notify(strictErrors.join(" "), "error");
				return;
			}
		}
		setActiveTodos(state, isAllCompleted(todos) ? [] : todos);
		pi.appendEntry(TODO_STATE_CUSTOM_TYPE, createTodoStateEntryData("set", state.todos));
	}

	updateTodoUI(ctx, state);
	updateTodoWorkingMessage(ctx, state);
	ctx.ui.notify(`Imported ${todos.length} item(s) from ${file}`, "info");
}

async function mutateTasks(
	ctx: ExtensionContext,
	state: TodoExtensionState,
	backend: TaskFileBackend | undefined,
	fn: () => void,
): Promise<void> {
	if (backend?.isEnabled(state)) await backend.withMutation(ctx, state, fn);
	else fn();
}

async function showTodoView(ctx: ExtensionContext, state: TodoExtensionState): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(state.mode === "tasks" ? formatTaskListPlain(state.tasks) : formatTodoListPlain(state.todos), "info");
		return;
	}

	let factoryInvoked = false;
	await ctx.ui.custom<"closed" | undefined>((_tui, theme, _keybindings, done) => {
		factoryInvoked = true;
		return new TodoListComponent(state, theme, () => done("closed"));
	});

	if (!factoryInvoked) ctx.ui.notify(state.mode === "tasks" ? formatTaskListPlain(state.tasks) : formatTodoListPlain(state.todos), "info");
}

function renderTodosInto(lines: string[], todos: readonly TodoItem[], theme: Theme, width: number): void {
	if (todos.length === 0) {
		lines.push(truncateToWidth(`  ${theme.fg("dim", "No active todos on this branch.")}`, width));
		return;
	}
	lines.push(truncateToWidth(`  ${theme.fg("muted", `${formatCounts(todos)} completed`)}`, width));
	lines.push("");
	for (const todo of todos) {
		lines.push(truncateToWidth(`  ${markerForStatus(todo.status, theme)} ${formatTodoContent(todo, theme)}`, width));
		if (todo.status === "in_progress") lines.push(truncateToWidth(`    ${theme.fg("dim", todo.activeForm)}`, width));
	}
}

function renderTasksInto(lines: string[], tasks: readonly Task[], theme: Theme, width: number): void {
	if (tasks.length === 0) {
		lines.push(truncateToWidth(`  ${theme.fg("dim", "No tasks on this branch.")}`, width));
		return;
	}
	const completed = tasks.filter((task) => task.status === "completed").length;
	lines.push(truncateToWidth(`  ${theme.fg("muted", `${completed}/${tasks.length} completed`)}`, width));
	lines.push("");
	for (const task of tasks) {
		const blockers = task.blockedBy.length > 0 ? theme.fg("warning", ` blocked by ${task.blockedBy.map((id) => `#${id}`).join(",")}`) : "";
		lines.push(truncateToWidth(`  ${markerForStatus(task.status, theme)} ${theme.fg("accent", `#${task.id}`)} ${formatTaskContent(task, theme)}${blockers}`, width));
		if (task.status === "in_progress" && task.activeForm) lines.push(truncateToWidth(`    ${theme.fg("dim", task.activeForm)}`, width));
	}
}

function exportTodosMarkdown(todos: readonly TodoItem[]): string {
	return ["# TODO", "", ...todos.map(formatTodoMarkdownLine), ""].join("\n");
}

function exportTasksMarkdown(tasks: readonly Task[]): string {
	return ["# Tasks", "", ...tasks.map((task) => formatTodoMarkdownLine({ content: task.subject, status: task.status, activeForm: task.activeForm ?? deriveActiveForm(task.subject) })), ""].join("\n");
}

function formatTodoMarkdownLine(todo: TodoItem): string {
	const box = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "-" : " ";
	const active = todo.activeForm ? ` <!-- activeForm: ${escapeComment(todo.activeForm)} -->` : "";
	return `- [${box}] ${todo.content}${active}`;
}

function parseMarkdownTodos(markdown: string): TodoItem[] {
	const todos: TodoItem[] = [];
	for (const rawLine of markdown.split(/\r?\n/)) {
		const line = rawLine.trim();
		const match = line.match(/^(?:[-*]|\d+[.)])\s+(?:\[([ xX-])\]\s*)?(.+)$/);
		if (!match) continue;
		const marker = match[1];
		let content = (match[2] ?? "").trim();
		const activeMatch = content.match(/<!--\s*activeForm:\s*(.*?)\s*-->$/);
		const activeForm = activeMatch?.[1]?.trim();
		content = content.replace(/\s*<!--.*?-->\s*$/g, "").trim();
		if (!content) continue;
		const status: TodoStatus = marker?.toLowerCase() === "x" ? "completed" : marker === "-" ? "in_progress" : "pending";
		todos.push({ content, status, activeForm: activeForm || deriveActiveForm(content) });
	}
	return todos;
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

function formatTodoContent(todo: TodoItem, theme: Theme): string {
	if (todo.status === "completed") return theme.fg("dim", theme.strikethrough(todo.content));
	if (todo.status === "in_progress") return theme.fg("text", todo.content);
	return theme.fg("muted", todo.content);
}

function formatTaskContent(task: Task, theme: Theme): string {
	if (task.status === "completed") return theme.fg("dim", theme.strikethrough(task.subject));
	if (task.status === "in_progress") return theme.fg("text", task.subject);
	return theme.fg("muted", task.subject);
}

function deriveActiveForm(content: string): string {
	return `Working on ${content.replace(/[.!?]\s*$/, "")}`;
}

function escapeComment(value: string): string {
	return value.replace(/--/g, "—");
}
