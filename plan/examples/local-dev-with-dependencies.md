# Local development with dependencies

Use this when working from the `~/Personal/pi-extensions` checkout.

```bash
cd ~/Personal/pi-extensions/plan
npm install
npm run typecheck
npm test
```

Run Pi with all three local extensions loaded in dependency order:

```bash
pi -e ../ask/src/index.ts -e ../todo/src/index.ts -e ./src/index.ts
```

Confirm the `--plan` flag is registered:

```bash
pi -e ../ask/src/index.ts -e ../todo/src/index.ts -e ./src/index.ts --help | rg -- --plan
```

Start in plan mode:

```bash
pi --plan -e ../ask/src/index.ts -e ../todo/src/index.ts -e ./src/index.ts
```

Local command checklist:

```text
/plan status
/plan Add a small feature
/plan show
/plan open
/plan reset Revised small feature
/plan cancel
```

Safety checks to try manually in plan mode:

- write to the active plan file: should be allowed,
- write to `README.md`: should be blocked,
- run `ls -la`: should be allowed,
- run `rm -rf dist`: should be blocked.
