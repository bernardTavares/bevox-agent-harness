# MCP Server

The Bevox harness ships a standalone Model Context Protocol (MCP) server
binary, `bevox-mcp`, that exposes a configurable subset of the built-in
skills (`src/skills-builtin/**`) as MCP tools. Clients like Claude Desktop,
Cursor, Cline, and Zed can then consume Bevox capabilities as native tools.

## Design

```
bevox-mcp process
  ├── src/mcp/bootstrap.ts        # minimal bootstrap: SkillRegistry + PG pool
  ├── src/mcp/server.ts           # buildMcpServer() — adapts skills to MCP tools
  ├── src/mcp/transports/
  │     ├── stdio.ts              # Claude Desktop spawn
  │     └── sse.ts                # bearer-authenticated SSE (deprecated path)
  └── src/bin/bevox-mcp.ts        # CLI entrypoint (--transport stdio|sse)
```

The MCP server **does not run inside the worker process**. The BullMQ
consumer in `src/runtime/` and the MCP server are independently
lifecycle-managed; they share only the on-disk skills tree and the
PostgreSQL schema. This isolation lets Claude Desktop SIGTERM the MCP
process at will without affecting in-flight Bevox executions.

## Skill exposure (fail-closed)

Skills are filtered through two stages before reaching an MCP client:

1. **Static side-effect filter.** Skills with
   `permissions.sideEffects: ["stop_signal"]` (currently `send-message`
   and `request-human`) are dropped unconditionally. They depend on a
   Bevox `executionToken` to flow into HTTP callbacks — an MCP caller
   cannot provide one.

2. **Whitelist glob.** `MCP_EXPOSED_SKILLS` is a CSV of micromatch
   patterns over the dotted id `${category}.${name}`. Empty/unset =
   zero tools exposed. Examples:

   - `MCP_EXPOSED_SKILLS=knowledge.*` — only `search-faq`.
   - `MCP_EXPOSED_SKILLS=calendar.*,memory.read-profile` — calendar
     family plus a single memory read.
   - `MCP_EXPOSED_SKILLS=*` — every skill that isn't `stop_signal`
     (still subject to runtime denial).

## Runtime permissions

Every tool invocation flows through the existing 3-layer
`evaluatePermission` in `src/permissions/evaluator.ts`. The MCP server
synthesises:

- An **AgentDefinition** named `mcp-external` (built by
  `buildExternalAgentDefinition` in `permission-filter.ts`). By default
  it denies stop-signal skills and the write-* memory skills. The
  `MCP_DENIED_SKILLS` env var appends extra names.
- A fresh **PermissionContext** per call
  (`buildMcpPermissionContext`) with a synthetic `mcp-<uuid>`
  executionId and the configured `BEVOX_DEFAULT_ACCOUNT_ID`.

Denied calls return `isError: true` with `error: "PERMISSION_DENIED"`
and the denial reason as a string — never a stack trace.

## Schema adaptation

The MCP SDK expects Zod schemas via `registerTool`. Manifests ship
JSON Schema. A narrow converter in
`src/mcp/adapters/json-schema-to-zod.ts` handles the shapes used by
the built-in skills (string/number/boolean/object/array, with `enum`,
`minimum`, `maximum`, `default`, `description`). Unknown nodes fall
through to `z.unknown()` — the skill itself remains the final
validator at runtime.

## Logger isolation

The stdio transport uses fd 1 (stdout) as the JSON-RPC channel. The
shared Pino factory in `src/config/logger.ts` writes to stdout, which
would corrupt the protocol. The MCP-side logger
(`src/mcp/logger.ts`) is bound to `pino.destination(2)` (stderr) and
must be the only logger used inside `src/mcp/**`.

## Transports

### stdio

Local spawn. Used by Claude Desktop and CLI clients. No auth — the
client owns the pipe. One McpServer instance per process. See the
[Claude Desktop runbook](../runbooks/mcp-server-claude-desktop.md).

### SSE (deprecated)

HTTP server-sent events. The MCP spec recommends Streamable HTTP
going forward; we keep SSE because most current clients still ship
SSE support only. Treat as tech debt — migrate when client coverage
allows.

- Bearer auth on every endpoint, constant-time compared.
- **One McpServer per session.** The MCP SDK Protocol owns its
  transport (a second `connect()` throws). The HTTP server invokes a
  factory on each GET /sse to mint a fresh server.
- Behind a proxy, configure `proxy_buffering off` (nginx) /
  `proxy_request_buffering off` and a long idle timeout.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `MCP_TRANSPORT` | — | `stdio` or `sse`. Required for SSE token check. |
| `MCP_EXPOSED_SKILLS` | — (empty = fail-closed) | CSV glob over `${category}.${name}`. |
| `MCP_DENIED_SKILLS` | — | CSV of bare names appended to the runtime deny list. |
| `MCP_SERVER_TOKEN` | — | Bearer for SSE. ≥32 chars required when transport=sse. |
| `MCP_SSE_HOST` | `127.0.0.1` | Bind host for SSE. |
| `MCP_SSE_PORT` | `7071` | TCP port for SSE. |
| `BEVOX_DEFAULT_ACCOUNT_ID` | — | Numeric account id used in the synthetic execution context. |

## Known limits

- Skills that depend on `ctx.llmClient` are not exposed — the MCP
  process intentionally provides only a `StubLlmClient` that rejects
  every call. If you need LLM-backed skills via MCP, wire a real
  `LlmClient` into `src/mcp/bootstrap.ts`.
- Skills with `sideEffects: ["stop_signal"]` are always filtered.
  `send-message` and `request-human` are not exposed.
- One MCP server process per host; not horizontally scaled. The MCP
  protocol is stateful by client connection.

## Security checklist

- [ ] `MCP_SERVER_TOKEN` rotated periodically; never logged.
- [ ] `MCP_EXPOSED_SKILLS` reviewed every release — explicit allow-list
      only, no `*` in production.
- [ ] `BEVOX_DEFAULT_ACCOUNT_ID` set to a dedicated tenant — MCP
      clients see only that account's data.
- [ ] Logs scanned for PII via existing `buildRedactionConfig`.
- [ ] SSE deployments behind TLS terminating proxy — bearer alone is
      not authentication on the wire.
