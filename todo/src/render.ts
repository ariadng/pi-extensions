import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { countCompleted } from "./format.js";
import type { TodoWriteParams } from "./schema.js";
import type { TaskDetails, TaskToolName, TodoItem, TodoWriteDetails } from "./types.js";

export function renderTodoWriteCall(args: TodoWriteParams, theme: Theme): Text {
	const count = args.todos.length;
	return new Text(
		theme.fg("toolTitle", theme.bold("TodoWrite ")) + theme.fg("muted", `${count} item${count === 1 ? "" : "s"}`),
		0,
		0,
	);
}

export function renderTodoWriteResult(
	result: AgentToolResult<TodoWriteDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "Updating todos…"), 0, 0);
	}

	const details = result.details;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "", 0, 0);
	}

	const submitted = details.submittedTodos;
	const completed = countCompleted(submitted);
	const total = submitted.length;
	const active = details.activeTodos.length;
	let text = theme.fg("success", "✓ todos updated");
	if (total > 0) text += theme.fg("muted", ` · ${completed}/${total} complete`);
	if (total > 0 && active === 0) text += theme.fg("success", " · done");

	if (details.invariantWarnings.length > 0) {
		text += theme.fg("warning", ` · ${details.invariantWarnings.length} warning${details.invariantWarnings.length === 1 ? "" : "s"}`);
	}

	if (options.expanded && submitted.length > 0) {
		for (const todo of submitted) {
			text += `\n${renderTodoLine(todo, theme)}`;
		}
		if (details.invariantWarnings.length > 0) {
			text += "\n" + theme.fg("warning", details.invariantWarnings.join("\n"));
		}
	} else if (options.expanded && submitted.length === 0) {
		text += "\n" + theme.fg("dim", "No active todos");
	}

	return new Text(text, 0, 0);
}

export function renderTaskCall(toolName: TaskToolName, args: object, theme: Theme): Text {
	const record = args as Record<string, unknown>;
	let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
	if (typeof record.taskId === "string") text += theme.fg("accent", `#${record.taskId}`);
	else if (typeof record.subject === "string") text += theme.fg("muted", record.subject);
	else text += theme.fg("muted", "tasks");
	return new Text(text, 0, 0);
}

export function renderTaskResult(
	result: AgentToolResult<TaskDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", "Updating tasks…"), 0, 0);

	const details = result.details;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "", 0, 0);
	}

	const completed = details.after.filter((task) => task.status === "completed").length;
	let text = theme.fg("success", `✓ ${details.tool}`) + theme.fg("muted", ` · ${completed}/${details.after.length} complete`);
	if (details.invariantWarnings && details.invariantWarnings.length > 0) {
		text += theme.fg("warning", ` · ${details.invariantWarnings.length} warning${details.invariantWarnings.length === 1 ? "" : "s"}`);
	}

	if (options.expanded) {
		for (const task of details.after.slice(0, 12)) {
			const blocked = task.blockedBy.length > 0 ? theme.fg("warning", ` blocked by ${task.blockedBy.map((id) => `#${id}`).join(",")}`) : "";
			text += `\n${renderTaskLine(task.id, task.status, task.subject, theme)}${blocked}`;
		}
		if (details.after.length > 12) text += "\n" + theme.fg("dim", `… +${details.after.length - 12} more`);
		if (details.invariantWarnings && details.invariantWarnings.length > 0) {
			text += "\n" + theme.fg("warning", details.invariantWarnings.join("\n"));
		}
	}

	return new Text(text, 0, 0);
}

function renderTodoLine(todo: TodoItem, theme: Theme): string {
	switch (todo.status) {
		case "completed":
			return `${theme.fg("success", "✓")} ${theme.fg("dim", theme.strikethrough(todo.content))}`;
		case "in_progress":
			return `${theme.fg("accent", "●")} ${theme.fg("muted", todo.content)} ${theme.fg("dim", `(${todo.activeForm})`)}`;
		case "pending":
			return `${theme.fg("dim", "○")} ${theme.fg("muted", todo.content)}`;
	}
}

function renderTaskLine(id: string, status: TodoItem["status"], subject: string, theme: Theme): string {
	switch (status) {
		case "completed":
			return `${theme.fg("success", "✓")} ${theme.fg("accent", `#${id}`)} ${theme.fg("dim", theme.strikethrough(subject))}`;
		case "in_progress":
			return `${theme.fg("accent", "●")} ${theme.fg("accent", `#${id}`)} ${theme.fg("muted", subject)}`;
		case "pending":
			return `${theme.fg("dim", "○")} ${theme.fg("accent", `#${id}`)} ${theme.fg("muted", subject)}`;
	}
}
