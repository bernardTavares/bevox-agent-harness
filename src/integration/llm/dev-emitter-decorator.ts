import { getEnv } from "../../config/env.js";
import { getDevEventBus, isDevModeEnabled } from "../../dev/event-bus.js";
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway.js";

import type { CompleteStreamOptions, StreamChunk } from "./streaming/types.js";

/**
 * Outermost LLM gateway decorator. When dev mode is enabled, it captures
 * every completed call (including retries; latency is total caller-visible)
 * and publishes a `llm.call` event to the dev bus for the playground UI.
 *
 * Composition order (outer → inner): DevEmitter → Retry → CircuitBreaker → adapter.
 */
export class DevEmitterLLM implements LLMGateway {
  constructor(private readonly inner: LLMGateway) {}

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    if (!isDevModeEnabled() || !options.meta?.executionId) {
      return this.inner.complete(options);
    }

    const t0 = Date.now();
    let response: LLMResponse | undefined;
    let err: unknown;
    try {
      response = await this.inner.complete(options);
      return response;
    } catch (e) {
      err = e;
      throw e;
    } finally {
      const latencyMs = Date.now() - t0;
      try {
        const env = getEnv();
        const maxBytes = env.HARNESS_DEV_PROMPT_MAX_BYTES;
        const promptStr = safeStringify(options.messages);
        const content = response?.content ?? (err ? `<error: ${String(err)}>` : "");
        getDevEventBus().emitEvent({
          kind: "llm.call",
          executionId: options.meta.executionId,
          ts: Date.now(),
          provider: response?.provider ?? "unknown",
          model: response?.model ?? "unknown",
          prompt: truncate(promptStr, maxBytes),
          response: truncate(content, maxBytes),
          tokens: {
            input: response?.usage.input_tokens ?? 0,
            output: response?.usage.output_tokens ?? 0,
          },
          latencyMs,
          purpose: options.meta.purpose,
        });
      } catch {
        // Telemetry must never break the call path.
      }
    }
  }

  /**
   * Streaming pass-through. The dev playground will eventually subscribe to
   * stream chunks via the `StreamPublisher`; this decorator is not the
   * right place to duplicate the firehose (we'd double-count tokens).
   */
  completeStream(options: CompleteStreamOptions): AsyncIterable<StreamChunk> {
    if (!this.inner.completeStream) {
      throw new Error("Wrapped gateway does not support streaming");
    }
    return this.inner.completeStream(options);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}

const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - ELLIPSIS_BYTES);
  // Binary search for the longest prefix that fits the byte budget.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return s.slice(0, lo) + ELLIPSIS;
}
