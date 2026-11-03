import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { CredentialPool } from "../../../../src/integration/llm/credential-pool.js";

// Stub the lazy require-based singleton — the real `getCredentialPool` uses
// `require()` which doesn't resolve cleanly in vitest/ESM.
const stubPool = new CredentialPool();
stubPool.register("openai", ["test-openai-key"]);
stubPool.register("anthropic", ["test-anthropic-key"]);
stubPool.register("gemini", ["test-gemini-key"]);

vi.mock("../../../../src/integration/llm/credential-pool", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../src/integration/llm/credential-pool")>(
    "../../../../src/integration/llm/credential-pool");
  return {
    ...actual,
    getCredentialPool: () => stubPool
  };
});

import {
  createLLMGateway,
  LLMProviderError } from
"../../../../src/integration/llm-gateway.js";

describe("LLMProviderError", () => {
  it("captures provider and statusCode", () => {
    const err = new LLMProviderError("openai", 401, "unauth");
    expect(err.provider).toBe("openai");
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe("unauth");
    expect(err.name).toBe("LLMProviderError");
    expect(err instanceof Error).toBe(true);
  });
});

describe("createLLMGateway", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {

    // intentionally empty — stubbed credential pool is used.
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns a gateway with .complete()", () => {
    const gw = createLLMGateway({ default_model: "openai/gpt-4o-mini" });
    expect(typeof gw.complete).toBe("function");
  });

  it("falls back to env defaults when no default_model provided", () => {
    const gw = createLLMGateway({});
    expect(typeof gw.complete).toBe("function");
  });

  it("uses anthropic adapter when default_model is anthropic/...", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "m",
        model: "claude-3-5",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    } as unknown as Response);
    global.fetch = fetchSpy as unknown as typeof fetch;

    const gw = createLLMGateway({ default_model: "anthropic/claude-3-5" });
    const res = await gw.complete({
      messages: [{ role: "user", content: "x" }]
    });
    expect(res.provider).toBe("anthropic");
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("anthropic.com");
  });

  it("uses gemini adapter when default_model is gemini/...", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
        {
          content: { role: "model", parts: [{ text: "hi" }] },
          finishReason: "STOP"
        }],

        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2
        }
      })
    } as unknown as Response);
    global.fetch = fetchSpy as unknown as typeof fetch;

    const gw = createLLMGateway({ default_model: "gemini/gemini-1.5-pro" });
    const res = await gw.complete({
      messages: [{ role: "user", content: "x" }]
    });
    expect(res.provider).toBe("gemini");
  });

  it("uses openai adapter when default_model is openai/...", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "x",
        model: "gpt-4o",
        choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop"
        }],

        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    } as unknown as Response);
    global.fetch = fetchSpy as unknown as typeof fetch;

    const gw = createLLMGateway({ default_model: "openai/gpt-4o" });
    const res = await gw.complete({
      messages: [{ role: "user", content: "x" }]
    });
    expect(res.provider).toBe("openai");
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("openai.com");
  });

  it("falls back to OpenAI on unknown provider", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "x",
        model: "gpt-4o-mini",
        choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop"
        }],

        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    } as unknown as Response);
    global.fetch = fetchSpy as unknown as typeof fetch;

    const gw = createLLMGateway({ default_model: "weirdprovider/whatever" });
    const res = await gw.complete({
      messages: [{ role: "user", content: "x" }]
    });
    expect(res.provider).toBe("openai");
  });

  it("composes retry + circuit-breaker — retries through circuit", async () => {
    let calls = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      calls++;
      if (calls < 2) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: async () => "transient"
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: "x",
          model: "gpt-4o",
          choices: [
          {
            message: { role: "assistant", content: "recovered" },
            finish_reason: "stop"
          }],

          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      } as unknown as Response);
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const gw = createLLMGateway({ default_model: "openai/gpt-4o" });
    const res = await gw.complete({
      messages: [{ role: "user", content: "x" }]
    });
    expect(res.content).toBe("recovered");
    expect(calls).toBe(2);
  });
});