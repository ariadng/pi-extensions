# Changelog

## 0.1.0 - 2026-05-09

Initial MVP implementation:

- Registers Claude-compatible `WebFetch` tool with strict `{ url, prompt }` input.
- Validates public HTTP(S) URLs with SSRF protections for private/internal hosts and DNS results.
- Fetches with timeout, byte cap, manual same-host redirects, cross-host redirect reporting, abort support, and in-memory cache.
- Converts HTML to markdown, preserves text/markdown/XML, pretty-prints JSON, and persists binary content to temp files.
- Applies prompts with the current Pi model as the secondary model call, with optional raw fallback.
- Adds compact TUI rendering and `/webfetch` status/config/clear-cache/test commands.
- Includes unit and local fixture integration tests.
