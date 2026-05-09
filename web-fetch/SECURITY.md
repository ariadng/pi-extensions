# Security Policy

`pi-webfetch` is a Pi extension and therefore runs with the local privileges of the Pi process. Install it only from a trusted checkout or package source.

## Supported security model

`WebFetch` fetches public HTTP(S) URLs only. By default it blocks unsupported schemes, URL user-info credentials, localhost/internal hostnames, private/reserved IP literals, and DNS results that resolve to private/reserved ranges. It sends no cookies, browser session state, authorization headers, or user-supplied headers.

`PI_WEBFETCH_ALLOW_PRIVATE=1` disables private-address blocking and should only be used for trusted local testing or intentional private-network workflows.

## Reporting issues

For this local package, report security issues in the parent repository or directly to the maintainer. Include:

- the URL/input used;
- relevant WebFetch environment/config settings;
- expected versus observed behavior;
- whether `PI_WEBFETCH_ALLOW_PRIVATE` or `PI_WEBFETCH_ALLOW_HTTP` was enabled.
