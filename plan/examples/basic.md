# Basic pi-plan workflow

## Install

```bash
pi install /Users/optizon/Personal/pi-extensions/plan
```

The package loads bundled `pi-ask` and `pi-todo` resources before `pi-plan`.

## Start planning

```text
/plan Add a user-facing setting to disable telemetry
```

Expected behavior:

1. Plan mode activates.
2. A plan file is created under `~/.pi/agent/plans/...`.
3. Active tools are restricted to planning tools plus `AskUserQuestion` and `TodoWrite`.
4. Project writes are blocked, except writes to the active plan file.

## During planning

The model may:

- read/search files,
- run safe read-only bash,
- call `AskUserQuestion` for concrete clarification,
- call `TodoWrite` for progress tracking,
- write/edit the active plan file.

Useful commands:

```text
/plan status
/plan show
/plan open
```

## Approval

When the model calls `ExitPlanMode`, choose one of:

- approve and start implementation,
- edit plan before approving,
- reject and keep planning,
- cancel.

After approval, implementation tools are restored and the model is instructed to use `TodoWrite` first for multi-step execution tracking.
