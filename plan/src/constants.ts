export const PACKAGE_NAME = "pi-plan";
export const PLAN_COMMAND_NAME = "plan";
export const PLAN_FLAG_NAME = "plan";

export const ENTER_PLAN_MODE_TOOL = "EnterPlanMode";
export const EXIT_PLAN_MODE_TOOL = "ExitPlanMode";
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
export const TODO_WRITE_TOOL = "TodoWrite";

export const ASK_USER_QUESTION_TOOL_SNAKE = "ask_user_question";
export const TODO_WRITE_TOOL_SNAKE = "todo_write";

export const PLAN_STATE_CUSTOM_TYPE = "pi-plan-state";
export const PLAN_CONTEXT_CUSTOM_TYPE = "pi-plan-context";
export const PLAN_STATUS_KEY = "pi-plan";
export const PLAN_WIDGET_KEY = "pi-plan";

export const PLAN_STATE_VERSION = 1;

export const BASE_PLAN_MODE_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"write",
	"edit",
	ENTER_PLAN_MODE_TOOL,
	EXIT_PLAN_MODE_TOOL,
] as const;

export const DEFAULT_PLAN_FILE_HEADING = "# Plan";
