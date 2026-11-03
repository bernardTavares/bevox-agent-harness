import { describe, expect, it, vi } from "vitest";

import type { CredentialPool } from "../../../../../src/integration/llm/credential-pool.js";
import { anthropicCompleteStream } from "../../../../../src/integration/llm/streaming/anthropic-stream.js";
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

describe("anthropicCompleteStream", () => {
  it("emits tokens from text_delta and done on message_stop", async () => {
    const events = [
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(events));
    const chunks = await collect(
      anthropicCompleteStream(
        { messages: [{ role: "user", content: "hi" }] },
        { apiKey: "k", model: "claude-3-haiku-20240307", pool: mockPool(), timeoutMs: 5000, fetchImpl },
      ),
    );
    const tokens = chunks.filter((c) => c.type === "token");
    expect(tokens).toHaveLength(2);
    expect(chunks.at(-1)!.type).toBe("done");
  });

  it("emits tool_call_start and tool_call_delta", async () => {
    const events = [
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "search-faq" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"hi"}' },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(events));
    const chunks = await collect(
      anthropicCompleteStream(
        { messages: [{ role: "user", content: "x" }] },
        { apiKey: "k", model: "claude-3-haiku-20240307", pool: mockPool(), timeoutMs: 5000, fetchImpl },
      ),
    );
    expect(chunks.filter((c) => c.type === "tool_call_start")).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "tool_call_delta")).toHaveLength(2);
  });
});
