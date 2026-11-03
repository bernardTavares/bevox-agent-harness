# Bevox Harness Playground

Local-only dev UI to inspect agent executions in real time. Subscribes to a
WebSocket fed by the harness when `HARNESS_DEV_MODE=1` is set, and renders a
live list of executions, drill-down timelines, prompt/response inspectors,
tool I/O viewers, and a time-travel slider.

> NEVER deploy with `HARNESS_DEV_MODE=1` in production. The bootstrap stage
> `start-dev-ws` refuses to bind the WS server when `NODE_ENV=production`,
> and the server defaults to `127.0.0.1` so it cannot be reached off-box.

## Running

From the repository root:

```bash
npm install                  # one-time
npm run playground           # harness (dev) + UI (Vite)
```

This boots:

- the harness via `cross-env HARNESS_DEV_MODE=1 npm run dev` on the default ports,
- the Vite dev server on `http://localhost:4401`.

Dispatch a job to the queue (`smoke:enqueue` script) and watch the row
appear in the executions list. Click into it for the timeline.

To run the UI alone (against a harness already started elsewhere with
`HARNESS_DEV_MODE=1`):

```bash
npm run playground:ui
```

Override the WS URL with `VITE_HARNESS_WS_URL=ws://other-host:4400 npm run playground:ui`.

## Architecture

```
harness process                                   playground (browser)
─────────────────                                  ─────────────────────
src/dev/event-bus.ts  ── emitEvent(DevEvent) ──┐
src/runtime/execution-handler.ts               │
src/integration/llm/dev-emitter-decorator.ts   │
src/dev/otel-bridge.ts (optional, with F4)     │
                                               ▼
                                        src/dev/ws-server.ts
                                        ws://127.0.0.1:4400
                                               │
                                               ▼  JSON DevEvent frames
                                        playground/src/api/ws-client.ts
                                        → useStore.ingest(event)
                                        → React views re-render
```

Span events flow through the **in-process** event bus — no OTLP collector,
no external pipeline. When F4 (`OTEL_ENABLED=true`) is wired the
`DevEventSpanProcessor` also publishes finished spans to the same bus, so
the timeline gets richer; otherwise events come direct from the
execution-handler hooks.

## Configuration

Harness env vars consumed by the playground integration:

| Var | Default | Description |
|---|---|---|
| `HARNESS_DEV_MODE` | `false` | Master switch. When unset, all dev hooks are no-ops. |
| `HARNESS_DEV_WS_HOST` | `127.0.0.1` | Bind host. Keep localhost. |
| `HARNESS_DEV_WS_PORT` | `4400` | WS server port. |
| `HARNESS_DEV_PROMPT_MAX_BYTES` | `8192` | UTF-8 byte budget for prompt/response truncation in `llm.call` events. |
| `HARNESS_DEV_WS_BACKPRESSURE_BYTES` | `1048576` | Per-client `bufferedAmount` threshold beyond which broadcast frames are dropped. |

Vite-side:

| Var | Default | Description |
|---|---|---|
| `VITE_HARNESS_WS_URL` | `ws://127.0.0.1:4400` | Override harness WS URL. |

## Out of Scope

Explicitly **not** in this MVP. Each was considered and consciously deferred:

1. **Deterministic replay** — re-executing a stored trace against the harness. Would require snapshotting all I/O (LLM, calendar service, DB rows touched). Time-travel here is visual only.
2. **Durable persistence** — events live in browser memory (capped to last 200 executions). Refresh = blank slate.
3. **Real authentication** — the WS is bound to `127.0.0.1` with an Origin check. No tokens, no users, no ACLs. Single-developer assumption.
4. **Export / sharing** — no JSON dump or screenshot capture beyond the URL fragment for the time slider.
5. **Live prompt editing** — the playground is a read-only viewer; tweaking and re-running prompts belongs in a separate "playground compose" tool.
6. **Multi-tenant filtering UI** — the account filter is a single input; no tenant directory.
7. **OTLP collector deployment** — spans flow via the in-process event bus, never out to an external collector.

## Performance notes

- Broadcast uses per-client `bufferedAmount` check; clients exceeding the
  threshold simply drop frames (tracked in `getDevWsMetrics().droppedEvents`).
- The store evicts the oldest started execution once size exceeds 200.
- Filters run in a `useMemo` against the executions Map.

## Security posture

- Bound to loopback (`127.0.0.1`) by default.
- `verifyClient` rejects upgrades whose `Origin` header is non-local.
- Pre-binary deny when `NODE_ENV=production` — bootstrap will not call `startDevWsServer`.
- Prompts and responses are byte-truncated before broadcast (`HARNESS_DEV_PROMPT_MAX_BYTES`).
- No PII redaction beyond truncation — do not leave this on while screen-sharing customer data.
