/**
 * HTTP client for `POST {BEVOX_CALLBACK_BASE_URL}/api/v1/executions/{id}/stream`.
 *
 * Contract (see `docs/streaming/README.md` and audit finding H-CB-03):
 *  - Header `X-Execution-Token: <token>`.
 *  - Body: `BackendStreamChunk` JSON = `{ chunk: string, index: number }`.
 *    The harness `StreamChunk` envelope `{type, seq, timestamp, payload}` is
 *    serialized into `chunk` (JSON string) so the backend can keep all event
 *    metadata while satisfying the wire schema. `index` mirrors `seq`
 *    (monotonic per execution).
 *  - Response: any 2xx accepted (backend returns 200 with `{accepted, index}`).
 *  - Idempotency: Bevox deduplicates by `(execution_id, index)`.
 *  - SLA: <50ms p95; harness aborts the request at `timeoutMs` and continues.
 *
 * History: prior to 2026-06-02 (H-CB-03 fix) the harness POSTed to
 * `/stream-chunk` with the raw envelope shape — backend route is `/stream`
 * with the trimmed `{chunk, index}` shape, so every stream call 404'd /
 * 400'd in production. The mapping below is the seam that aligns harness
 * to backend without churning the internal event model.
 *
 * The caller is responsible for handling errors. This function intentionally
 * throws on any non-2xx so `StreamPublisher` can decide whether to log/warn.
 */
import type { StreamChunk } from "./llm/streaming/types.js";

/**
 * Backend wire schema (see `bevox-backend/src/integration/harness-callbacks.schema.ts`,
 * `StreamCallbackSchema`).
 *
 *  - `chunk` is the serialized harness envelope, capped at 4096 chars to
 *    match the backend `z.string().max(4096)`. Overflow is truncated with
 *    a `…` suffix; truncation is acceptable because the final `/complete`
 *    callback carries the canonical full response (streaming is observability,
 *    not source of truth).
 *  - `index` is the monotonic sequence number; collisions are deduped by
 *    the backend Redis buffer key `stream:{execution_id}`.
 */
export interface BackendStreamChunk {
  chunk: string;
  index: number;
}

/** Hard limit per `StreamCallbackSchema.chunk` (z.string().max(4096)). */
export const STREAM_CHUNK_MAX_CHARS = 4096;

/**
 * Map harness `StreamChunk` → backend wire shape `{chunk, index}`.
 *
 * Exposed for testing the contract seam without spinning up an HTTP client.
 */
export function toBackendStreamChunk(chunk: StreamChunk): BackendStreamChunk {
  const envelope = JSON.stringify({
    type: chunk.type,
    seq: chunk.seq,
    timestamp: chunk.timestamp,
    payload: chunk.payload,
  });
  const truncated =
    envelope.length > STREAM_CHUNK_MAX_CHARS
      ? envelope.slice(0, STREAM_CHUNK_MAX_CHARS - 1) + "…"
      : envelope;
  return { chunk: truncated, index: chunk.seq };
}

export interface SendStreamChunkOptions {
  baseUrl: string;
  executionId: string;
  token: string;
  chunk: StreamChunk;
  timeoutMs: number;
  /** External abort (e.g. execution-level cancel). */
  externalSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function sendStreamChunk(opts: SendStreamChunkOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("stream-chunk timeout")), opts.timeoutMs);
  const onExternalAbort = (): void => ac.abort(opts.externalSignal?.reason);
  if (opts.externalSignal) {
    if (opts.externalSignal.aborted) ac.abort(opts.externalSignal.reason);
    else opts.externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const url = `${opts.baseUrl}/api/v1/executions/${opts.executionId}/stream`;
    const body = toBackendStreamChunk(opts.chunk);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Execution-Token": opts.token,
        Connection: "keep-alive",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`stream-chunk HTTP ${res.status}: ${text}`);
    }
  } finally {
    clearTimeout(timer);
    if (opts.externalSignal) {
      opts.externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
