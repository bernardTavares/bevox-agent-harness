# Runbook: Connect Claude Desktop to the Bevox MCP Server

This runbook walks through exposing the Bevox built-in skills to
Claude Desktop via the `bevox-mcp` stdio transport.

## 1. Build the binary

```bash
git clone <bevox-harness>
cd bevox-agent-harness
npm install
npm run build
```

Verify the binary exists and is runnable:

```bash
node ./dist/bin/bevox-mcp.js --transport stdio < /dev/null
# expect: process blocks waiting for JSON-RPC on stdin — kill with Ctrl+C
```

Optionally `npm link` so `bevox-mcp` is on PATH:

```bash
npm link
which bevox-mcp
```

## 2. Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "bevox": {
      "command": "node",
      "args": [
        "/absolute/path/to/bevox-agent-harness/dist/bin/bevox-mcp.js",
        "--transport",
        "stdio"
      ],
      "env": {
        "DATABASE_URL": "postgres://localhost:5432/bevox_dev",
        "REDIS_URL": "redis://localhost:6379",
        "BEVOX_CALLBACK_BASE_URL": "http://localhost:3000",
        "CALENDAR_SERVICE_URL": "http://localhost:3009/api",
        "MCP_EXPOSED_SKILLS": "knowledge.*,calendar.read-calendar,calendar.list-appointments",
        "BEVOX_DEFAULT_ACCOUNT_ID": "1"
      }
    }
  }
}
```

> **REDIS_URL / BEVOX_CALLBACK_BASE_URL / CALENDAR_SERVICE_URL** are
> validated by Zod even when their subsystems are not used by the MCP
> server. Provide syntactically valid values.

If `bevox-mcp` is on PATH after `npm link`, you can use the shorter form:

```json
{
  "mcpServers": {
    "bevox": {
      "command": "bevox-mcp",
      "args": ["--transport", "stdio"],
      "env": { /* same env block */ }
    }
  }
}
```

## 3. Verify in Claude Desktop

1. Quit Claude Desktop fully (not just close the window).
2. Relaunch.
3. In a new conversation, click the tools / wrench icon. You should
   see entries prefixed with the skill category, e.g.
   `knowledge.search-faq`, `calendar.read-calendar`.
4. Ask Claude: "Use the search-faq tool to look up 'refund policy'".
   Confirm Claude calls the tool, receives a structured JSON
   response, and reads it back to you.

## 4. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Tools menu empty | `MCP_EXPOSED_SKILLS` unset or fail-closed | Set a non-empty glob in the `env` block. |
| Claude shows `messaging.send-message` is missing | `stop_signal` skills are filtered by design | They are not exposable via MCP — use the Bevox worker. |
| Claude shows the server crashed | Pino logged to stdout corrupted the channel | Confirm you are on a build that uses `src/mcp/logger.ts` (stderr destination). |
| 401 errors when adding SSE | Bearer mismatch | Confirm `MCP_SERVER_TOKEN` is identical on both ends and ≥32 chars. |
| Process hangs without responding | Missing env vars at startup | Run the binary manually from a terminal to see Zod validation errors. |

## 5. SSE deployment (advanced)

For remote agents, run `bevox-mcp --transport sse` behind a TLS proxy:

```bash
export MCP_TRANSPORT=sse
export MCP_SERVER_TOKEN=$(openssl rand -hex 32)
export MCP_EXPOSED_SKILLS=knowledge.*
export MCP_SSE_HOST=0.0.0.0
export MCP_SSE_PORT=7071
bevox-mcp --transport sse
```

The client must send `Authorization: Bearer <token>` on both the
GET /sse handshake and every POST /messages call. Use a proxy with
`proxy_buffering off` (nginx) to avoid SSE chunking issues. **SSE
is deprecated in the MCP spec** — track migration to Streamable
HTTP once client adoption catches up.

## 6. Pin tool versions

- `@modelcontextprotocol/sdk` is pinned to `^1.29.0` in this repo.
- The MCP Inspector for ad-hoc debugging:
  `npx @modelcontextprotocol/inspector@0.13.0 node dist/bin/bevox-mcp.js --transport stdio`
