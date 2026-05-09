export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoMode = "todowrite" | "tasks" | "off";
export type TaskBackendMode = "session" | "file";

export interface TodoItem {
	/** Imperative task description, e.g. "Run tests". */
	content: string;
	status: TodoStatus;
	/** Present-continuous form, e.g. "Running tests". */
	activeForm: string;
}

export interface Task {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	owner?: string;
	status: TodoStatus;
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
}

export type TaskToolName = "TaskCreate" | "TaskUpdate" | "TaskGet" | "TaskList";
export type TaskAction = "create" | "update" | "get" | "list";

export interface TaskSummary {
	id: string;
	subject: string;
	status: TodoStatus;
	owner?: string;
	blockedBy: string[];
}

export interface TodoExtensionState {
	mode: TodoMode;
	todos: TodoItem[];
	tasks: Task[];
	nextTaskId: number;
	expanded: boolean;
	widgetVisible: boolean;
	strict: boolean;
	reminders: boolean;
	backend: TaskBackendMode;
	lastCompletedAt?: number;
	completedDisplayTodos: TodoItem[];
	/** Live UI hint for recently completed task sorting. Not required for reconstruction. */
	taskCompletedAt: Record<string, number>;
}

export interface TodoWriteDetails {
	version: 1;
	source: "pi-todo";
	tool: "TodoWrite";
	oldTodos: TodoItem[];
	submittedTodos: TodoItem[];
	/** Empty when the submitted list is fully completed and active state was auto-cleared. */
	activeTodos: TodoItem[];
	invariantWarnings: string[];
	timestamp: string;
}

export interface TodoStateEntryData {
	version: 1;
	source: "pi-todo";
	action: "clear" | "set";
	activeTodos: TodoItem[];
	timestamp: string;
}

export interface TaskDetails {
	version: 1;
	source: "pi-todo";
	tool: TaskToolName;
	action: TaskAction;
	before?: Task[];
	after: Task[];
	nextTaskId: number;
	output?: unknown;
	invariantWarnings?: string[];
	timestamp: string;
}

export interface TaskStateEntryData {
	version: 1;
	source: "pi-todo";
	action: "clear" | "set";
	tasks: Task[];
	nextTaskId: number;
	timestamp: string;
}

export interface TodoConfig {
	mode: TodoMode;
	strict: boolean;
	reminders: boolean;
	widgetVisible: boolean;
	backend: TaskBackendMode;
}
