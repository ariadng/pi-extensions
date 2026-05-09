import type { Task, TodoItem, TodoWriteDetails } from "./types.js";

export function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
	return todos.map((todo) => ({
		content: todo.content,
		status: todo.status,
		activeForm: todo.activeForm,
	}));
}

export function cloneTasks(tasks: readonly Task[]): Task[] {
	return tasks.map((task) => ({
		id: task.id,
		subject: task.subject,
		description: task.description,
		activeForm: task.activeForm,
		owner: task.owner,
		status: task.status,
		blocks: [...task.blocks],
		blockedBy: [...task.blockedBy],
		metadata: task.metadata ? { ...task.metadata } : undefined,
	}));
}

export function countCompleted(todos: readonly TodoItem[]): number {
	return todos.filter((todo) => todo.status === "completed").length;
}

export function countInProgress(todos: readonly TodoItem[]): number {
	return todos.filter((todo) => todo.status === "in_progress").length;
}

export function isAllCompleted(todos: readonly TodoItem[]): boolean {
	return todos.length > 0 && todos.every((todo) => todo.status === "completed");
}

export function formatCounts(todos: readonly TodoItem[]): string {
	return `${countCompleted(todos)}/${todos.length}`;
}

export function todoMarker(status: TodoItem["status"]): string {
	switch (status) {
		case "completed":
			return "✓";
		case "in_progress":
			return "●";
		case "pending":
			return "○";
	}
}

export function formatTodoLine(todo: TodoItem, index?: number): string {
	const prefix = index === undefined ? "" : `${index + 1}. `;
	return `${prefix}${todoMarker(todo.status)} [${todo.status}] ${todo.content}${todo.activeForm ? ` — active: ${todo.activeForm}` : ""}`;
}

export function formatTodoListPlain(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "No active todos on this branch.";
	return todos.map((todo, index) => formatTodoLine(todo, index)).join("\n");
}

export function formatTaskListPlain(tasks: readonly Task[]): string {
	if (tasks.length === 0) return "No tasks on this branch.";
	return tasks
		.map((task) => {
			const blockers = task.blockedBy.length > 0 ? ` — blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : "";
			const owner = task.owner ? ` — owner: ${task.owner}` : "";
			return `#${task.id} ${todoMarker(task.status)} [${task.status}] ${task.subject}${owner}${blockers}`;
		})
		.join("\n");
}

export function formatTodoWriteResultText(details: TodoWriteDetails): string {
	let text =
		"Todos have been modified successfully. Continue using the todo list to track progress. Proceed with the current tasks if applicable.";

	if (details.invariantWarnings.length > 0) {
		text += `\n\nNote: ${details.invariantWarnings.join(" ")}`;
	}

	return text;
}
