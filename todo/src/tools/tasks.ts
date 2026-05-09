import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { cloneTasks } from "../format.js";
import {
	TASK_CREATE_DESCRIPTION,
	TASK_GET_DESCRIPTION,
	TASK_LIST_DESCRIPTION,
	TASK_PROMPT_GUIDELINES,
	TASK_UPDATE_DESCRIPTION,
} from "../prompt.js";
import { renderTaskCall, renderTaskResult } from "../render.js";
import {
	TaskCreateParamsSchema,
	TaskGetParamsSchema,
	TaskListParamsSchema,
	TaskUpdateParamsSchema,
	type TaskUpdateParams,
} from "../schema.js";
import {
	cloneStateTasks,
	createTaskDetails,
	TASK_CREATE_TOOL_NAME,
	TASK_GET_TOOL_NAME,
	TASK_LIST_TOOL_NAME,
	TASK_UPDATE_TOOL_NAME,
} from "../state.js";
import type { TaskFileBackend } from "../backend.js";
import type { Task, TaskDetails, TaskSummary, TodoExtensionState } from "../types.js";
import { updateTodoUI, updateTodoWorkingMessage } from "../ui.js";

export function createTaskTools(state: TodoExtensionState, backend?: TaskFileBackend) {
	let mutationQueue = Promise.resolve();

	function withTaskMutation<T>(fn: () => Promise<T> | T): Promise<T> {
		const run = mutationQueue.then(fn, fn);
		mutationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	function withBackendMutation<T>(ctx: ExtensionContext, fn: () => Promise<T> | T): Promise<T> {
		return backend?.withMutation(ctx, state, fn) ?? Promise.resolve(fn());
	}

	function refreshBackend(ctx: ExtensionContext): void {
		backend?.refresh(ctx, state);
	}

	const taskCreate = defineTool<typeof TaskCreateParamsSchema, TaskDetails>({
		name: TASK_CREATE_TOOL_NAME,
		label: "Task Create",
		description: TASK_CREATE_DESCRIPTION,
		promptSnippet: "Create a task in the current session task list",
		promptGuidelines: TASK_PROMPT_GUIDELINES,
		parameters: TaskCreateParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return withTaskMutation(() => withBackendMutation(ctx, async () => {
				const before = cloneStateTasks(state);
				const task: Task = {
					id: String(state.nextTaskId++),
					subject: params.subject,
					description: params.description,
					activeForm: params.activeForm,
					status: "pending",
					blocks: [],
					blockedBy: [],
					metadata: params.metadata ? { ...params.metadata } : undefined,
				};
				state.tasks.push(task);
				state.expanded = true;
				const details = createTaskDetails({
					tool: TASK_CREATE_TOOL_NAME,
					action: "create",
					before,
					after: state.tasks,
					nextTaskId: state.nextTaskId,
					output: { task: cloneTasks([task])[0] },
				});
				updateTodoUI(ctx, state);
				updateTodoWorkingMessage(ctx, state);
				return { content: [{ type: "text", text: `Task #${task.id} created successfully: ${task.subject}` }], details };
			}));
		},
		renderCall(args, theme) {
			return renderTaskCall(TASK_CREATE_TOOL_NAME, args, theme);
		},
		renderResult(result, options, theme) {
			return renderTaskResult(result, options, theme);
		},
	});

	const taskUpdate = defineTool<typeof TaskUpdateParamsSchema, TaskDetails>({
		name: TASK_UPDATE_TOOL_NAME,
		label: "Task Update",
		description: TASK_UPDATE_DESCRIPTION,
		promptSnippet: "Update a task in the current session task list",
		parameters: TaskUpdateParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return withTaskMutation(() => withBackendMutation(ctx, async () => {
				const before = cloneStateTasks(state);
				const task = state.tasks.find((candidate) => candidate.id === params.taskId);
				const previousStatus = task?.status;
				const warnings: string[] = [];

				if (!task) {
					const details = createTaskDetails({
						tool: TASK_UPDATE_TOOL_NAME,
						action: "update",
						before,
						after: state.tasks,
						nextTaskId: state.nextTaskId,
						output: { found: false, taskId: params.taskId },
						invariantWarnings: [`Task #${params.taskId} not found.`],
					});
					return { content: [{ type: "text", text: `Task #${params.taskId} not found.` }], details };
				}

				applyTaskUpdate(state.tasks, task, params, warnings);
				if (params.status === "completed" && previousStatus !== "completed") {
					state.taskCompletedAt[params.taskId] = Date.now();
					state.lastCompletedAt = Date.now();
				}
				if (params.status === "deleted") delete state.taskCompletedAt[params.taskId];
				const after = cloneStateTasks(state);
				const details = createTaskDetails({
					tool: TASK_UPDATE_TOOL_NAME,
					action: "update",
					before,
					after,
					nextTaskId: state.nextTaskId,
					output: { taskId: params.taskId, deleted: params.status === "deleted" },
					invariantWarnings: warnings,
				});
				updateTodoUI(ctx, state);
				updateTodoWorkingMessage(ctx, state);
				const actionText = params.status === "deleted" ? "deleted" : "updated";
				return { content: [{ type: "text", text: `Task #${params.taskId} ${actionText} successfully.` }], details };
			}));
		},
		renderCall(args, theme) {
			return renderTaskCall(TASK_UPDATE_TOOL_NAME, args, theme);
		},
		renderResult(result, options, theme) {
			return renderTaskResult(result, options, theme);
		},
	});

	const taskGet = defineTool<typeof TaskGetParamsSchema, TaskDetails>({
		name: TASK_GET_TOOL_NAME,
		label: "Task Get",
		description: TASK_GET_DESCRIPTION,
		promptSnippet: "Get full details for one session task",
		parameters: TaskGetParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			refreshBackend(ctx);
			const task = state.tasks.find((candidate) => candidate.id === params.taskId);
			const details = createTaskDetails({
				tool: TASK_GET_TOOL_NAME,
				action: "get",
				after: state.tasks,
				nextTaskId: state.nextTaskId,
				output: task ? { task: cloneTasks([task])[0] } : { found: false, taskId: params.taskId },
			});
			return {
				content: [{ type: "text", text: task ? formatTaskDetails(task) : `Task #${params.taskId} not found.` }],
				details,
			};
		},
		renderCall(args, theme) {
			return renderTaskCall(TASK_GET_TOOL_NAME, args, theme);
		},
		renderResult(result, options, theme) {
			return renderTaskResult(result, options, theme);
		},
	});

	const taskList = defineTool<typeof TaskListParamsSchema, TaskDetails>({
		name: TASK_LIST_TOOL_NAME,
		label: "Task List",
		description: TASK_LIST_DESCRIPTION,
		promptSnippet: "List tasks in the current session task list",
		parameters: TaskListParamsSchema,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			refreshBackend(ctx);
			const summaries = getTaskSummaries(state.tasks);
			const details = createTaskDetails({
				tool: TASK_LIST_TOOL_NAME,
				action: "list",
				after: state.tasks,
				nextTaskId: state.nextTaskId,
				output: { tasks: summaries },
			});
			return {
				content: [{ type: "text", text: summaries.length > 0 ? formatTaskSummaries(summaries) : "No tasks." }],
				details,
			};
		},
		renderCall(args, theme) {
			return renderTaskCall(TASK_LIST_TOOL_NAME, args, theme);
		},
		renderResult(result, options, theme) {
			return renderTaskResult(result, options, theme);
		},
	});

	return [taskCreate, taskUpdate, taskGet, taskList];
}

