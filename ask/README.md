# pi-ask

Claude-Code-style `AskUserQuestion` for Pi.

`pi-ask` is an opt-in Pi package that lets the model ask structured multiple-choice questions during execution, collect answers through Pi UI, and continue with those answers as a normal tool result.

## Install / develop

```bash
pi install /Users/optizon/Personal/pi-extensions/ask
# or for a one-off run
pi -e /Users/optizon/Personal/pi-extensions/ask
```

## Tool

The package registers one model-callable tool:

```text
AskUserQuestion
```

It is auto-allowed once the package is installed and the tool is active. There is no separate permission prompt or approval gate; the only UI is the actual question dialog.

## Behavior

- Interactive mode: rich TUI dialog with question chips, review/submit screen, single-select, multi-select, and custom free-text answers.
- Single-select preview questions use a side-by-side preview panel on wide terminals and a stacked preview on narrow terminals.
- Preview selections support optional user notes with `N`; notes are returned in `details.annotations`.
- Users can press `C` / choose `Chat about this` to return `status: "clarify"` instead of answering.
- RPC mode: sequential `select` / `input` fallback, including `Chat about this`.
- Print/JSON/no-UI modes: returns `status: "no_ui"` immediately and does not hang.
- Cancellation is a normal tool result with `status: "cancelled"`, not a thrown error.
- Result `details` include `status`, normalized `questions`, `answers`, optional `annotations`, and optional `metadata`.

## Schema

```ts
type QuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

type Question = {
  question: string;
  header?: string;     // max 12 chars; derived if omitted
  options: QuestionOption[]; // 2-4 options
  multiSelect?: boolean;
};

type AskUserQuestionInput = {
  questions: Question[]; // 1-4 questions
  answers?: Record<string, string>; // ignored/overwritten by real user answers
  annotations?: Record<string, { preview?: string; notes?: string }>;
  metadata?: { source?: string };
};
```

Runtime normalization derives missing headers, truncates overlong headers for display, fills missing option descriptions during `prepareArguments()`, and ignores model-supplied `answers`. Validation rejects duplicate questions, duplicate option labels, explicit `Other`/custom options, and multi-select questions with previews in this MVP.

## Flags and environment

```bash
pi --ask-preview markdown       # default; previews are markdown/plain text
pi --ask-preview html           # sanitize HTML fragments and render text preview
pi --ask-preview off            # ignore previews
pi --ask-no-preferences         # disable persisted default answers

PI_ASK_PREVIEW=html pi
PI_ASK_PREFERENCES=0 pi
```

HTML preview mode accepts fragments only. It rejects `<!DOCTYPE>`, `<html>`, `<body>`, `<script>`, and `<style>`, requires at least one HTML tag, strips tags, and decodes basic entities before rendering.

Default-answer preferences are stored locally under:

```text
~/.pi/agent/ask/preferences.json
```

Preferences are keyed by question text, multi-select mode, and option labels. They preselect defaults in the rich dialog and are offered as `Use previous: ...` in RPC mode.

## Commands

```text
/ask-demo               Show a local demo dialog without involving the model
/ask-config             Show current pi-ask configuration
/ask-clear-preferences  Clear stored default-answer preferences
/ask-last               Convert recent assistant text questions into an AskUserQuestion dialog
```

`/ask-last` scans the current session branch for the latest assistant text, extracts question lines ending in `?`, and uses following bullet/numbered/lettered lines as options. If no options are found, it falls back to Yes/No.

## Phase 4 limitations

- Notes are text-only. Pi's current extension-facing custom UI API does not expose image-paste hooks for dialogs, so image attachments in notes are deferred.
- Remote/channel/mobile answer bridges should be implemented as a separate extension that forwards answers into Pi's RPC/UI protocol; this package intentionally stays local and permissionless.

## Provider/name note

Phase 0 keeps the exact Claude-compatible name `AskUserQuestion`. Local Pi/RPC loading accepts the name. Live provider compatibility should be rechecked before publishing; if a provider rejects it, add one opt-in lower-case alias rather than exposing two ask tools by default.

See `docs/provider-name-spike.md`.

## Coexistence

Pi examples include `question` and `questionnaire` tools. If multiple ask-style tools are active, models may choose any of them. For Claude-compatible workflows, enable only `AskUserQuestion` in strict allowlists.

Plan-mode or read-only extensions with active-tool allowlists should include `AskUserQuestion` so clarifying questions are not blocked. `AskUserQuestion` should be used for clarifications before a plan, not for final plan approval.
