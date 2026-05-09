# Dependency failure example

`pi-plan` requires both dependency tools:

- `AskUserQuestion` from `pi-ask`
- `TodoWrite` from `pi-todo`

If either tool is missing, plan mode fails closed.

## Reproduce locally

Run only `pi-plan` without the dependency extensions:

```bash
cd ~/Personal/pi-extensions/plan
pi -e ./src/index.ts
```

Then run:

```text
/plan status
/plan Add a feature
```

Expected behavior:

- `/plan status` reports missing dependencies,
- `/plan Add a feature` does not enter plan mode,
- `EnterPlanMode` returns a non-mutating missing-dependency tool result,
- `ExitPlanMode` refuses to approve if dependencies disappear during a restored planning session.

## Fix

Load dependency extensions first:

```bash
pi -e ../ask/src/index.ts -e ../todo/src/index.ts -e ./src/index.ts
```

Or install the package normally so bundled dependency resources are loaded through the package manifest.
