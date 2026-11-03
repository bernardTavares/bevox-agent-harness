import { classifyLLMError, isRetryable } from "../../observability/error-classifier.js";
import {
  LLMProviderError,
  type LLMGateway,
  type LLMRequestOptions,
  type LLMResponse,
} from "../llm-gateway.js";

import type { LLMDecorator } from "./internal.js";
import type { CompleteStreamOptions, StreamChunk } from "./streaming/types.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Percentage of failed calls (over `minSamples`) that opens the circuit. */
  errorThresholdPct: number;
  /** Time the circuit stays open before transitioning to half-open. */
  resetMs: number;
  /** Minimum sample size required before threshold is evaluated. */
  minSamples: number;
  /** Rolling window for sample accounting. */
  rollingWindowMs: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

interface Sample {
  ts: number;
  ok: boolean;
}

/**
 * In-house circuit breaker for LLM providers.
 *
 * Behaviour:
 *  - `closed`: all calls pass through. Each outcome is recorded.
 *  - When failure ratio over the rolling window exceeds threshold (and we
 *    have at least `minSamples` data points), the circuit opens.
 *  - `open`: calls fail-fast with a `CircuitOpenError` until `resetMs`
 *    elapses, then the next call probes in `half-open` state.
 *  - `half-open`: a single trial call decides the next state. Success →
 *    `closed` (sample buffer cleared). Failure → `open` again.
 *
 * Auth and validation errors are NOT counted as circuit failures — they
 * indicate a bad credential or request, not a sick provider. The credential
 * pool handles those.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private samples: Sample[] = [];
  private openedAt = 0;
  private readonly now: () => number;

  constructor(
    public readonly name: string,
    private readonly opts: CircuitBreakerOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    this.maybeTransitionFromOpen();
    return this.state;
  }

  async fire<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionFromOpen();

    if (this.state === "open") {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    }
  }

  private maybeTransitionFromOpen(): void {
    if (this.state === "open" && this.now() - this.openedAt >= this.opts.resetMs) {
      this.state = "half-open";
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.opts.rollingWindowMs;
    while (this.samples.length > 0 && this.samples[0].ts < cutoff) {
      this.samples.shift();
    }
  }

  private recordSuccess(): void {
    if (this.state === "half-open") {
      // Probe succeeded → fully close and reset window.
      this.state = "closed";
      this.samples = [];
      return;
    }
    this.samples.push({ ts: this.now(), ok: true });
    this.prune();
  }

  /**
   * Public hook for streaming path: caller can manually record a failure
   * after observing a stream error (5xx / 429). Synchronous chains still
   * inform the breaker through `fire()`; streaming bypasses `fire()` so we
   * need an explicit entrypoint. See ADR 013.
   */
  recordExternalFailure(err: unknown): void {
    this.recordFailure(err);
  }

  recordExternalSuccess(): void {
    this.recordSuccess();
  }

  private recordFailure(err: unknown): void {
    // Filter: only count "provider-health" failures, not credential/validation.
    const category = classifyLLMError(err);
    const countsAgainstCircuit = isRetryable(category) || category === "unknown";

    if (this.state === "half-open") {
      // Probe failed → re-open regardless of category to avoid hammering a
      // still-sick provider with retries.
      this.state = "open";
      this.openedAt = this.now();
      return;
    }

    if (!countsAgainstCircuit) return;

    this.samples.push({ ts: this.now(), ok: false });
    this.prune();

    if (this.samples.length < this.opts.minSamples) return;

    const failures = this.samples.filter((s) => !s.ok).length;
    const ratio = (failures / this.samples.length) * 100;
    if (ratio >= this.opts.errorThresholdPct) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}

export class CircuitOpenError extends Error {
  constructor(public readonly circuitName: string) {
    super(`Circuit "${circuitName}" is open`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreakerDecorator implements LLMDecorator {
  private readonly breaker: CircuitBreaker;

  constructor(
    public readonly wrapped: LLMGateway,
    name: string,
    opts: CircuitBreakerOptions,
  ) {
    this.breaker = new CircuitBreaker(name, opts);
  }

  complete(options: LLMRequestOptions): Promise<LLMResponse> {
    return this.breaker.fire(() => this.wrapped.complete(options));
  }

  /**
   * Streaming pass-through. We do NOT wrap the AsyncIterable in `breaker.fire`
   * because the breaker's success/failure model is per-call, not per-chunk.
   * Instead we observe the FIRST error (HTTP 5xx / 429 / network) emitted on
   * the iterable and call `recordExternalFailure` so a degraded provider
   * still trips the breaker for subsequent synchronous calls.
   */
  async *completeStream(options: CompleteStreamOptions): AsyncIterable<StreamChunk> {
    if (!this.wrapped.completeStream) {
      throw new Error("Wrapped gateway does not support streaming");
    }
    // Block if breaker is already open.
    const state = this.breaker.getState();
    if (state === "open") {
      throw new CircuitOpenError((this.breaker as { name: string }).name);
    }
    let recordedOutcome = false;
    try {
      yield* this.wrapped.completeStream(options);
      if (!recordedOutcome) {
        this.breaker.recordExternalSuccess();
        recordedOutcome = true;
      }
    } catch (err) {
      // Only count "health" errors (5xx, 429, network); auth/validation skip.
      if (err instanceof LLMProviderError && (err.statusCode >= 500 || err.statusCode === 429)) {
        this.breaker.recordExternalFailure(err);
      } else {
        // Network/abort: let classifier decide via recordFailure logic.
        this.breaker.recordExternalFailure(err);
      }
      recordedOutcome = true;
      throw err;
    }
  }

  /** Exposed for diagnostics / tests. */
  getState(): CircuitState {
    return this.breaker.getState();
  }
}
