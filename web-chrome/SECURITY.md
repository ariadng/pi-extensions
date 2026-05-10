# web-chrome security review checklist

CDP is equivalent to a highly privileged browser-debugging interface. Before publishing or enabling this extension widely, review the checklist below.

## Safe defaults

- [x] Launch mode binds CDP to `127.0.0.1` only.
- [x] Launch mode uses `--remote-debugging-port=0` for a random port.
- [x] Launch mode always uses a non-default `--user-data-dir`.
- [x] Default profile mode is a persistent isolated named profile (`named-default`).
- [x] Headless is enabled by default.
- [x] Existing-browser attach is explicit and confirmation-gated.
- [x] Launching with a default Chrome profile path requires explicit opt-in or interactive confirmation.
- [x] Non-interactive existing-browser attach fails closed unless `allowRiskyExistingBrowser=true` or `PI_WEB_CHROME_ALLOW_EXISTING=1` is set.
- [x] Navigation only allows `http:`, `https:`, and `about:` schemes.
- [x] Network headers and token-like URL query values are redacted by default.
- [x] Sensitive network output requires interactive confirmation.
- [x] Screenshots, response bodies, evaluation output, and protocol logs are written as local artifacts, not inline base64.

## Features intentionally omitted from MVP

- Cookie inspection/manipulation tools.
- Local/session storage extraction tools.
- Raw CDP protocol command tool.
- Request-header injection tools.
- CAPTCHA solving, bot-evasion, or site access-control bypass.

## Risky surfaces

- `chrome_connect` can attach to a browser profile with real cookies and authenticated sessions.
- `chrome_launch` with `profileMode=custom` and `allowDefaultProfile=true` can attempt to expose the user's normal Chrome profile; Chrome 136+ may block this, but the privacy risk remains on versions/configurations that allow it.
- `chrome_evaluate` can run arbitrary page JavaScript. It must not be used to extract credentials, auth tokens, or private storage.
- `chrome_network includeSensitive=true` can reveal auth headers and cookies.
- `PI_WEB_CHROME_DEBUG_PROTOCOL=1` can log raw CDP traffic, including page data and possibly sensitive request metadata.
- Screenshots may contain sensitive visual information.

## Operational guidance

- Prefer `chrome_launch` over `chrome_connect`.
- Use an isolated named profile for login flows and `/chrome login <url> --profile oauth` so the user enters credentials manually once and reuses a safer persistent session.
- Treat artifact directories as sensitive local files.
- Run `/chrome cleanup` periodically to remove artifacts and ephemeral temp profiles.
- Do not share protocol logs, screenshots, or response-body artifacts without review.
