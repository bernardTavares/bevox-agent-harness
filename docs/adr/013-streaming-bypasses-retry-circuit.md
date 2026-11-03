# ADR 013: Streaming bypasses retry and dynamically informs the circuit breaker

- **Status:** Accepted
- **Date:** 2026-05-14
- **Context:** Sprint C.2 — Streaming Responses

## Context

Sprint C.2 adds an opt-in streaming variant of `LLMGateway.completeStream()`.
The existing decorator chain — `DevEmitter → Recorder?/Replayer? → Retry →
CircuitBreaker → adapter` — was designed exclusively for single-shot
`complete()` calls that resolve to a fully-formed `LLMResponse`.

We must decide how each decorator interacts with the new `AsyncIterable<StreamChunk>` surface.

## Decision

1. **Retry decorator → pass-through.** Streaming requests are NOT retried.
   Partial state (tokens, tool_call deltas) has already been delivered to the
   consumer. Retrying would either:
   - Duplicate chunks (replay deltas already emitted) — corrupting the
     consumer's reconstruction; or
   - Lose state by abandoning the in-flight iterator at an arbitrary point.

   Justification: retries are a convenience for short-lived RPCs. Streaming
   is inherently stateful; retry semantics must be defined at the consumer
   (StreamPublisher) level, not the transport level.

2. **Circuit breaker → pass-through, with explicit health accounting.** The
   breaker's `fire()` helper expects a single `Promise<T>`. Wrapping an
   `AsyncIterable` would either evaluate "success" too eagerly (before the
   first chunk) or block indefinitely waiting for `done`.

   Instead, `CircuitBreakerDecorator.completeStream` checks the breaker
   state up front (refusing fast if `open`), then calls
   `recordExternalFailure()` / `recordExternalSuccess()` on the underlying
   `CircuitBreaker` based on the FIRST observed error or the completion of
   the iterable. Health-relevant errors (HTTP 5xx, 429, network) trip the
   breaker so subsequent synchronous calls fail fast.

3. **DevEmitter, Recorder → pass-through.** Dev playground events for
   streaming arrive at the consumer via the `StreamPublisher` (also wired
   into the dev bus in Sprint C.2 follow-ups); duplicating them at the
   decorator would double-count tokens. Cassette recording of streams is
   deferred to a later sprint (requires capturing the full chunk sequence).

4. **Replayer → throw.** Replay mode is intentionally strict; emitting
   synthetic chunks from a non-streaming cassette would silently lie. Tests
   that want to exercise streaming must use `LLM_RECORDER_MODE=passthrough`
   with a mocked `fetch`.

## Consequences

**Positive:**
- The existing `complete()` semantics are preserved bit-for-bit. The
  snapshot test in `tests/unit/integration/llm/streaming/complete-backward-compat.test.ts`
  enforces this by replaying a recorded fixture and asserting the response
  shape is byte-identical to the baseline.
- A degraded provider still trips the breaker, even when only streaming
  calls are in flight.

**Negative:**
- Cassette replay of streaming is not supported. Tests must mock `fetch`
  directly. This is acceptable for V1; a follow-up sprint can extend the
  cassette schema to record chunk arrays.
- Streaming callers must handle errors directly (no retry safety net).
  `StreamPublisher` emits an `error` chunk before propagating; consumers
  decide whether to retry at the application level.

## Alternatives considered

- **Wrap streams in retry.** Rejected — see #1 above. Even with
  idempotency tokens, providers don't guarantee reproducibility, so resuming
  is not equivalent to restarting.
- **Run breaker's `fire()` on `pump` completion.** Rejected — `pump` is owned
  by `StreamPublisher`, not the decorator. Coupling them would invert the
  dependency direction.

## Related

- `src/integration/llm/circuit-breaker.ts` — `recordExternalFailure`,
  `recordExternalSuccess`, `completeStream`.
- `src/integration/llm/retry-decorator.ts` — pass-through `completeStream`.
- `src/runtime/stream-publisher.ts` — orchestrates the `pump` and emits
  `error` chunks.
