# MCP Client (Sprint B.2)

> **Status:** V1 — see `docs/superpowers/plans/2026-05-14-sprint-b-2-mcp-client.md` for the implementation plan.

## What it is

The harness can connect — as a *client* — to external MCP servers (filesystem,
GitHub, Slack, Linear, custom partner servers, …) and expose their tools to
surface agents as if they were native skills. Each remote tool is adapted into
a `LoadedSkill` and registered in the existing `SkillRegistry` under the
namespace `mcp:<server-id>.<tool-name>`.

Reasoning engines, the context builder, and the 3-layer permission evaluator
do **not** distinguish MCP-proxied skills from built-in ones. The prefix is
semantic (telemetry, debugging, denial lists) — **security comes from the
evaluator, not the prefix.**

## How it bootstraps

```
load-tools-permissions   → 12 built-in skills registered
load-mcp-clients         → ← NEW: connect external servers, register their tools
calendar-health
start-consumer
```

The `load-mcp-clients` stage:

1. Calls `loadMcpClientConfig()` — returns `null` if `MCP_CLIENT_ENABLED=false`
   or no config path supplied (then the stage no-ops).
2. For each entry in `servers`, spawns the transport (`stdio` subprocess or
   `sse` HTTP), opens a `Client`, and calls `listTools()`.
3. Each remote `Tool` is passed through `validateRemoteInputSchema` (Ajv) and
   `skillManifestSchema.safeParse`. Tools that fail either check are skipped
   with a warn log.
4. Surviving skills are registered in `SkillRegistry` and mirrored into
   `ToolRegistry` (legacy consumers).
5. `startMcpHealthLoop()` schedules a 60 s heartbeat (`listTools` as ping).

## Graceful degradation

A single unreachable server logs an error and is skipped — the worker boots
without that tool set. Set `MCP_REQUIRE_ALL=true` to invert this (any
connection failure throws and the bootstrap aborts).

Once running, a remote server that goes down is **not** evicted in V1: the
heartbeat logs `mcp server unhealthy` and any subsequent `callTool` returns
`MCP_CALL_FAILED` through the reasoning loop. V2 will mark such skills
`unavailableTools` for the evaluator.

## Security boundary — Bevox context does NOT cross MCP

The remote server sees neither `accountId` nor `contactId` nor the
conversation key. The MCP boundary is opaque. **Multi-tenant segregation must
be enforced on the server side** — e.g. spawn one `filesystem` stdio entry
per account, each with its own root directory. The harness cannot pass tenancy
through the protocol.

Consequence: every MCP skill defaults to `category: "knowledge"` (read-only
class). Operators that want to elevate a remote tool to `memory` or
`calendar` must opt in via a mapping config (planned V2; today: edit the
adapter call site).

## Config interpolation

`mcp.config.json` accepts `${ENV_NAME}` placeholders inside `headers` (sse)
and `env` (stdio). The loader (`src/config/mcp-servers.ts`) substitutes them
from `process.env` and throws if a referenced var is undefined — preventing
literal `Bearer ${TOKEN}` from reaching the remote.

## Error surface

| Condition | `ToolResult` |
|-----------|-------------|
| Remote returns `isError: true` | `{ success: false, error: "MCP_TOOL_ERROR", detail: <text> }` |
| Call exceeds `MCP_CLIENT_TIMEOUT_MS` | `{ success: false, error: "MCP_CALL_FAILED", detail: "MCP timeout: …" }` |
| Transport throws (server gone, network) | `{ success: false, error: "MCP_CALL_FAILED", detail: <message> }` |

Successful calls return `{ success: true, data: { text, raw } }` where `text`
is the concatenation of `text`-typed content parts and `raw` is the full
content array.

## Shutdown

`McpClientRegistry.closeAll()` is wired into `registerShutdownHandlers`. It
cancels the health interval and `close()`s every active client. Stdio
transports kill their subprocess via `transport.close()`.

## Known V1 limitations

- **No dynamic eviction of dead servers.** A stale entry surfaces failure on
  the next call (not at evaluator time).
- **No category override config.** Every tool is `knowledge` by default;
  promote manually if needed.
- **No `outputSchema` propagation.** The remote `outputSchema` (when present)
  is ignored — `data.raw` is the source of truth.
- **No retry of `tools/list` after first success.** If the remote adds a tool
  while the harness is running, it is not picked up until restart.
