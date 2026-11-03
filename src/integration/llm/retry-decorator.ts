import { classifyLLMError, isRetryable } from "../../observability/error-classifier.js";
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway.js";

import type { LLMDecorator } from "./internal.js";
import type { CompleteStreamOptions, StreamChunk } from "./streaming/types.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Retry an async function with exponential backoff + full jitter.
 * Only retryable error categories (network, timeout, rate_limit, server)
 * trigger a retry; auth/validation/unknown errors propagate immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const category = classifyLLMError(err);
      if (!isRetryable(category) || attempt === opts.maxAttempts) throw err;

      // Full jitter in [base * 2^(n-1) * 0.5, base * 2^(n-1) * 1.5], clamped.
      const exp = opts.baseDelayMs * 2 ** (attempt - 1);
      const jittered = exp * (0.5 + Math.random());
      const delay = Math.min(jittered, opts.maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable — the loop either returns or throws — but TS demands a return.
  throw lastErr;
}

export class RetryDecorator implements LLMDecorator {
  constructor(
    public readonly wrapped: LLMGateway,
    private readonly opts: RetryOptions,
  ) {}

  complete(options: LLMRequestOptions): Promise<LLMResponse> {
    return withRetry(() => this.wrapped.complete(options), this.opts);
  }

  /**
   * Streaming pass-through. Streams are not retried because partial state has
   * already been delivered to the consumer; retrying would duplicate chunks
   * out-of-order. See `docs/adr/013-streaming-bypasses-retry-circuit.md`.
   */
  completeStream(options: CompleteStreamOptions): AsyncIterable<StreamChunk> {
    if (!this.wrapped.completeStream) {
      throw new Error("Wrapped gateway does not support streaming");
    }
    return this.wrapped.completeStream(options);
  }
}
