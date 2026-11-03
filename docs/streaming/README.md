# Streaming Responses (Sprint C.2)

> Status: implemented in harness behind feature flag `STREAM_ENABLED=false`. Backend route is `POST /api/v1/executions/{id}/stream` (per `bevox-backend/src/integration/harness-callbacks.routes.ts`). The harness wire path was corrected from `/stream-chunk` → `/stream` and the wire shape from `{type, seq, timestamp, payload}` → `{chunk, index}` on 2026-06-02 (audit finding H-CB-03). Keep `STREAM_ENABLED=false` outside dev until backend digest is pinned in the manifest.

## Goal

Reduce perceived TTFB when a surface agent takes 5–15 seconds of reasoning by streaming intermediate events (LLM tokens, tool calls, reasoning steps) from the harness to Bevox in real time. Backward-compatible by design: `LLMGateway.complete()` is unchanged; streaming uses the new optional `LLMGateway.completeStream()`.

## Architecture

```
Bevox → BullMQ → Harness
                  │
                  ├── stream-chunk { token "Olá" }     → Bevox
                  ├── stream-chunk { token ", como" }  → Bevox
                  ├── stream-chunk { tool_call_start } → Bevox
                  ├── stream-chunk { tool_result }     → Bevox
                  ├── stream-chunk { token " sua..." } → Bevox
                  ├── stream-chunk { done }            → Bevox
                  └── complete (final)                 → Bevox
```

Components introduced:

- `src/integration/llm/streaming/types.ts` — `StreamChunk`, `CompleteStreamOptions`, `StreamCallback`.
- `src/integration/llm/streaming/{openai,anthropic,gemini}-stream.ts` — provider-specific SSE parsers.
- `src/integration/llm/streaming/buffer.ts` — `StreamBuffer` (size/time aggregation).
- `src/runtime/stream-publisher.ts` — per-execution orchestrator (monotonic `seq`, tool-arg JSON assembly, callback fan-out).
- `src/integration/bevox-stream-callback.ts` — HTTP client for `/stream` (envelope → `{chunk, index}` mapping via `toBackendStreamChunk`).

Decorator strategy: streaming **bypasses** retry and circuit-breaker logic (with explicit health accounting). See [ADR 013](../adr/013-streaming-bypasses-retry-circuit.md).

## Bevox endpoint contract

```
POST {BEVOX_CALLBACK_BASE_URL}/api/v1/executions/{executionId}/stream
Headers:
  Content-Type: application/json
  X-Execution-Token: <token from BullMQ payload>
  Connection: keep-alive
Body: { "chunk": "<serialized StreamChunk envelope, ≤4096 chars>", "index": <seq> }
Expected response: 200 with `{accepted: true, index}` (any 2xx accepted)
SLA target: <50ms p95
```

The `chunk` field is a JSON string of the harness `StreamChunk` envelope
(`{type, seq, timestamp, payload}`) so all event metadata survives the wire.
Cap is `z.string().max(4096)` on the backend — `toBackendStreamChunk` truncates
with a `…` suffix when overflow occurs (acceptable: streaming is observability,
the canonical full response arrives in `/complete`).

Harness behaviour:

- Per-request timeout: `STREAM_CALLBACK_TIMEOUT_MS` (default 5000). Aborts and continues — streaming is best-effort.
- Failures are logged with sampled warnings (1 per 100 failures) to avoid log floods if Bevox is down.
- Streaming failure NEVER fails the execution. The final `POST /complete` is the source of truth.

### Idempotency / ordering

Each `StreamChunk` carries a monotonic `seq` integer per execution (assigned by `StreamPublisher.emit`). On the wire, `seq` is sent as the `index` field. Under unreliable networks chunks may arrive out of order; Bevox MUST deduplicate by `(execution_id, index)` and SHOULD reorder before delivering to the UI. The backend Redis buffer key is `stream:{execution_id}` with a 1h sliding TTL.

### StreamChunk shape

```typescript
type StreamChunkType =
  | "token" // delta of LLM text
  | "tool_call_start" // LLM started emitting a tool_call (name known)
  | "tool_call_delta" // delta of arguments JSON (partial)
  | "tool_call_complete" // arguments parsed OK
  | "tool_result" // result of the tool execution
  | "reasoning_step" // engine advanced one step (ReAct/PlanExecute)
  | "engine_strategy" // escalation: engine changed
  | "error" // recoverable error
  | "done"; // end of stream

interface StreamChunk {
  type: StreamChunkType;
  seq: number;
  timestamp: number; // ms epoch
  payload: unknown; // shape depends on type
}
```

