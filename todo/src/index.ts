import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { TaskFileBackend } from "./backend.js";
import { registerTodoCommands } from "./commands.js";
import { registerTodoFlags, resolveTodoConfig } from "./config.js";
import {
	buildTaskPromptAppendix,
	buildTaskReminderIfDue,
	buildTodoPromptAppendix,
	buildTodoReminderIfDue,
	createTodoReminderMarker,
	TODO_REMINDER_CUSTOM_TYPE,
} from "./reminders.js";
import { createTodoState, isTaskToolName, reconstructState, TASK_TOOL_NAMES, TODO_WRITE_TOOL_NAME } from "./state.js";
import { createTaskTools } from "./tools/tasks.js";
import { createTodoWriteTool } from "./tools/todo-write.js";
import type { TodoConfig, TodoMode } from "./types.js";
import { clearTodoUI, clearTodoWorkingMessage, toggleTodoWidget, updateTodoUI, updateTodoWorkingMessage } from "./ui.js";

export default function todoExtension(pi: ExtensionAPI): void {
	registerTodoFlags(pi);

	// Extension flag values are applied after extension factories run. Register
	// TodoWrite up front so core startup options such as --no-tools and --tools
	// see it, then disable it during session_start for todo-off/tasks modes.
	const state = createTodoState({
		mode: "todowrite",
		strict: false,
		reminders: true,
		widgetVisible: true,
		backend: "session",
	});
	const taskBackend = new TaskFileBackend((ctx) => {
		updateTodoUI(ctx, state);
		updateTodoWorkingMessage(ctx, state);
	});
	pi.registerTool(createTodoWriteTool(state));
	let taskToolsRegistered = false;

	function applyConfig(config: TodoConfig): void {
		state.mode = config.mode;
		state.strict = config.strict;
		state.reminders = config.reminders;
		state.widgetVisible = config.widgetVisible;
		state.backend = config.backend;
	}

	function ensureModeTools(): void {
		if (state.mode === "tasks" && !taskToolsRegistered) {
			for (const tool of createTaskTools(state, taskBackend)) pi.registerTool(tool);
			taskToolsRegistered = true;
		}
	}

	function applyModeActiveTools(activateModeTools = false): void {
		const activeTools = pi.getActiveTools();
		const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		if (state.mode === "todowrite") {
			const next = activeTools.filter((name) => !TASK_TOOL_NAMES.includes(name as (typeof TASK_TOOL_NAMES)[number]));
			if (activateModeTools && allToolNames.has(TODO_WRITE_TOOL_NAME) && !next.includes(TODO_WRITE_TOOL_NAME)) next.push(TODO_WRITE_TOOL_NAME);
			if (next.join("\0") !== activeTools.join("\0")) pi.setActiveTools(next);
			return;
		}

		const next = activeTools.filter(
			(name) => name !== TODO_WRITE_TOOL_NAME && (state.mode === "tasks" || !TASK_TOOL_NAMES.includes(name as (typeof TASK_TOOL_NAMES)[number])),
		);
		if (state.mode === "tasks" && activateModeTools) {
			for (const name of TASK_TOOL_NAMES) {
				if (allToolNames.has(name) && !next.includes(name)) next.push(name);
			}
		}
		if (next.join("\0") !== activeTools.join("\0")) pi.setActiveTools(next);
	}

	async function setMode(mode: TodoMode, ctx: ExtensionContext): Promise<void> {
		state.mode = mode;
		ensureModeTools();
		applyModeActiveTools(true);
		reconstructState(ctx, state);
		if (state.mode === "tasks") taskBackend.start(ctx, state);
		else taskBackend.stop();
	}

	registerTodoCommands(pi, state, { setMode, taskBackend });

	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Toggle TodoWrite widget",
		handler: async (ctx) => {
			reconstructState(ctx, state);
			if (state.mode === "tasks") taskBackend.refresh(ctx, state);
			toggleTodoWidget(ctx, state);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		applyConfig(resolveTodoConfig(pi));
		ensureModeTools();
		applyModeActiveTools();
		reconstructState(ctx, state);
		if (state.mode === "tasks") taskBackend.start(ctx, state);
		else taskBackend.stop();
		updateTodoUI(ctx, state);
		updateTodoWorkingMessage(ctx, state);

		if (state.mode === "off") {
			clearTodoUI(ctx);
			clearTodoWorkingMessage(ctx);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx, state);
		if (state.mode === "tasks") taskBackend.start(ctx, state);
		else taskBackend.stop();
		updateTodoUI(ctx, state);
		updateTodoWorkingMessage(ctx, state);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		reconstructState(ctx, state);
		if (state.mode === "tasks") taskBackend.refresh(ctx, state);
		const activeTools = pi.getActiveTools();
		const todoWriteActive = activeTools.includes(TODO_WRITE_TOOL_NAME);
		const taskToolsActive = TASK_TOOL_NAMES.some((name) => activeTools.includes(name));
		const parts = [
			state.mode === "tasks" ? buildTaskPromptAppendix(state, taskToolsActive) : buildTodoPromptAppendix(state, todoWriteActive),
		];

		if (todoWriteActive) {
			const reminder = buildTodoReminderIfDue(ctx, state);
			if (reminder) {
				parts.push(reminder);
				pi.appendEntry(TODO_REMINDER_CUSTOM_TYPE, createTodoReminderMarker(state));
			}
		} else if (taskToolsActive) {
			const reminder = buildTaskReminderIfDue(ctx, state);
			if (reminder) {
				parts.push(reminder);
				pi.appendEntry(TODO_REMINDER_CUSTOM_TYPE, createTodoReminderMarker(state));
			}
		}

		const appendix = parts.filter((part): part is string => Boolean(part)).join("\n\n");
		if (!appendix) return undefined;

		return { systemPrompt: `${event.systemPrompt}\n\n${appendix}` };
	});

	pi.on("agent_start", async (_event, ctx) => {
		updateTodoWorkingMessage(ctx, state);
	});

	pi.on("turn_start", async (_event, ctx) => {
		updateTodoWorkingMessage(ctx, state);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== TODO_WRITE_TOOL_NAME && !isTaskToolName(event.toolName)) return;
		updateTodoUI(ctx, state);
		updateTodoWorkingMessage(ctx, state);
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearTodoWorkingMessage(ctx);
		updateTodoUI(ctx, state);
	});

	pi.on("session_shutdown", async () => {
		taskBackend.stop();
	});
}
