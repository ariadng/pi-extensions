# pi-webfetch

`pi-webfetch` adds a Claude-Code-compatible `WebFetch` tool to Pi.

Current implementation status: **Phase 0-7** from `~/LifeOS/dev/plans/fetch.md` are implemented. The tool registers, performs SSRF-protected bounded public HTTP(S) fetching, converts text/HTML/JSON/XML responses into readable markdown/text, persists binary content to a temp file, applies the requested prompt with a secondary model call, provides compact rendering plus `/webfetch` commands, and includes package metadata/tests/docs for local or npm-style distribution.

## Usage

```bash
pi -e /Users/optizon/Personal/pi-extensions/web-fetch
# or once installed as a local package
pi install /Users/optizon/Personal/pi-extensions/web-fetch
```

Model-callable tool:

```json
{
  "url": "https://example.com/docs/page",
  "prompt": "Summarize the installation requirements and include any commands."
}
```

The tool name is exactly `WebFetch` and the input schema is the Claude-compatible `{ "url": string, "prompt": string }` object. PascalCase `WebFetch` is the default and only registered tool name in this package version.

Prompt answering always uses Pi's current selected model (`ctx.model`). There is no separate provider-specific WebFetch model setting.

## Slash command

One command namespace is registered:

```text
/webfetch status
/webfetch clear-cache
/webfetch config
/webfetch test <url>
```

- `status` shows cache size, TTL, limits, and safety settings.
- `clear-cache` empties the process-local fetched-content cache.
- `config` prints the effective package configuration.
- `test <url>` fetches and converts a URL without secondary-model summarization, useful for debugging content type, title, size, redirects, and binary persistence.

## Security model

`WebFetch` fetches public HTTP(S) content only. It does **not** use browser cookies, local sessions, authorization headers, arbitrary request methods, custom user headers, JavaScript execution, or browser automation.

By default it fails closed for:

- unsupported URL schemes (`file:`, `ftp:`, `data:`, `javascript:`, etc.);
- URLs with `username` or `password` components;
- localhost, unqualified, `.local`, `.internal`, `.test`, and `.invalid` hostnames;
- private, loopback, link-local, multicast, and reserved IP literals;
- DNS results that resolve to private or reserved addresses;
- domains matched by the configured blocklist;
- cross-host redirects, which are returned as an explicit redirect message instead of being fetched;
- `PI_OFFLINE=1`, unless `PI_WEBFETCH_IGNORE_OFFLINE=1` is set.

Set `PI_WEBFETCH_ALLOW_PRIVATE=1` only for trusted local fixture testing or intentionally private environments.

Fetched binary content is written under a temporary `pi-webfetch-*` directory, not into the project directory. Large tool output is truncated and the full converted text is saved to a temp file when needed.

## Limits and configuration

Environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PI_WEBFETCH_MAX_URL_LENGTH` | `2000` | URL length limit |
| `PI_WEBFETCH_MAX_BYTES` | `10485760` | Decoded response byte limit |
| `PI_WEBFETCH_TIMEOUT_MS` | `60000` | Per-request timeout |
| `PI_WEBFETCH_REDIRECTS` | `10` | Same-host redirect limit |
| `PI_WEBFETCH_CACHE_TTL_MS` | `900000` | Cache TTL |
| `PI_WEBFETCH_CACHE_BYTES` | `52428800` | Cache max text bytes |
| `PI_WEBFETCH_MAX_MARKDOWN_CHARS` | `100000` | Markdown characters sent to the summarizer |
| `PI_WEBFETCH_MAX_SUMMARY_TOKENS` | `4096` | Max tokens for the secondary Pi model call |
| `PI_WEBFETCH_RAW_FALLBACK` | `0` | Return truncated markdown if summarization fails |
| `PI_WEBFETCH_ALLOW_PRIVATE` | `0` | Allow private/localhost addresses |
| `PI_WEBFETCH_ALLOW_HTTP` | `0` | Allow plain HTTP instead of upgrading to HTTPS |
| `PI_WEBFETCH_IGNORE_OFFLINE` | `0` | Ignore `PI_OFFLINE=1` |
| `PI_WEBFETCH_ALLOWED_DOMAINS` | unset | Comma-separated allowlist |
| `PI_WEBFETCH_BLOCKED_DOMAINS` | unset | Comma-separated blocklist |

Optional config files are also read, with project config taking precedence over user config:

- `~/.pi/agent/webfetch.json`
- `.pi/webfetch.json`

Example:

```json
{
  "allowedDomains": ["docs.example.com"],
  "blockedDomains": ["tracking.example.com"],
  "allowPrivate": false
}
```

## Development

```bash
cd web-fetch
npm install
npm run check
npm test
npm run smoke
npm pack --dry-run
```

Manual Pi smoke test:

```bash
pi -e ./web-fetch --tools WebFetch -p \
  "Use WebFetch on https://example.com with prompt 'What is this page?'"
```

Offline fail-closed check:

```bash
PI_OFFLINE=1 pi -e ./web-fetch --tools WebFetch -p \
  "Use WebFetch on https://example.com with prompt 'Summarize'"
```

## Known unsupported cases

- No web search (`WebSearch`) yet.
- No JavaScript-rendered pages or browser automation.
- No authenticated/private browsing with cookies.
- PDF/document text extraction is not implemented yet; binary files are saved to a temp path instead.

## Release notes

See [`CHANGELOG.md`](CHANGELOG.md). Security notes are in [`SECURITY.md`](SECURITY.md).
