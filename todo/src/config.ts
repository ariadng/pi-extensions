import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeMode } from "./state.js";
import type { TaskBackendMode, TodoConfig, TodoMode } from "./types.js";

export function registerTodoFlags(pi: ExtensionAPI): void {
	pi.registerFlag("todo-v2", {
		description: "Use Claude V2-style task tools instead of TodoWrite",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("todo-off", {
		description: "Disable pi-todo tools and UI for this run",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("todo-strict", {
		description: "Enable strict TodoWrite invariant checking",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("todo-no-reminders", {
		description: "Disable pi-todo reminder prompt nudges",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("todo-no-widget", {
		description: "Disable the pi-todo footer status and widget",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("todo-backend", {
		description: "Task backend: session or file (tasks mode only)",
		type: "string",
		default: "session",
	});
}

export function resolveTodoConfig(pi: ExtensionAPI): TodoConfig {
	return {
		mode: resolveMode(pi),
		strict: pi.getFlag("todo-strict") === true,
		reminders: process.env.PI_TODO_REMINDERS !== "0" && pi.getFlag("todo-no-reminders") !== true,
		widgetVisible: pi.getFlag("todo-no-widget") !== true,
		backend: resolveBackend(pi),
	};
}

function resolveMode(pi: ExtensionAPI): TodoMode {
	if (pi.getFlag("todo-off") === true) return "off";
	if (pi.getFlag("todo-v2") === true) return "tasks";

	const envMode = normalizeMode(process.env.PI_TODO_MODE);
	if (envMode) return envMode;

	return "todowrite";
}

function resolveBackend(pi: ExtensionAPI): TaskBackendMode {
	const envBackend = normalizeBackend(process.env.PI_TODO_BACKEND);
	if (envBackend) return envBackend;

	const flagBackend = typeof pi.getFlag("todo-backend") === "string" ? normalizeBackend(pi.getFlag("todo-backend") as string) : undefined;
	return flagBackend ?? "session";
}

function normalizeBackend(value: string | undefined): TaskBackendMode | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "session" || normalized === "file") return normalized;
	return undefined;
}
