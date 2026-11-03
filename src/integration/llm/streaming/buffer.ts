/**
 * StreamBuffer — aggregates token deltas before forwarding to Bevox.
 *
 * Goal: reduce the number of HTTP callbacks. Flushes on whichever happens
 * first:
 *   - `flushTokens` deltas accumulated
 *   - `flushMs` elapsed since the first push of the current batch
 *   - manual `flush()` (e.g. on `done` or on `pump` teardown)
 *
 * Tool-call deltas DO NOT pass through here — `StreamPublisher` emits them
 * immediately so UI feedback stays prompt ("buscando agenda...").
 */
export interface StreamBufferOptions {
  flushMs: number;
  flushTokens: number;
  onFlush: (aggregated: { text: string; tokenCount: number }) => Promise<void>;
}

export class StreamBuffer {
  private accum = "";
  private tokens = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Tracks the in-flight flush promise so callers can `await buffer.idle()`
   * and be sure the timer-driven flush has settled. Without this, a race
   * exists between an explicit `flush()` call and a still-pending timer
   * fire that would call `onFlush` a moment later with empty state (no-op,
   * but the test harness has no way to know it's safe to move on).
   */
  private inflight: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly opts: StreamBufferOptions) {}

  push(delta: string): void {
    if (this.closed) return;
    this.accum += delta;
    this.tokens += 1;
    if (this.tokens >= this.opts.flushTokens) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.opts.flushMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.tokens === 0) return this.inflight;
    const payload = { text: this.accum, tokenCount: this.tokens };
    this.accum = "";
    this.tokens = 0;
    const pending = this.opts.onFlush(payload);
    this.inflight = this.inflight.then(() => pending);
    return this.inflight;
  }

  /**
   * Drain and stop accepting new pushes. Idempotent; must be called from
   * `StreamPublisher.pump`'s `finally` to avoid leaking the pending timer.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.flush();
  }
}
