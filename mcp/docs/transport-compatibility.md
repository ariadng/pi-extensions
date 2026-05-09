# MCP transport compatibility

`pi-mcp` keeps every configured server dormant until activation. Config loading and manager creation do not spawn stdio commands or open network sockets.

| Transport | Config `type` | Client implementation | Test coverage | Notes |
|---|---|---|---|---|
| STDIO | `stdio` or omitted | MCP SDK `StdioClientTransport` | Yes | Child process starts only on activation and is closed on shutdown/reconnect. |
| Streamable HTTP | `http` | MCP SDK `StreamableHTTPClientTransport` | Yes | Supports static `headers`, `headersHelper`, OAuth, connection timeout, request timeout, and reconnect. |
| SSE | `sse` | MCP SDK `SSEClientTransport` | Yes | Supports static `headers`, `headersHelper`, OAuth, connection timeout, request timeout, and reconnect. |
| WebSocket | `ws` | `pi-mcp` WebSocket transport adapter over `ws` | Yes | Supports static `headers`, `headersHelper`, OAuth bearer-token reuse, connection timeout, request timeout, and reconnect. |

## Auth diagnostics and OAuth

Auth-required network responses move the server to `needs-auth`. Run `/mcp auth <server>` or call `mcp__<server>__authenticate` to start OAuth. The flow opens the authorization URL in your default browser and also returns the URL; after the local browser callback completes, Pi reconnects the server and replaces the auth pseudo-tool with the real tools. Set `PI_MCP_OPEN_BROWSER=0` to disable automatic browser opening.

OAuth credentials are stored in `~/.pi/agent/mcp-auth.json` by default. Use `PI_MCP_AUTH_FILE` to override this path in tests or custom setups. Static `headers` / `headersHelper` remain useful for bearer/API-token style servers.

Example:

```json
{
  "mcpServers": {
    "example": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${EXAMPLE_MCP_TOKEN}"
      }
    }
  }
}
```

## Headers helper

For network transports, `headersHelper` is executed at activation time. It must print a JSON object with string values to stdout.

```json
{
  "mcpServers": {
    "example": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headersHelper": "node ./scripts/mcp-headers.js"
    }
  }
}
```

The helper receives:

- `PI_MCP_SERVER_NAME`
- `PI_MCP_SERVER_URL`
- `PI_MCP_TRANSPORT`

## Dynamic list changes

Connected servers that advertise list-change capabilities can send `notifications/tools/list_changed`, `notifications/resources/list_changed`, and `notifications/prompts/list_changed`. `pi-mcp` refreshes the manifest, updates the cache, registers newly discovered tools/prompts, and deactivates stale tools with `pi.setActiveTools()`.

Known limitations:

- OAuth credentials are stored in a file, not an OS keychain.
- Pi does not currently expose unregister APIs for tools or slash commands. Stale tools are deactivated, and stale prompt command invocations show a warning.
