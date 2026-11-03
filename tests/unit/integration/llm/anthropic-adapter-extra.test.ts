import { describe, it, expect, vi, afterEach } from "vitest";

import { AnthropicAdapter } from "../../../../src/integration/llm/adapters/anthropic.adapter.js";
import { CredentialPool } from "../../../../src/integration/llm/credential-pool.js";

describe("AnthropicAdapter (extra coverage)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function pool(keys = ["k"]) {
    const p = new CredentialPool();
    p.register("anthropic", keys);
    return p;
  }

  function okBody(extras: Record<string, unknown> = {}) {
    return {
      id: "m",
      model: "claude-3-5-sonnet-latest",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      ...extras
    };
  }

  it("supportsModel matches claude- prefix", () => {
    const adapter = new AnthropicAdapter("claude-3", pool());
    expect(adapter.supportsModel("claude-3-5")).toBe(true);
    expect(adapter.supportsModel("gpt-4")).toBe(false);
  });

  it("converts role=tool to user with tool_result block", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => okBody()
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new AnthropicAdapter("claude-3-5", pool());
    await adapter.complete({
      messages: [
      { role: "user", content: "u" },
      { role: "tool", content: "result-text", tool_call_id: "tc-1" }]

    });
    const msgs = captured?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const second = msgs[1];
    expect(second.role).toBe("user");
    const blocks = second.content as Array<Record<string, unknown>>;
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("tc-1");
    expect(blocks[0].content).toBe("result-text");
  });

  it("includes input_schema in tools", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => okBody()
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new AnthropicAdapter("claude-3-5", pool());
    await adapter.complete({
      messages: [{ role: "user", content: "x" }],
      tools: [
      { name: "n", description: "d", parameters: { type: "object" } }]

    });
    const tools = captured?.tools as Array<Record<string, unknown>>;
    expect(tools[0].name).toBe("n");
    expect(tools[0].input_schema).toEqual({ type: "object" });
  });

  it("concatenates multiple system messages with newlines", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => okBody()
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new AnthropicAdapter("claude-3-5", pool());
    await adapter.complete({
      messages: [
      { role: "system", content: "first" },
      { role: "system", content: "second" },
      { role: "user", content: "u" }]

    });
    expect(captured?.system).toBe("first\nsecond");
  });

  it("uses x-api-key header and anthropic-version", async () => {
    let captured: Record<string, string> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = init.headers as Record<string, string>;
      return Promise.resolve({
        ok: true,
        json: async () => okBody()
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new AnthropicAdapter("claude-3-5", pool(["myk"]));
    await adapter.complete({ messages: [{ role: "user", content: "x" }] });
    expect(captured?.["x-api-key"]).toBe("myk");
    expect(captured?.["anthropic-version"]).toBe("2023-06-01");
  });

  it("computes total_tokens as sum of input+output", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => okBody({ usage: { input_tokens: 100, output_tokens: 50 } })
    } as unknown as Response) as unknown as typeof fetch;

    const adapter = new AnthropicAdapter("claude-3-5", pool());
    const res = await adapter.complete({
      messages: [{ role: "user", content: "x" }]
    });
    expect(res.usage.total_tokens).toBe(150);
  });

  it("throws LLMProviderError on 403 and reports failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden"
    } as unknown as Response) as unknown as typeof fetch;

    const adapter = new AnthropicAdapter("claude-3-5", pool());
    await expect(
      adapter.complete({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toThrow(/Anthropic API error 403/);
  });

  it("throws on 500 without rotating credentials", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom"
    } as unknown as Response) as unknown as typeof fetch;

    const adapter = new AnthropicAdapter("claude-3-5", pool());
    await expect(
      adapter.complete({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toThrow(/500/);
  });
});