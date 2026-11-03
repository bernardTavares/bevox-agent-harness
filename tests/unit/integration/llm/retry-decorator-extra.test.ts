import { describe, it, expect, vi } from "vitest";

import {
  withRetry,
  RetryDecorator } from
"../../../../src/integration/llm/retry-decorator.js";
import type { LLMGateway, LLMResponse } from "../../../../src/integration/llm-gateway.js";

describe("withRetry — jitter and backoff bounds", () => {
  it("respects maxDelayMs cap", async () => {
    const start = Date.now();
    let attempts = 0;
    await withRetry(
      async () => {
        attempts++;
        if (attempts < 2) {
          throw Object.assign(new Error("net"), { code: "ECONNREFUSED" });
        }
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 10_000, maxDelayMs: 20 }
    );
    // Even though base*2^(n-1) = 10s for attempt 1, maxDelayMs caps to 20ms.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("returns immediately when fn succeeds on first try", async () => {
    let attempts = 0;
    const res = await withRetry(
      async () => {
        attempts++;
        return "first-try";
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
    );
    expect(res).toBe("first-try");
    expect(attempts).toBe(1);
  });

  it("retries on network 'fetch failed' message", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("fetch failed");
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("classifies unknown errors as non-retryable", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("weird error");
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
      )
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe("RetryDecorator", () => {
  it("calls wrapped.complete and propagates result", async () => {
    const inner: LLMGateway = {
      complete: vi.fn().mockResolvedValue({
        content: "hi",
        tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        model: "m",
        provider: "openai",
        latency_ms: 5
      } satisfies LLMResponse)
    };
    const decorator = new RetryDecorator(inner, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5
    });
    const res = await decorator.complete({
      messages: [{ role: "user", content: "x" }]
    });
    expect(res.content).toBe("hi");
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it("retries wrapped.complete on retryable error", async () => {
    let calls = 0;
    const inner: LLMGateway = {
      complete: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("rate"), { status: 429 });
        return {
          content: "ok",
          tool_calls: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          model: "m",
          provider: "openai",
          latency_ms: 1
        } satisfies LLMResponse;
      })
    };
    const decorator = new RetryDecorator(inner, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 5
    });
    const res = await decorator.complete({
      messages: [{ role: "user", content: "x" }]
    });
    expect(res.content).toBe("ok");
    expect(calls).toBe(3);
  });

  it("exposes wrapped reference", () => {
    const inner: LLMGateway = { complete: vi.fn() };
    const decorator = new RetryDecorator(inner, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5
    });
    expect(decorator.wrapped).toBe(inner);
  });
});