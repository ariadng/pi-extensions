# pi-mcp

Lazy Model Context Protocol (MCP) client support for Pi.

This package loads MCP server configuration from `~/.pi/agent/mcp.json`, project `.mcp.json`, and `.pi/mcp.local.json`, but it does **not** connect to or spawn configured servers during Pi startup. Servers are dormant until activated by `/mcp activate <server>`, `mcp_activate_server`, a resource read/list request, an MCP prompt command, or a cached MCP proxy tool call.

Supported transports are `stdio`, streamable `http`, `sse`, and `ws`. HTTP/SSE/WS servers can use static headers, `headersHelper`, or OAuth via `/mcp auth <server>` / `mcp__<server>__authenticate`. Connected servers that emit MCP list-change notifications are refreshed automatically. See [`docs/transport-compatibility.md`](docs/transport-compatibility.md) for the compatibility matrix and auth/header notes.

## Development

```bash
npm install
npm run typecheck
npm test
pi -e /Users/optizon/Personal/pi-extensions/mcp
```

## Example `.mcp.json`

```json
{
  "mcpServers": {
    "echo": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/optizon/Personal/pi-extensions/mcp/test/fixtures/echo-server.mjs"]
    }
  }
}
```

Inside Pi:

```text
/mcp
```

The no-argument `/mcp` command opens an interactive manager: select a server, then activate/reconnect/authenticate, view tools/resources/prompts, or enable/disable it. Plain/scriptable subcommands still work:

```text
/mcp list
/mcp activate echo
```

Or ask the agent to use the echo MCP tool.

MCP prompts are exposed as slash commands after activation or from a cached manifest, using names like `/mcp__echo__echo_prompt`. Prompt commands insert the rendered prompt text into the editor for review.

OAuth opens the authorization URL in your default browser automatically and stores credentials in `~/.pi/agent/mcp-auth.json` by default. Use `/mcp clear-auth <server|all>` to remove stored MCP OAuth credentials. Set `PI_MCP_OPEN_BROWSER=0` to disable automatic browser opening.
