# pi-todo

Claude-Code-style TodoWrite tracking for Pi.

## Development usage

```bash
pi -e ~/Personal/pi-extensions/todo
```

## What is implemented

Phase 1:

- Exact model-callable `TodoWrite` tool
- Claude-compatible input shape: `{ todos: [{ content, status, activeForm }] }`
- Session/branch-aware state reconstruction from `toolResult.details`
- Sequential, serialized todo mutations
- Compact tool call/result rendering
- Footer status and todo widget
- `/todo list` command
- All-completed TodoWrite submissions clear active state while preserving audit details

Phase 2:

- Dynamic todo-state system prompt appendix before each agent turn
- Gentle reminders after long stretches without `TodoWrite`
- Active todo `activeForm` as Pi's working message while streaming
- `Ctrl+Alt+T` todo widget toggle
- `/todo` interactive view
- `/todo show`, `/todo hide`, `/todo expand`, `/todo collapse`, `/todo clear`

Phase 3:

- Strict TodoWrite mode via `--todo-strict` or `/todo strict on|off`
- Markdown export/import via `/todo export [file]` and `/todo import <file>`
- `/todo clear completed` and `/todo clear all`
- Branch-local custom state entries for command-driven clear/import changes

Phase 4:

- `tasks` mode with Claude V2-style `TaskCreate`, `TaskUpdate`, `TaskGet`, and `TaskList`
- Task snapshots in tool result details for resume/tree reconstruction
- Task dependencies, metadata merge/delete, deletion, summaries, and compact rendering
- Task status/widget/working-message support
- Task prompt appendix and reminders

Phase 5:

- Better task widget sorting: recently completed, in-progress, unblocked pending, blocked pending, older completed
- Hidden task summaries such as `… +2 pending, 1 completed`
- Blocker/owner display and width truncation
- All-completed task lists show briefly, then hide without losing session details
- `/todo mode [todowrite|tasks|off]`

Phase 6:

- Optional file-backed task backend with `.lock`, `.highwatermark`, one JSON file per task, fs.watch, and polling fallback
- Backend configured with `--todo-backend file` or `PI_TODO_BACKEND=file`
- File backend is opt-in and intended for multi-process task sharing in task mode

## Flags

```bash
pi -e ~/Personal/pi-extensions/todo --todo-off
pi -e ~/Personal/pi-extensions/todo --todo-no-widget
pi -e ~/Personal/pi-extensions/todo --todo-strict
pi -e ~/Personal/pi-extensions/todo --todo-no-reminders
pi -e ~/Personal/pi-extensions/todo --todo-v2           # enable TaskCreate/TaskUpdate/TaskGet/TaskList mode
pi -e ~/Personal/pi-extensions/todo --todo-v2 --todo-backend file
```

Environment mode override:

```bash
PI_TODO_MODE=todowrite pi -e ~/Personal/pi-extensions/todo
PI_TODO_MODE=tasks pi -e ~/Personal/pi-extensions/todo
PI_TODO_MODE=off pi -e ~/Personal/pi-extensions/todo
PI_TODO_MODE=tasks PI_TODO_BACKEND=file pi -e ~/Personal/pi-extensions/todo
```

## TodoWrite schema

```ts
type TodoStatus = "pending" | "in_progress" | "completed";

type TodoItem = {
  content: string;
  status: TodoStatus;
  activeForm: string;
};

type TodoWriteInput = {
  todos: TodoItem[];
};
```

## Task schemas

Task mode is enabled with `--todo-v2` or `PI_TODO_MODE=tasks`.

Tools:

```text
TaskCreate
TaskUpdate
TaskGet
TaskList
```

Task shape:

```ts
type Task = {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status: "pending" | "in_progress" | "completed";
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
};
```

## Commands

```text
/todo
/todo list
/todo show
/todo hide
/todo expand
/todo collapse
/todo clear [completed|all]
/todo strict [on|off]
/todo mode [todowrite|tasks|off]
/todo export [file]
/todo import <file>
```

`/todo` opens a compact interactive view in the TUI. In RPC/non-rich UI contexts it falls back to a notification.

`/todo clear` and `/todo import` append branch-local extension state entries so command-driven state changes survive resume and tree navigation.

## File task backend

The file backend is only used in `tasks` mode:

```bash
PI_TODO_MODE=tasks PI_TODO_BACKEND=file pi -e ~/Personal/pi-extensions/todo
```

It stores task files under:

```text
~/.pi/agent/tasks/<session-id>-<leaf-id>/
```

The backend uses a `.lock` directory for mutations, `.highwatermark` for monotonic IDs, `fs.watch` for updates, and a polling fallback. It is intentionally opt-in because file-backed state is less naturally branch-aware than session-backed snapshots.

## Shortcut

```text
Ctrl+Alt+T
```

Cycles the todo widget through hidden, compact, and expanded states.
