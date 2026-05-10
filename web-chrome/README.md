# pi-web-chrome

Pi extension that gives Pi direct Chrome DevTools Protocol (CDP) browser-control tools.

Implemented phases 0-6 include:

- package skeleton and `chrome_status`
- isolated Chrome launch via `--remote-debugging-port=0`
- explicit CDP endpoint connection with risk gating
- browser lifecycle close/disconnect
- tab list/new/select/activate/close
- navigation with basic load waits
- semantic snapshots with ephemeral refs
- click/type/key/scroll user-like actions
- screenshot artifact capture
- console/log/exception buffers
- network request buffers, redaction, and optional truncated body fetch
- `chrome_evaluate` with timeout, cancellation, truncation, and remote-object cleanup
- optional CDP protocol JSONL logging under `PI_WEB_CHROME_DEBUG_PROTOCOL`
- compact TUI renderers, footer status, and `/chrome-*` user commands

## Security warning

CDP is powerful. A connected client can read page contents, execute JavaScript, capture screenshots, inspect network traffic, and operate inside authenticated browser sessions. This extension is safe-by-default for launch mode:

- binds remote debugging to `127.0.0.1`
- uses a random debugging port
- uses an isolated profile, never the default Chrome profile by default
- requires explicit confirmation/opt-in before connecting to an existing endpoint

Do not connect this extension to your everyday Chrome profile unless you understand the privacy risk.

## Loading

From this repository:

```bash
cd web-chrome
npm install
npm run check
pi -e .
```

Or from the repository root:

```bash
pi -e ./web-chrome
```

For project hot-reload with `/reload`, place or symlink this folder at:

```text
.pi/extensions/web-chrome/
```

Pi will read `package.json` and load `src/index.ts` from the `pi.extensions` manifest.

## Tools

- `chrome_status` — show connection, endpoint risk, current tab, and tabs count.
- `chrome_launch` — launch an isolated Chrome instance.
- `chrome_connect` — connect to a local existing CDP HTTP/WS endpoint after confirmation/opt-in.
- `chrome_close` — close the managed browser, disconnect from an existing endpoint, or close a tab.
- `chrome_tabs` — list, create, select/activate, or close page targets.
- `chrome_navigate` — navigate the current/specified tab and wait for load states.
- `chrome_search` — search Google or DuckDuckGo and return compact organic results.
- `chrome_wait_for` — wait for time, text, selector, URL substring, or load state.
- `chrome_snapshot` — inspect semantic page elements with refs.
- `chrome_click` — click by ref, selector, or viewport coordinates.
- `chrome_type` — type/fill text into a focused or targeted element.
- `chrome_press_key` — press a key or key chord.
- `chrome_scroll` — scroll the page or over a target.
- `chrome_screenshot` — save viewport/full-page/element screenshots to artifacts.
- `chrome_console` — read buffered console/log/exception entries.
- `chrome_network` — read buffered network requests and optional response bodies.
- `chrome_evaluate` — evaluate page JavaScript for diagnostics with truncation.

## Command

All user-facing commands are grouped under `/chrome`, similar to Pi's `/mcp` command:

- `/chrome status` — show connection/browser/tabs/profile risk.
- `/chrome start [url] [--visible|--headless] [--profile <name>]` — launch isolated Chrome, optionally at a URL.
- `/chrome stop` — close managed Chrome or disconnect from an existing endpoint.
- `/chrome tabs` — list tabs and select one interactively when UI is available.
- `/chrome login [url] [--profile <name>]` — open visible Chrome for manual login/OAuth, then confirm completion.
- `/chrome risk` — explain the CDP security model and current risk posture.
- `/chrome cleanup [all|artifacts|tmp]` — remove artifacts and/or ephemeral temporary profiles.

Advanced launch flags for `/chrome start` and `/chrome login`:

