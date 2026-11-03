import { describe, it, expect, vi } from "vitest";

import {
  CircuitBreaker,
  CircuitBreakerDecorator,
  CircuitOpenError } from
"../../../../src/integration/llm/circuit-breaker.js";
import type {
  LLMGateway,
  LLMResponse } from
"../../../../src/integration/llm-gateway.js";

function srvErr() {
  return Object.assign(new Error("oops"), { status: 503 });
}

describe("CircuitBreaker (extra coverage)", () => {
  it("does not open below minSamples even with all failures", async () => {
    const cb = new CircuitBreaker("t", {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 5,
      rollingWindowMs: 60_000
    });
    for (let i = 0; i < 4; i++) {
      await expect(cb.fire(async () => {throw srvErr();})).rejects.toBeDefined();
    }
    expect(cb.getState()).toBe("closed");
  });

  it("prunes old samples outside the rolling window", async () => {
    let now = 0;
    const cb = new CircuitBreaker("t", {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 100,
      now: () => now
    });
    // 3 failures within window
    for (let i = 0; i < 3; i++) {
      now += 10;
      await expect(cb.fire(async () => {throw srvErr();})).rejects.toBeDefined();
    }
    expect(cb.getState()).toBe("open");
    // Reset and time-travel past rolling window
    now += 2000;
    // After resetMs, half-open
    expect(cb.getState()).toBe("half-open");
    // Now succeed → closed and samples cleared
    await cb.fire(async () => "ok");
    expect(cb.getState()).toBe("closed");
  });

  it("ignores auth errors regardless of count", async () => {
    const cb = new CircuitBreaker("t", {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    for (let i = 0; i < 5; i++) {
      await expect(
        cb.fire(async () => {
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        })
      ).rejects.toBeDefined();
    }
    expect(cb.getState()).toBe("closed");
  });

  it("ignores invalid_response errors", async () => {
    const cb = new CircuitBreaker("t", {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    for (let i = 0; i < 5; i++) {
      await expect(
        cb.fire(async () => {
          throw new Error("invalid json received");
        })
      ).rejects.toBeDefined();
    }
    expect(cb.getState()).toBe("closed");
  });

  it("counts unknown errors as health failures", async () => {
    const cb = new CircuitBreaker("t", {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    for (let i = 0; i < 3; i++) {
      await expect(
        cb.fire(async () => {
          throw new Error("mysterious");
        })
      ).rejects.toBeDefined();
    }
    expect(cb.getState()).toBe("open");
  });

  it("mixes success and failure — opens only above threshold", async () => {
    const cb = new CircuitBreaker("t", {
      errorThresholdPct: 80,
      resetMs: 1000,
      minSamples: 5,
      rollingWindowMs: 60_000
    });
    // 3 successes, 2 failures → 40% < 80%
    for (let i = 0; i < 3; i++) {
      await cb.fire(async () => "ok");
    }
    for (let i = 0; i < 2; i++) {
      await expect(cb.fire(async () => {throw srvErr();})).rejects.toBeDefined();
    }
    expect(cb.getState()).toBe("closed");
  });

  it("uses default Date.now when no now() injected", () => {
    const cb = new CircuitBreaker("t", {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    expect(cb.getState()).toBe("closed");
  });
});

describe("CircuitBreakerDecorator", () => {
  function makeInner(impl: () => Promise<LLMResponse>): LLMGateway {
    return { complete: vi.fn().mockImplementation(impl) };
  }

  function okResp(): LLMResponse {
    return {
      content: "ok",
      tool_calls: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      model: "m",
      provider: "openai",
      latency_ms: 1
    };
  }

  it("passes through when closed", async () => {
    const inner = makeInner(async () => okResp());
    const d = new CircuitBreakerDecorator(inner, "test", {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    const res = await d.complete({ messages: [{ role: "user", content: "x" }] });
    expect(res.content).toBe("ok");
    expect(d.getState()).toBe("closed");
  });

  it("opens after threshold failures and rejects with CircuitOpenError", async () => {
    const inner = makeInner(async () => {
      throw srvErr();
    });
    const d = new CircuitBreakerDecorator(inner, "test", {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    for (let i = 0; i < 3; i++) {
      await expect(
        d.complete({ messages: [{ role: "user", content: "x" }] })
      ).rejects.toBeDefined();
    }
    await expect(
      d.complete({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("exposes wrapped reference", () => {
    const inner = makeInner(async () => okResp());
    const d = new CircuitBreakerDecorator(inner, "test", {
      errorThresholdPct: 50,
      resetMs: 1000,
      minSamples: 3,
      rollingWindowMs: 60_000
    });
    expect(d.wrapped).toBe(inner);
  });
});

describe("CircuitOpenError", () => {
  it("has circuitName and proper message", () => {
    const err = new CircuitOpenError("llm-openai");
    expect(err.circuitName).toBe("llm-openai");
    expect(err.message).toContain("llm-openai");
    expect(err.name).toBe("CircuitOpenError");
  });
});