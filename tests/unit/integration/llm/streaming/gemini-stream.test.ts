import { describe, expect, it, vi } from "vitest";

import type { CredentialPool } from "../../../../../src/integration/llm/credential-pool.js";
import { geminiCompleteStream } from "../../../../../src/integration/llm/streaming/gemini-stream.js";
import type { StreamChunk } from "../../../../../src/integration/llm/streaming/types.js";

function mockPool(): CredentialPool {
  return {
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
    acquire: vi.fn(),
  } as unknown as CredentialPool;
}

function sseResponse(events: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("geminiCompleteStream", () => {
  it("emits tokens for each text part", async () => {
    const events = [
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Hello" }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: " world" }] } }],
      })}\n\n`,
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(events));
    const chunks = await collect(
      geminiCompleteStream(
        { messages: [{ role: "user", content: "hi" }] },
        { apiKey: "k", model: "gemini-2.0-flash", pool: mockPool(), timeoutMs: 5000, fetchImpl },
      ),
    );
    expect(chunks.filter((c) => c.type === "token")).toHaveLength(2);
    expect(chunks.at(-1)!.type).toBe("done");
  });

  it("emits tool_call_start + tool_call_delta on functionCall", async () => {
    const events = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "search-faq", args: { q: "hi" } } }],
            },
          },
        ],
      })}\n\n`,
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(events));
    const chunks = await collect(
      geminiCompleteStream(
        { messages: [{ role: "user", content: "x" }] },
        { apiKey: "k", model: "gemini-2.0-flash", pool: mockPool(), timeoutMs: 5000, fetchImpl },
      ),
    );
    expect(chunks.find((c) => c.type === "tool_call_start")).toBeDefined();
    expect(chunks.find((c) => c.type === "tool_call_delta")).toBeDefined();
  });
});