- `--visible` / `--headed` — force a visible browser window.
- `--headless` — force headless mode.
- `--profile <name>` — use a persistent named isolated profile.
- `--profile-mode <ephemeral|project|named|custom>` — select profile mode.
- `--user-data-dir <path>` — use a custom profile directory.
- `--allow-default-profile` — risky opt-in for a default Chrome profile path. Chrome 136+ may still block this.
- `/chrome` — open an interactive command picker.
- `/chrome help` — show command help.

## Chrome launch requirements

Chrome or Chromium must be installed. Discovery checks, in order:

1. `chromePath` tool parameter
2. `PI_WEB_CHROME_PATH`
3. common platform install locations / commands

Chrome 136+ ignores remote debugging flags for the default data directory. This extension always launches with a non-default `--user-data-dir` unless you explicitly request a custom profile.

## Environment variables

- `PI_WEB_CHROME_PATH` — explicit Chrome executable path.
- `PI_WEB_CHROME_PROFILE_MODE` — `ephemeral`, `project`, `named`, or `custom`. Default: `named`.
- `PI_WEB_CHROME_PROFILE_NAME` — name for `named` profile mode. Default: `default`.
- `PI_WEB_CHROME_USER_DATA_DIR` — directory for `custom` profile mode.
- `PI_WEB_CHROME_ALLOW_DEFAULT_PROFILE` — `1` or `true` to allow a custom user data dir that looks like the default Chrome profile. Risky and may not work on Chrome 136+.
- `PI_WEB_CHROME_HEADLESS` — headless is enabled by default; set `0` or `false` to launch a visible browser by default.
- `PI_WEB_CHROME_ALLOW_EXISTING` — `1` or `true` to allow existing endpoint connections in non-interactive modes.
- `PI_WEB_CHROME_ARTIFACT_DIR` — override screenshot/body/evaluation/protocol artifact directory.
- `PI_WEB_CHROME_DEBUG_PROTOCOL` — `1` or `true` to write raw CDP send/receive messages to a JSONL artifact file. This can contain sensitive page data.

## Examples

Ask Pi:

```text
Launch Chrome and open https://example.com, then list tabs.
```

```text
Open my local app at http://127.0.0.1:3000, inspect the page, click the Sign in button, and stop when manual credentials are needed.
```

```text
Take a full-page screenshot of the current page and tell me the artifact path.
```

Chrome launches headless by default. Pass `headless: false` to `chrome_launch`, or use `/chrome login`, when you need to see the browser window.

Or use tools directly:

1. `chrome_launch` with `{ "url": "https://example.com" }`
2. `chrome_snapshot` with `{}`
3. `chrome_search` with `{ "query": "pi coding agent github", "engine": "auto" }`
4. `chrome_click` with `{ "ref": "c1" }` using a ref from the latest snapshot
5. `chrome_navigate` with `{ "url": "https://example.org", "waitUntil": "load" }`

## Troubleshooting

### Chrome executable not found

Set `PI_WEB_CHROME_PATH` or pass `chromePath` to `chrome_launch`:

```bash
PI_WEB_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" pi -e ./web-chrome
```

The extension checks common Google Chrome, Chrome for Testing, Chromium, Canary, and PATH locations.

### Chrome 136+ remote debugging restriction

Chrome 136+ ignores remote debugging flags against the default Chrome user data directory. `web-chrome` always launches with a dedicated `--user-data-dir`; do not point `profileMode=custom` at your everyday Chrome profile.

### Port conflicts

Launch mode uses `--remote-debugging-port=0`, so Chrome chooses an open port automatically. If connecting to an existing endpoint fails, verify the endpoint is local and reachable, for example `http://127.0.0.1:9222/json/version`.

### Google OAuth and authenticated website testing

For sites that require Google OAuth, the recommended workflow is a **visible persistent isolated profile**, not your everyday Chrome profile. This is now the default behavior: if you do not provide a profile mode/name, Chrome uses the named isolated profile `default` at `~/.pi/agent/web-chrome/profiles/named-default`.

```text
/chrome login https://your-app.example.com
```

Complete Google login manually in the visible Chrome window, then confirm in Pi. Later runs can reuse the default named profile session:

