# Pi Extensions

Features for Pi to work like Claude Code.

This repository contains local Pi extension packages that add Claude-Code-style workflow tools to Pi: structured questions, todo/task tracking, plan mode, and lazy MCP support.

## Packages

| Package | Description |
| --- | --- |
| [`pi-ask`](ask/) | Adds the model-callable `AskUserQuestion` tool for structured multiple-choice clarification prompts. |
| [`pi-todo`](todo/) | Adds Claude-compatible `TodoWrite` tracking, optional task mode, reminders, and a todo widget. |
| [`pi-plan`](plan/) | Adds read-only plan mode with `EnterPlanMode` and `ExitPlanMode`; bundles `pi-ask` and `pi-todo`. |
| [`pi-mcp`](mcp/) | Adds lazy Model Context Protocol client support for configured MCP servers. |
| [`pi-webfetch`](web-fetch/) | Adds a Claude-compatible `WebFetch` tool with SSRF-safe bounded URL fetching. |

## Quick start

Install the plan workflow, which includes ask and todo:

```bash
pi install /Users/optizon/Personal/pi-extensions/plan
```

Install MCP support separately if you want MCP tools/resources/prompts:

```bash
pi install /Users/optizon/Personal/pi-extensions/mcp
```

Install WebFetch for public URL fetching:

```bash
pi install /Users/optizon/Personal/pi-extensions/web-fetch
```

For one-off development runs, use `pi -e` with a package directory:

```bash
pi -e /Users/optizon/Personal/pi-extensions/plan
pi -e /Users/optizon/Personal/pi-extensions/mcp
pi -e /Users/optizon/Personal/pi-extensions/web-fetch
```

## Development

Each package is a standalone TypeScript Pi extension. From a package directory:

```bash
npm install
npm run typecheck
npm test
```

Some packages may not define every script; see each package README for package-specific commands and flags.

## Documentation

- [`ask/README.md`](ask/README.md)
- [`todo/README.md`](todo/README.md)
- [`plan/README.md`](plan/README.md)
- [`mcp/README.md`](mcp/README.md)
- [`web-fetch/README.md`](web-fetch/README.md)
