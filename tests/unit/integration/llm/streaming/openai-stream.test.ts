import { describe, expect, it, vi } from "vitest";

import type { CredentialPool } from "../../../../../src/integration/llm/credential-pool.js";
import { openaiCompleteStream } from "../../../../../src/integration/llm/streaming/openai-stream.js";
import type { StreamChunk } from "../../../../../src/integration/llm/streaming/types.js";

function mockPool(): CredentialPool {
  return {
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
    acquire: vi.fn(),
  } as unknown as CredentialPool;
}

function sseResponse(events: string[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("openaiCompleteStream", () => {
  it("emits token deltas + done", async () => {
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const pool = mockPool();
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(events));
    const chunks = await collect(
      openaiCompleteStream(
        { messages: [{ role: "user", content: "hi" }] },
        { apiKey: "sk-test", model: "gpt-4o-mini", pool, timeoutMs: 5000, fetchImpl },
      ),
    );
    const types = chunks.map((c) => c.type);
    expect(types).toContain("token");
    expect(types.at(-1)).toBe("done");
    expect((chunks.find((c) => c.type === "token")!.payload as { delta: string }).delta).toBe("Hel");
    expect(pool.reportSuccess).toHaveBeenCalled();
  });

  it("emits tool_call_start once and tool_call_delta repeatedly", async () => {
    const events = [
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "search-faq" } }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ id: "call_1", function: { arguments: '{"q":"a' } }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ id: "call_1", function: { arguments: 'bc"}' } }] } }],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(events));
    const chunks = await collect(
      openaiCompleteStream(
        { messages: [{ role: "user", content: "x" }] },
        { apiKey: "k", model: "gpt-4o-mini", pool: mockPool(), timeoutMs: 5000, fetchImpl },
      ),
    );
    expect(chunks.filter((c) => c.type === "tool_call_start")).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "tool_call_delta")).toHaveLength(2);
  });

  it("throws LLMProviderError on HTTP error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad", { status: 500 }));
    const it = openaiCompleteStream(
      { messages: [{ role: "user", content: "x" }] },
      { apiKey: "k", model: "gpt-4o-mini", pool: mockPool(), timeoutMs: 5000, fetchImpl },
    );
    await expect(collect(it)).rejects.toThrow(/HTTP 500/);
  });
});
