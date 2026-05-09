# pi-plan

Claude-Code-style plan mode for Pi, packaged as an extension.

`pi-plan` adds a read-only planning workflow:

1. Enter plan mode with `/plan`, `--plan`, Ctrl+Alt+P, or the model-callable `EnterPlanMode` tool.
2. The model can inspect files, ask structured clarification questions, update todos, and write one dedicated plan file.
3. The model calls `ExitPlanMode` when the plan is ready.
4. You approve, edit, reject, or cancel the plan.
5. Only after approval are implementation tools restored.

## Required dependencies

This package depends on the previously created workflow packages:

- `pi-ask`, which registers `AskUserQuestion`
- `pi-todo`, which registers `TodoWrite`

`pi-plan` fails closed if either tool is unavailable. It does not silently fall back to plain text questions or ad hoc todo tracking.

The package manifest references bundled dependency resources through:

```json
{
  "pi": {
    "extensions": [
      "./node_modules/pi-ask/src/index.ts",
      "./node_modules/pi-todo/src/index.ts",
      "./src/index.ts"
    ]
  }
}
```

That means a normal package install should load `AskUserQuestion`, `TodoWrite`, and `pi-plan` together.

## Installation

From this local checkout:

```bash
pi install /Users/optizon/Personal/pi-extensions/plan
```

For one-off testing without installing:

```bash
cd /Users/optizon/Personal/pi-extensions/plan
pi -e ../ask/src/index.ts -e ../todo/src/index.ts -e ./src/index.ts
```

If/when published to npm:

```bash
pi install npm:pi-plan
```

## Basic workflow

Start plan mode directly:

```text
/plan Add rate limiting to the login endpoint
```

Or start Pi in plan mode:

```bash
pi --plan
```

Useful commands:

```text
/plan status
/plan show
/plan open
/plan reset Optional new plan title
/plan cancel
```

Model-facing tools:

- `EnterPlanMode` — model asks to enter plan mode for non-trivial work.
- `ExitPlanMode` — model presents the plan for approval.
- `AskUserQuestion` — clarification only, not final plan approval.
- `TodoWrite` — planning/execution progress tracking.

## Approval behavior

`ExitPlanMode` shows the current plan file and offers:

- approve and start implementation,
- edit plan before approving,
- reject and keep planning,
- cancel.

The review prompt starts a 60-second auto-approval timer. If no user input is detected before the timer expires, the plan is approved automatically. Pressing any key/input while the prompt is open stops the timer and leaves the normal approve/edit/reject/cancel flow active without a timeout.

On approval, `pi-plan` restores the previously active implementation tools and keeps `AskUserQuestion`/`TodoWrite` active. The tool result tells the model to convert multi-step implementation work into `TodoWrite` items before editing code.

On rejection or cancel, plan mode remains active.

## Safety model

In plan mode, the extension applies defense-in-depth:

- Active tools are restricted with `pi.setActiveTools()`.
- A `tool_call` guard blocks non-allowlisted tools.
- `bash` is restricted to read-only allowlisted command patterns.
- `write` and `edit` are allowed only for the exact active plan file path.
- Successful plan-file writes/edits are snapshotted back into session state.

Plan-file writes do **not** require an extra permission prompt. In plan mode, `write`/`edit` to the exact active plan file path is allowed automatically; `write`/`edit` to any other path is blocked.

## Plan file location

By default, plan files are stored outside the project repository:

```text
~/.pi/agent/plans/<project-key>/<session-id>-<plan-id>-<slug>.md
```

Set `PI_PLAN_DIR` to override the root directory:

```bash
PI_PLAN_DIR=.pi/plans pi -e ../ask/src/index.ts -e ../todo/src/index.ts -e ./src/index.ts
```

## Session lifecycle

`pi-plan` persists state with `pi.appendEntry()` and reconstructs from the current branch using `ctx.sessionManager.getBranch()`.

Supported behavior:

- reload/resume restores active plan mode,
- session shutdown snapshots the latest plan file,
- tree navigation to a branch without plan state clears plan mode,
- fork creates a new plan file path and copies the parent plan content,
- active plan-mode tools are reapplied after reload/resume.

## RPC, print, and JSON modes

RPC mode is supported through Pi's extension UI protocol. In RPC mode, `pi-plan` uses primitive dialogs (`ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.editor()`), which emit `extension_ui_request` messages. Clients must reply with matching `extension_ui_response` messages.

In RPC mode, the 60-second approval timer auto-approves if no response arrives before the timeout. Raw keypress detection is available only in interactive TUI mode, so RPC clients should treat any response before the timeout as the user interaction that stops auto-approval.

Print/JSON modes cannot collect approval. In those modes `ExitPlanMode` returns a clear `no_ui` tool result, keeps plan mode active, and does not restore implementation tools. It does not hang waiting for input.

## Provider compatibility

Default tool names are Claude-compatible PascalCase:

- `EnterPlanMode`
- `ExitPlanMode`
- `AskUserQuestion`
- `TodoWrite`

If a provider rejects PascalCase tool names, all related packages must switch to the same snake-case naming mode together. `pi-plan` can detect compatible snake-case dependency tools (`ask_user_question`, `todo_write`) but the plan tools and prompts must be updated consistently for that provider.

## Current implementation status

Implemented phases:

- Phase 0: package skeleton, extension registration, `--plan`, `/plan status`, dependency detection.
- Phase 1: plan file path creation, snapshot read/write helpers, custom entry persistence, branch reconstruction via `getBranch()`.
- Phase 2: `EnterPlanMode`, `/plan` entry, dependency validation, active tool allowlist, hidden plan-mode instructions, footer/widget status.
- Phase 3: safety guards for bash, block-all-else behavior, write/edit restricted to the active plan file, automatic plan snapshots after successful plan-file writes.
- Phase 4: `ExitPlanMode` approval/rejection flow, edit-before-approve, dependency re-validation, active tool restoration, TodoWrite implementation guidance.
- Phase 5: `/plan show`, `/plan open`, `/plan cancel`, `/plan reset`, `/plan status`, command completions, and Ctrl+Alt+P shortcut.
- Phase 6: reload/resume/tree reconstruction, session shutdown snapshots, fork plan-file copying, and active tool reapplication.
- Phase 7: RPC-safe primitive approval dialogs and no-hang non-interactive results.
- Phase 8: README and examples.

## Examples

- [`examples/basic.md`](examples/basic.md)
- [`examples/local-dev-with-dependencies.md`](examples/local-dev-with-dependencies.md)
- [`examples/dependency-failure.md`](examples/dependency-failure.md)
