# Runbook — Add an external MCP server

Use this when you want the harness to consume tools from another MCP server
(filesystem, GitHub, a partner integration, …).

## 1. Create `mcp.config.json`

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/var/data/bevox"]
    }
  }
}
```

For an SSE remote:

```json
{
  "servers": {
    "github": {
      "transport": "sse",
      "url": "https://mcp.github.example.com/sse",
      "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" }
    }
  }
}
```

`${ENV_NAME}` placeholders inside `headers` and `env` are substituted from
`process.env` by the loader. The loader throws if a referenced variable is
missing — better to fail bootstrap than to send a literal placeholder.

Treat `mcp.config.json` as secret-equivalent: it may carry tokens after
interpolation. `chmod 600` on the file and store it outside the repo.

## 2. Configure env

```bash
MCP_CLIENT_ENABLED=true
MCP_SERVERS_CONFIG_PATH=/etc/bevox/mcp.config.json
MCP_CLIENT_TIMEOUT_MS=10000
# Optional — abort bootstrap if any server is unreachable. Default false.
MCP_REQUIRE_ALL=false
```

## 3. Restart the worker

```bash
npm run start
```

Expected log lines:

```
[bootstrap] mcp server connected serverId=filesystem skills=5
[bootstrap] Tools and permissions loaded: 17 tools registered, 17 skills loaded
```

If the server is unreachable and `MCP_REQUIRE_ALL=false`:

```
[bootstrap] mcp server connection failed serverId=filesystem — continuing without it: <reason>
```

## 4. Verify registration

There is no `/debug/skills` endpoint in V1 — validate via the bootstrap log
line above or by enabling `HARNESS_LOG_LEVEL=debug` and inspecting the skill
registry initialization.

## 5. Authorise an agent to use the new skills

`mcp:<server>.<tool>` skills are filtered by the existing 3-layer permission
evaluator. To let a surface agent call them, add the qualified name to its
`AgentDefinition.permissions.optional` (or `required`):

```ts
{
  ...
  permissions: {
    required: ["send-message"],
    optional: ["mcp:filesystem.read_text_file"],
    denied: [],
  },
}
```

## 6. Deny a specific MCP skill

Either add the qualified name to `permissions.denied` on the agent, or to the
account-level denied list in the execution context — both work transparently
because the evaluator is unchanged.

## 7. Tenancy reminder

The MCP boundary is opaque: the remote server does NOT receive `accountId` /
`contactId` / conversation key. If your remote server needs per-tenant
isolation, run **one entry per tenant** (e.g. a separate `filesystem` stdio
spawn with a different `--root` per account). The harness cannot enforce
tenancy at this layer.