```text
/chrome start https://your-app.example.com --visible
```

Use a separate named profile when you want isolated accounts/sessions per app or environment:

```text
/chrome login https://your-app.example.com --profile oauth
/chrome start https://your-app.example.com --profile oauth --visible
```

That named isolated profile persists under `~/.pi/agent/web-chrome/profiles/named-oauth`.

Tool equivalent:

```json
{
  "url": "https://your-app.example.com",
  "headless": false,
  "profileMode": "named",
  "profileName": "oauth"
}
```

This is safer than attaching to your default Chrome profile and usually enough for OAuth test flows.

### Using your normal Chrome profile

This is supported only as an explicit risky opt-in for `profileMode=custom`:

```json
{
  "url": "https://your-app.example.com",
  "headless": false,
  "profileMode": "custom",
  "userDataDir": "~/Library/Application Support/Google/Chrome",
  "allowDefaultProfile": true
}
```

or:

```text
/chrome start https://your-app.example.com --visible --user-data-dir "~/Library/Application Support/Google/Chrome" --allow-default-profile
```

Caveats:

- This can expose real cookies, Google account sessions, storage, screenshots, and network data to CDP tools.
- Chrome 136+ ignores remote debugging flags against the default Chrome data directory, so this may fail even with opt-in.
- Chrome may refuse to start if the profile is already locked by another running Chrome instance.
- Prefer `/chrome login ...` using the default named isolated profile, or `/chrome login ... --profile oauth` for a separate named profile, unless you truly need the normal profile.

### Headless vs visible Chrome

Headless is the default. Use one of:

- `chrome_launch` with `{ "headless": false }`
- `PI_WEB_CHROME_HEADLESS=0`
- `/chrome login [url]`
- `/chrome start [url] --visible`

### Search with Google and DuckDuckGo

Use `chrome_search` for efficient web search. The extension prompt tells Pi to use this as the default whenever the user asks to search the web, look something up online, find current information, or research a topic. It navigates Chrome to lightweight search-result pages, extracts organic result titles/URLs/snippets, and detects bot challenges:

```json
{ "query": "pi coding agent github", "engine": "auto", "limit": 10 }
```

Engines:

- `auto` — try DuckDuckGo first, then Google if needed.
- `duckduckgo` — defaults to `html` mode for lightweight pages; `duckDuckGoMode` can be `html`, `lite`, or `web`.
- `google` — uses `udm=14`, `pws=0`, and `num=<limit>` for compact web results.

If Google or DuckDuckGo shows a bot challenge, `chrome_search` reports it instead of pretending no results exist. Use a visible named profile, complete the challenge manually if appropriate, then retry:

```text
/chrome start --visible
```

### Stale refs

Refs from `chrome_snapshot` are ephemeral and expire after navigation or time. If a click/type tool reports a stale or expired ref, call `chrome_snapshot` again.

### Target closed, crashed, or detached

Call `chrome_tabs` with `{ "action": "list" }` or `/chrome tabs`, then select an existing tab or open a new one. Crashed/detached targets are removed from the internal session cache.

### Artifacts and profile cleanup

Artifacts may include screenshots, response bodies, evaluation output, and protocol logs. Treat them as sensitive. Cleanup options:

```text
/chrome cleanup artifacts
/chrome cleanup tmp
/chrome cleanup all
```

Manual cleanup paths:

```text
~/.pi/agent/web-chrome/artifacts/
~/.pi/agent/web-chrome/tmp/
```

Stable isolated named/project profiles live under `~/.pi/agent/web-chrome/profiles/` and are not removed by cleanup commands. The default profile is `~/.pi/agent/web-chrome/profiles/named-default`.

## Manual Pi test script

After loading with `pi -e ./web-chrome`, try:

1. `/chrome` and choose `start`.
2. `Open https://example.com and inspect the page.`
3. `Take a screenshot of the current page.`
4. `/chrome tabs`.
5. `/chrome stop`.

For local development, run:

```bash
cd web-chrome
npm run check
npm test
npm run smoke
```
