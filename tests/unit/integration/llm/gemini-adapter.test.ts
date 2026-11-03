import { describe, it, expect, vi, afterEach } from "vitest";

import { GeminiAdapter } from "../../../../src/integration/llm/adapters/gemini.adapter.js";
import { CredentialPool } from "../../../../src/integration/llm/credential-pool.js";

describe("GeminiAdapter", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function pool(keys = ["gem-k"]) {
    const p = new CredentialPool();
    p.register("gemini", keys);
    return p;
  }

  it("supportsModel matches gemini- prefix", () => {
    const adapter = new GeminiAdapter("gemini-1.5-pro", pool());
    expect(adapter.supportsModel("gemini-1.5-pro")).toBe(true);
    expect(adapter.supportsModel("gpt-4o")).toBe(false);
  });

  it("maps text content correctly", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Hello there" }]
          },
          finishReason: "STOP"
        }],

        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 3,
          totalTokenCount: 10
        }
      })
    } as unknown as Response) as unknown as typeof fetch;

    const adapter = new GeminiAdapter("gemini-1.5-pro", pool());
    const res = await adapter.complete({
      messages: [{ role: "user", content: "hi" }]
    });
    expect(res.content).toBe("Hello there");
    expect(res.usage.input_tokens).toBe(7);
    expect(res.usage.output_tokens).toBe(3);
    expect(res.usage.total_tokens).toBe(10);
    expect(res.provider).toBe("gemini");
    expect(res.model).toBe("gemini-1.5-pro");
    expect(typeof res.latency_ms).toBe("number");
  });

  it("maps functionCall parts to tool_calls", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
        {
          content: {
            role: "model",
            parts: [
            {
              functionCall: {
                name: "lookup",
                args: { id: 42 }
              }
            }]

          },
          finishReason: "STOP"
        }],

        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 1,
          totalTokenCount: 6
        }
      })
    } as unknown as Response) as unknown as typeof fetch;

    const adapter = new GeminiAdapter("gemini-1.5-pro", pool());
    const res = await adapter.complete({
      messages: [{ role: "user", content: "find 42" }],
      tools: [{ name: "lookup", description: "l", parameters: {} }]
    });
    expect(res.content).toBeNull();
    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls[0]!.name).toBe("lookup");
    expect(res.tool_calls[0]!.arguments).toEqual({ id: 42 });
  });

  it("injects system messages as [SYSTEM] user-turn before first user msg", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP"
          }],

          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2
          }
        })
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new GeminiAdapter("gemini-1.5-pro", pool());
    await adapter.complete({
      messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" }]

    });
    const contents = captured?.contents as Array<{
      role: string;
      parts: Array<{text: string;}>;
    }>;
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts[0].text).toContain("[SYSTEM]");
    expect(contents[0].parts[0].text).toContain("be brief");
    expect(contents[1].role).toBe("model");
    expect(contents[2].role).toBe("user");
    expect(contents[2].parts[0].text).toBe("hi");
  });

  it("maps assistant messages to role=model", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP"
          }],

          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2
          }
        })
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new GeminiAdapter("gemini-1.5-pro", pool());
    await adapter.complete({
      messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }]

    });
    const contents = captured?.contents as Array<{role: string;}>;
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("model");
  });

  it("sends responseSchema when no tools provided", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          candidates: [
          {
            content: { role: "model", parts: [{ text: "{}" }] },
            finishReason: "STOP"
          }],

          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2
          }
        })
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new GeminiAdapter("gemini-1.5-pro", pool());
    await adapter.complete({
      messages: [{ role: "user", content: "x" }],
      responseSchema: { type: "object" }
    });
    const gc = captured?.generationConfig as Record<string, unknown>;
    expect(gc.responseMimeType).toBe("application/json");
    expect(gc.responseSchema).toEqual({ type: "object" });
  });

  it("includes function declarations when tools provided", async () => {
    let captured: Record<string, unknown> | undefined;
    global.fetch = vi.
    fn().
    mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          candidates: [
          {
            content: { role: "model", parts: [{ text: "x" }] },
            finishReason: "STOP"
          }],

          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2
          }
        })
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new GeminiAdapter("gemini-1.5-pro", pool());
    await adapter.complete({
      messages: [{ role: "user", content: "x" }],
      tools: [
      { name: "search", description: "s", parameters: { type: "object" } }]

    });
    const tools = captured?.tools as Array<{
      functionDeclarations: Array<{name: string;}>;
    }>;
    expect(tools[0].functionDeclarations[0].name).toBe("search");
  });

  it("throws LLMProviderError on non-OK and reports failure on 401", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid"
    } as unknown as Response) as unknown as typeof fetch;

    const p = pool(["bad"]);
    const adapter = new GeminiAdapter("gemini-1.5-pro", p);
    await expect(
      adapter.complete({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toThrow(/Gemini API error 401/);
  });

  it("throws on 500 without rotating credentials", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom"
    } as unknown as Response) as unknown as typeof fetch;
    const adapter = new GeminiAdapter("gemini-1.5-pro", pool());
    await expect(
      adapter.complete({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toThrow(/500/);
  });

  it("places API key in url query", async () => {
    let capturedUrl = "";
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          candidates: [
          {
            content: { role: "model", parts: [{ text: "x" }] },
            finishReason: "STOP"
          }],

          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2
          }
        })
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const adapter = new GeminiAdapter("gemini-1.5-pro", pool(["my-key"]));
    await adapter.complete({ messages: [{ role: "user", content: "x" }] });
    expect(capturedUrl).toContain("key=my-key");
  });
});