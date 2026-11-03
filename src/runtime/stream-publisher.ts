/**
 * StreamPublisher — singleton per execution.
 *
 * Responsibilities:
 *  - Consume a provider stream (`AsyncIterable<StreamChunk>`) via `pump()`.
 *  - Aggregate raw `token` chunks through `StreamBuffer` (size/time thresholds).
 *  - Track tool-call argument JSON across many `tool_call_delta` chunks and
 *    synthesize a `tool_call_complete` event once the accumulator is valid
 *    JSON. After `JSON_PARSE_MAX_FAILURES` failed attempts on the SAME
 *    toolCallId, emit an `error` chunk to surface the malformed stream to
 *    Bevox (without crashing the execution).
 *  - Assign a strictly-monotonic `seq` to every chunk before sending.
 *  - Be backpressure-safe: callback failures are warned (rate-limited) and
 *    swallowed; streaming is best-effort because the final `/complete`
 *    callback is the source of truth.
 *
 * Concurrency notes:
 *  - `seq` is captured into a local `const mySeq = this.seq++` BEFORE any
 *    `await`. This makes concurrent `emit()` calls deterministic — without
 *    it a `tool_call_delta` and a `reasoning_step` could end up out-of-order
 *    on the wire.
 */
import { createLogger } from "../config/logger.js";
import { sendStreamChunk } from "../integration/bevox-stream-callback.js";
import { StreamBuffer } from "../integration/llm/streaming/buffer.js";
import type { StreamChunk } from "../integration/llm/streaming/types.js";

const JSON_PARSE_MAX_FAILURES = 200;
/** Warn at most once per N callback failures to avoid log flooding when Bevox is down. */
const WARN_LOG_SAMPLE_EVERY = 100;

export interface StreamPublisherOptions {
  executionId: string;
  token: string;
  callbackBaseUrl: string;
  flushMs: number;
  flushTokens: number;
  callbackTimeoutMs: number;
  /** External abort signal — propagates to all in-flight HTTP callbacks. */
  externalSignal?: AbortSignal;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export class StreamPublisher {
  private seq = 0;
  private buffer: StreamBuffer;
  /** toolCallId → accumulated JSON arguments. */
  private toolArgBuffers = new Map<string, string>();
  /** toolCallId → tool name (captured at tool_call_start). */
  private toolNameByCallId = new Map<string, string>();
  /** toolCallId → consecutive parse-failure counter. */
  private parseFailures = new Map<string, number>();
  /** Aggregated full text emitted across the stream — exposed for direct engine fallback. */
  private fullText = "";
  /** Callback failure counter (for sampled warn logging). */
  private callbackFailures = 0;
  private readonly logger;
  private closed = false;

  constructor(private readonly opts: StreamPublisherOptions) {
    this.logger = createLogger({ name: "stream-publisher", level: "info" }).child({
      executionId: opts.executionId,
    });
    this.buffer = new StreamBuffer({
      flushMs: opts.flushMs,
      flushTokens: opts.flushTokens,
      onFlush: async ({ text }) => {
        this.fullText += text;
        await this.emit({ type: "token", payload: { delta: text } });
      },
    });
  }

  /**
   * Concatenated text emitted across the stream. Used by direct-engine
   * fallback to populate `AgentResponse.answer` when streaming.
   */
  getFullText(): string {
    return this.fullText;
  }

  /**
   * Consume a provider stream, fan out events. Always closes the buffer in
   * a `finally` block to avoid leaking pending timers.
   */
  async pump(stream: AsyncIterable<StreamChunk>): Promise<void> {
    try {
      for await (const chunk of stream) {
        await this.handleChunk(chunk);
      }
    } finally {
      try {
        await this.buffer.close();
      } catch {
        // ignore
      }
    }
  }

  private async handleChunk(chunk: StreamChunk): Promise<void> {
    switch (chunk.type) {
      case "token": {
        const { delta } = chunk.payload as { delta: string };
        this.buffer.push(delta);
        return;
      }
      case "tool_call_start": {
        const { toolCallId, name } = chunk.payload as { toolCallId: string; name: string };
        this.toolNameByCallId.set(toolCallId, name);
        await this.emit(chunk);
        return;
      }
      case "tool_call_delta": {
        const { toolCallId, argsDelta } = chunk.payload as {
          toolCallId: string;
          argsDelta: string;
        };
        const accum = (this.toolArgBuffers.get(toolCallId) ?? "") + argsDelta;
        this.toolArgBuffers.set(toolCallId, accum);
        await this.emit(chunk);
        // Try incremental parse — emit tool_call_complete when successful.
        try {
          const parsed = JSON.parse(accum);
          this.toolArgBuffers.delete(toolCallId);
          this.parseFailures.delete(toolCallId);
          await this.emit({
            type: "tool_call_complete",
            payload: {
              toolCallId,
              name: this.toolNameByCallId.get(toolCallId) ?? "",
              args: parsed,
            },
          });
        } catch {
          const n = (this.parseFailures.get(toolCallId) ?? 0) + 1;
          this.parseFailures.set(toolCallId, n);
          if (n >= JSON_PARSE_MAX_FAILURES) {
            this.parseFailures.delete(toolCallId);
            this.toolArgBuffers.delete(toolCallId);
            await this.emit({
              type: "error",
              payload: {
                message: `tool_call args JSON parse failed after ${n} deltas (toolCallId=${toolCallId})`,
                recoverable: true,
              },
            });
          }
        }
        return;
      }
      case "done": {
        // Drain any buffered tokens before signaling completion.
        await this.buffer.flush();
        await this.emit(chunk);
        return;
      }
      default: {
        await this.emit(chunk);
        return;
      }
    }
  }

  /**
   * Emit an ad-hoc event (used by reasoning engines for reasoning_step /
   * engine_strategy, and internally for buffered tokens). `seq` is captured
   * synchronously to preserve emission order.
   */
  async emit(partial: Omit<StreamChunk, "seq" | "timestamp">): Promise<void> {
    if (this.closed) return;
    // G.13: capture seq BEFORE any await.
    const mySeq = this.seq++;
    const chunk: StreamChunk = { ...partial, seq: mySeq, timestamp: Date.now() };
    try {
      await sendStreamChunk({
        baseUrl: this.opts.callbackBaseUrl,
        executionId: this.opts.executionId,
        token: this.opts.token,
        chunk,
        timeoutMs: this.opts.callbackTimeoutMs,
        externalSignal: this.opts.externalSignal,
        fetchImpl: this.opts.fetchImpl,
      });
    } catch (err) {
      this.callbackFailures += 1;
      // Rate-limited warn: 1 per WARN_LOG_SAMPLE_EVERY failures.
      if (this.callbackFailures % WARN_LOG_SAMPLE_EVERY === 1) {
        this.logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            chunkType: chunk.type,
            seq: chunk.seq,
            cumulativeFailures: this.callbackFailures,
          },
          "stream-chunk callback failed (sampled)",
        );
      }
    }
  }

  /** Close the publisher. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.buffer.close();
    } catch {
      // ignore
    }
  }
}
