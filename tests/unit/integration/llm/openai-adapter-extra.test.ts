import { describe, it, expect, vi, afterEach } from "vitest";

import { OpenAIAdapter } from "../../../../src/integration/llm/adapters/openai.adapter.js";
import { CredentialPool } from "../../../../src/integration/llm/credential-pool.js";

describe("OpenAIAdapter (extra coverage)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function pool(keys = ["k"]) {
    const p = new CredentialPool();
    p.register("openai", keys);
    return p;
  }

  it("supportsModel matches gpt-/o1/o3 prefixes", () => {
    const adapter = new OpenAIAdapter("gpt-4o", pool());
    expect(adapter.supportsModel("gpt-4o")).toBe(true);
    expect(adapter.supportsModel("o1-mini")).toBe(true);
    expect(adapter.supportsModel("o3-mini")).toBe(true);
    expect(adapter.supportsModel("claude-3")).toBe(false);
  });

  it("includes tools in body when provided and sets tool_choice=auto", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: "x",
          model: "gpt-4o",
          choices: [
          {
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop"
          }],

          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new OpenAIAdapter("gpt-4o", pool());
    await adapter.complete({
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }]
    });
    const tools = captured?.tools as Array<{
      type: string;
      function: {name: string;};
    }>;
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("t");
    expect(captured?.tool_choice).toBe("auto");
  });

  it("sends response_format when responseSchema provided and no tools", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: "x",
          model: "gpt-4o",
          choices: [
          {
            message: { role: "assistant", content: "{}" },
            finish_reason: "stop"
          }],

          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new OpenAIAdapter("gpt-4o", pool());
    await adapter.complete({
      messages: [{ role: "user", content: "x" }],
      responseSchema: { type: "object" }
    });
    const rf = captured?.response_format as {type: string;json_schema: {schema: unknown;};};
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.schema).toEqual({ type: "object" });
  });

  it("passes tool_call_id and name on tool-role messages", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
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
    }) as unknown as typeof fetch;

    const adapter = new OpenAIAdapter("gpt-4o", pool());
    await adapter.complete({
      messages: [
      { role: "user", content: "u" },
      {
        role: "tool",
        content: "result",
        tool_call_id: "tc1",
        name: "search"
      }]

    });
    const msgs = captured?.messages as Array<Record<string, unknown>>;
    expect(msgs[1].tool_call_id).toBe("tc1");
    expect(msgs[1].name).toBe("search");
  });

  it("gracefully handles malformed JSON in tool_call arguments", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "x",
        model: "gpt-4o",
        choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
            {
              id: "tc1",
              type: "function",
              function: { name: "search", arguments: "{not-json" }
            }]

          },
          finish_reason: "tool_calls"
        }],

        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    } as unknown as Response) as unknown as typeof fetch;

    const adapter = new OpenAIAdapter("gpt-4o", pool());
    const res = await adapter.complete({
      messages: [{ role: "user", content: "x" }]
    });
    expect(res.tool_calls[0]!.arguments).toEqual({});
  });

  it("uses provided maxTokens and temperature", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
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
    }) as unknown as typeof fetch;

    const adapter = new OpenAIAdapter("gpt-4o", pool());
    await adapter.complete({
      messages: [{ role: "user", content: "x" }],
      maxTokens: 256,
      temperature: 0.7
    });
    expect(captured?.max_tokens).toBe(256);
    expect(captured?.temperature).toBe(0.7);
  });

  it("defaults max_tokens and temperature when omitted", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
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
    }) as unknown as typeof fetch;

    const adapter = new OpenAIAdapter("gpt-4o", pool());
    await adapter.complete({ messages: [{ role: "user", content: "x" }] });
    expect(captured?.max_tokens).toBe(2048);
    expect(captured?.temperature).toBe(0);
  });

  it("uses Authorization Bearer header", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve({
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
    }) as unknown as typeof fetch;

    const adapter = new OpenAIAdapter("gpt-4o", pool(["mykey"]));
    await adapter.complete({ messages: [{ role: "user", content: "x" }] });
    expect(capturedHeaders?.Authorization).toBe("Bearer mykey");
  });
});