Payload shapes (informal):

| type                 | payload                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `token`              | `{ delta: string }`                                                             |
| `tool_call_start`    | `{ toolCallId: string, name: string }`                                          |
| `tool_call_delta`    | `{ toolCallId: string, argsDelta: string }`                                     |
| `tool_call_complete` | `{ toolCallId: string, name: string, args: unknown }`                           |
| `tool_result`        | `{ toolCallId: string, success: boolean, output: unknown, durationMs: number }` |
| `reasoning_step`     | `{ strategy: string, stepIndex: number, summary: string }`                      |
| `engine_strategy`    | `{ from: string, to: string, reason: string }`                                  |
| `error`              | `{ message: string, recoverable: boolean }`                                     |
| `done`               | `{ totalTokens?: number, totalDurationMs: number }`                             |

## Feature flag matrix

| `STREAM_ENABLED` (env) | `payload.stream` (BullMQ) | Effective behaviour                                                     |
| ---------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `false`                | (any)                     | No streaming. Logs nothing.                                             |
| `true`                 | `false` / unset           | No streaming. Classic `complete()` path only.                           |
| `true`                 | `true`                    | Streaming enabled. Publisher instantiated, reasoning hooks emit events. |

Note: `false` (global) **always wins** over a true per-execution flag. A warn log is emitted when payload requests streaming but the global flag is off.

## Configuration (env)

| Variable                     | Default | Notes                                              |
| ---------------------------- | ------- | -------------------------------------------------- |
| `STREAM_ENABLED`             | `false` | Master switch.                                     |
| `STREAM_FLUSH_MS`            | `100`   | Max time tokens accumulate before flush (50–2000). |
| `STREAM_FLUSH_TOKENS`        | `50`    | Max deltas before flush (1–500).                   |
| `STREAM_CALLBACK_TIMEOUT_MS` | `5000`  | Per-callback timeout (500–30000).                  |

## Gating before production

`STREAM_ENABLED=true` MUST NOT ship to production until **both** boxes are checked:

- [ ] Bevox backend exposes `POST /api/v1/executions/{id}/stream-chunk` and returns 2xx (typically 204) for valid payloads. Smoke test recorded with cURL or via the harness's `tests/integration/streaming-e2e.test.ts`.
- [ ] ADR 013 reviewed and signed off by the Bevox backend owner (covers contract, retry/breaker decisions, and SLA).

Local validation:

```bash
# 1) Run the unit + integration tests
npm test

# 2) Run the streaming-only suite
npx vitest run tests/unit/integration/llm/streaming tests/integration/streaming-e2e

# 3) Manual smoke (requires real LLM keys + a mock Bevox listener):
STREAM_ENABLED=true npm run dev
# enqueue a job with payload.stream = true
```

## Failure modes & error handling

| Failure                         | Behaviour                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Bevox `/stream` 5xx / 429       | Warn (sampled). Streaming continues; execution unaffected.                                                                 |
| Bevox unreachable (timeout)     | Same as above.                                                                                                             |
| Provider stream HTTP 5xx        | `error` chunk emitted; circuit breaker informed via `recordExternalFailure`.                                               |
| Provider stream HTTP 4xx (auth) | Credential pool marks key down; no breaker impact.                                                                         |
| Malformed tool_call_args JSON   | Publisher tries `JSON.parse` per delta; after 200 consecutive failures emits an `error` chunk and abandons that tool call. |
| AbortSignal fires               | All in-flight stream callbacks abort; `pump`'s `finally` closes the buffer.                                                |

## Limitations (v1)

- Cassette record/replay does NOT support streaming. Use `LLM_RECORDER_MODE=passthrough` for streaming code paths.
- Reasoning engines other than `direct` continue to call `complete()` for each step's LLM round-trip (only `reasoning_step` + `tool_result` are streamed). A follow-up sprint can stream per-step LLM tokens.
- Rate limiting per-tokens is not enforced (provider rate limits still apply). A future sprint can wire token counters into a billing decorator.

## Related docs

- [ADR 013 — Streaming bypasses retry/circuit](../adr/013-streaming-bypasses-retry-circuit.md)
- [Plan: Sprint C.2 Streaming Responses](../superpowers/plans/2026-05-14-sprint-c-2-streaming.md)
