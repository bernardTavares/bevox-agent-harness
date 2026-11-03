/**
 * Sprint C.2 DoD — backward compatibility snapshot.
 *
 * Pins the exact request body that each adapter sends to its provider AND
 * the exact `LLMResponse` shape it returns, so any future change to the
 * streaming code that accidentally touches `complete()` will fail this test.
 */
import { describe, expect, it, vi } from "vitest";

import { AnthropicAdapter } from "../../../../../src/integration/llm/adapters/anthropic.adapter.js";
import { GeminiAdapter } from "../../../../../src/integration/llm/adapters/gemini.adapter.js";
import { OpenAIAdapter } from "../../../../../src/integration/llm/adapters/openai.adapter.js";
import type { CredentialPool } from "../../../../../src/integration/llm/credential-pool.js";

function mockPool(key: string): CredentialPool {
  return {
    acquire: vi.fn(() => key),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
  } as unknown as CredentialPool;
}

describe("LLMGateway.complete() backward compatibility", () => {
  it("OpenAI request body and response shape are unchanged", async () => {
    const fetchSpy = vi.fn(async (_url, init) => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "gpt-4o-mini",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new OpenAIAdapter("gpt-4o-mini", mockPool("k"), 30_000);
    const res = await adapter.complete({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      maxTokens: 100,
      temperature: 0,
    });

    const sentBody = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(sentBody).toEqual({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 100,
      temperature: 0,
    });
    expect(res).toMatchObject({
      content: "ok",
      tool_calls: [],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      model: "gpt-4o-mini",
      provider: "openai",
    });
    expect(typeof res.latency_ms).toBe("number");
    vi.unstubAllGlobals();
  });

  it("Anthropic request body and response shape are unchanged", async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "msg_1",
          model: "claude-3-haiku-20240307",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new AnthropicAdapter("claude-3-haiku-20240307", mockPool("k"), 30_000);
    const res = await adapter.complete({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      maxTokens: 100,
    });
    const sentBody = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(sentBody).toMatchObject({
      model: "claude-3-haiku-20240307",
      max_tokens: 100,
      temperature: 0,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res).toMatchObject({
      content: "ok",
      tool_calls: [],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      provider: "anthropic",
    });
    vi.unstubAllGlobals();
  });

  it("Gemini request body and response shape are unchanged", async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new GeminiAdapter("gemini-2.0-flash", mockPool("k"), 30_000);
    const res = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });
    const sentBody = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(sentBody.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(sentBody.generationConfig).toMatchObject({ maxOutputTokens: 100, temperature: 0 });
    expect(res).toMatchObject({
      content: "ok",
      tool_calls: [],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      provider: "gemini",
    });
    vi.unstubAllGlobals();
  });
});
