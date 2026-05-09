export const TODO_WRITE_DESCRIPTION = `Update the todo list for the current Pi session. Use proactively to track progress on multi-step coding tasks. Each item has content, status, and activeForm.`;

export const TODO_WRITE_PROMPT_SNIPPET = "Update the current session todo list";

export const TODO_WRITE_PROMPT_GUIDELINES = [
	"Use TodoWrite for complex multi-step tasks, explicit todo-list requests, or when the user gives multiple requirements.",
	"Do not use TodoWrite for a single trivial task or purely informational answer.",
	"When using TodoWrite, keep exactly one task in_progress at a time, mark tasks completed immediately after finishing, and do not mark failed or partial work as completed.",
	"TodoWrite items must include content in imperative form and activeForm in present-continuous form.",
];

export const TASK_CREATE_DESCRIPTION = "Create a pending task in the current Pi session task list. Use for complex multi-step work that benefits from explicit task tracking.";
export const TASK_UPDATE_DESCRIPTION = "Update a task's fields, status, metadata, ownership, or dependency edges in the current Pi session task list.";
export const TASK_GET_DESCRIPTION = "Get full details for one task from the current Pi session task list.";
export const TASK_LIST_DESCRIPTION = "List current Pi session tasks with IDs, status, owners, and unresolved blockers.";

export const TASK_PROMPT_GUIDELINES = [
	"Use TaskCreate for complex multi-step tasks and check TaskList first when duplicate tasks may already exist.",
	"Use TaskUpdate to mark a task in_progress before working on it and completed immediately after finishing it.",
	"Use TaskGet when you need full details before starting or updating a task.",
	"Do not mark tasks completed if they are blocked, partially implemented, failing tests, or have unresolved errors.",
	"Prefer available pending tasks in ID order and preserve task dependency relationships with TaskUpdate addBlocks/addBlockedBy.",
];
