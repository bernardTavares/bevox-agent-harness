import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from "../../../../src/integration/llm/circuit-breaker.js";

function failingServerError() {
  return Object.assign(new Error('boom'), { status: 503 });
}

describe('CircuitBreaker', () => {
  it('starts closed and passes calls through', async () => {
    const cb = new CircuitBreaker('t', {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    expect(cb.getState()).toBe('closed');
    const result = await cb.fire(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('opens after threshold of retryable failures', async () => {
    const cb = new CircuitBreaker('t', {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    for (let i = 0; i < 3; i++) {
      await expect(cb.fire(async () => {throw failingServerError();})).rejects.toBeDefined();
    }
    expect(cb.getState()).toBe('open');
    // Subsequent calls fail fast
    await expect(cb.fire(async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('does not count auth errors against the circuit', async () => {
    const cb = new CircuitBreaker('t', {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    for (let i = 0; i < 5; i++) {
      await expect(
        cb.fire(async () => {
          throw Object.assign(new Error('nope'), { status: 401 });
        })
      ).rejects.toBeDefined();
    }
    expect(cb.getState()).toBe('closed');
  });

  it('transitions open → half-open → closed on probe success', async () => {
    let now = 0;
    const cb = new CircuitBreaker('t', {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000,
      now: () => now
    });
    for (let i = 0; i < 3; i++) {
      await expect(cb.fire(async () => {throw failingServerError();})).rejects.toBeDefined();
    }
    expect(cb.getState()).toBe('open');
    now += 1001; // advance past resetMs
    expect(cb.getState()).toBe('half-open');
    const result = await cb.fire(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(cb.getState()).toBe('closed');
  });

  it('transitions half-open → open on probe failure', async () => {
    let now = 0;
    const cb = new CircuitBreaker('t', {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000,
      now: () => now
    });
    for (let i = 0; i < 3; i++) {
      await expect(cb.fire(async () => {throw failingServerError();})).rejects.toBeDefined();
    }
    now += 1001;
    await expect(cb.fire(async () => {throw failingServerError();})).rejects.toBeDefined();
    expect(cb.getState()).toBe('open');
  });
});