function applyTaskUpdate(tasks: Task[], task: Task, params: TaskUpdateParams, warnings: string[]): void {
	if (params.status === "deleted") {
		const deletedId = task.id;
		const index = tasks.findIndex((candidate) => candidate.id === deletedId);
		if (index >= 0) tasks.splice(index, 1);
		for (const other of tasks) {
			other.blocks = other.blocks.filter((id) => id !== deletedId);
			other.blockedBy = other.blockedBy.filter((id) => id !== deletedId);
		}
		return;
	}

	if (params.subject !== undefined) task.subject = params.subject;
	if (params.description !== undefined) task.description = params.description;
	if (params.activeForm !== undefined) task.activeForm = params.activeForm;
	if (params.status !== undefined) task.status = params.status;
	if (params.owner !== undefined) task.owner = params.owner;

	if (params.metadata !== undefined) {
		const metadata = { ...(task.metadata ?? {}) };
		for (const [key, value] of Object.entries(params.metadata)) {
			if (value === null) delete metadata[key];
			else metadata[key] = value;
		}
		task.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
	}

	for (const blockedId of params.addBlocks ?? []) {
		if (blockedId === task.id) {
			warnings.push(`Task #${task.id} cannot block itself.`);
			continue;
		}
		const blockedTask = tasks.find((candidate) => candidate.id === blockedId);
		if (!blockedTask) {
			warnings.push(`Task #${blockedId} not found for addBlocks.`);
			continue;
		}
		addUnique(task.blocks, blockedId);
		addUnique(blockedTask.blockedBy, task.id);
	}

	for (const blockerId of params.addBlockedBy ?? []) {
		if (blockerId === task.id) {
			warnings.push(`Task #${task.id} cannot be blocked by itself.`);
			continue;
		}
		const blockerTask = tasks.find((candidate) => candidate.id === blockerId);
		if (!blockerTask) {
			warnings.push(`Task #${blockerId} not found for addBlockedBy.`);
			continue;
		}
		addUnique(task.blockedBy, blockerId);
		addUnique(blockerTask.blocks, task.id);
	}
}

function addUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function getTaskSummaries(tasks: readonly Task[]): TaskSummary[] {
	return tasks
		.filter((task) => !task.metadata?._internal)
		.map((task) => ({
			id: task.id,
			subject: task.subject,
			status: task.status,
			owner: task.owner,
			blockedBy: task.blockedBy.filter((id) => tasks.find((candidate) => candidate.id === id)?.status !== "completed"),
		}));
}

function formatTaskSummaries(tasks: readonly TaskSummary[]): string {
	return tasks
		.map((task) => {
			const owner = task.owner ? ` owner=${task.owner}` : "";
			const blockedBy = task.blockedBy.length > 0 ? ` blocked_by=${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
			return `#${task.id} [${task.status}] ${task.subject}${owner}${blockedBy}`;
		})
		.join("\n");
}

function formatTaskDetails(task: Task): string {
	return [
		`#${task.id} [${task.status}] ${task.subject}`,
		`Description: ${task.description}`,
		task.activeForm ? `Active form: ${task.activeForm}` : undefined,
		task.owner ? `Owner: ${task.owner}` : undefined,
		task.blocks.length > 0 ? `Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}` : undefined,
		task.blockedBy.length > 0 ? `Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : undefined,
		task.metadata ? `Metadata: ${JSON.stringify(task.metadata)}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

