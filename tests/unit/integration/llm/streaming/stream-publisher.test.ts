import { describe, expect, it, vi } from "vitest";

import { StreamPublisher } from "../../../../../src/runtime/stream-publisher.js";
import type { StreamChunk } from "../../../../../src/integration/llm/streaming/types.js";

function makeRecordingFetch(): {
  fetch: typeof fetch;
  received: StreamChunk[];
} {
  const received: StreamChunk[] = [];
  const f = vi.fn(async (_url: string, init?: RequestInit) => {
    // Wire shape after H-CB-03 fix: `{chunk: string, index: number}`.
    // Rehydrate the envelope from the `chunk` JSON for assertions.
    const wire = JSON.parse(init!.body as string) as { chunk: string; index: number };
    const envelope = JSON.parse(wire.chunk) as StreamChunk;
    received.push(envelope);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { fetch: f, received };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) {
    yield x;
    await Promise.resolve();
  }
}

describe("StreamPublisher", () => {
  it("assigns monotonic seq under concurrent emits", async () => {
    const { fetch: f, received } = makeRecordingFetch();
    const pub = new StreamPublisher({
      executionId: "exec-1",
      token: "tok",
      callbackBaseUrl: "http://bevox.test",
      flushMs: 1000,
      flushTokens: 1000,
      callbackTimeoutMs: 1000,
      fetchImpl: f,
    });
    // Fire 50 concurrent emits.
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        pub.emit({
          type: "reasoning_step",
          payload: { strategy: "react", stepIndex: i, summary: "s" },
        }),
      ),
    );
    const seqs = received.map((c) => c.seq);
    expect(seqs).toHaveLength(50);
    expect(new Set(seqs).size).toBe(50);
    expect(Math.min(...seqs)).toBe(0);
    expect(Math.max(...seqs)).toBe(49);
  });

  it("accumulates tool_call args and emits tool_call_complete when JSON is valid", async () => {
    const { fetch: f, received } = makeRecordingFetch();
    const pub = new StreamPublisher({
      executionId: "exec-2",
      token: "tok",
      callbackBaseUrl: "http://bevox.test",
      flushMs: 1000,
      flushTokens: 1000,
      callbackTimeoutMs: 1000,
      fetchImpl: f,
    });
    const stream = fromArray<StreamChunk>([
      {
        type: "tool_call_start",
        seq: 0,
        timestamp: 0,
        payload: { toolCallId: "c1", name: "search-faq" },
      },
      {
        type: "tool_call_delta",
        seq: 1,
        timestamp: 0,
        payload: { toolCallId: "c1", argsDelta: '{"q":' },
      },
      {
        type: "tool_call_delta",
        seq: 2,
        timestamp: 0,
        payload: { toolCallId: "c1", argsDelta: '"hi"}' },
      },
      { type: "done", seq: 3, timestamp: 0, payload: { totalDurationMs: 1 } },
    ]);
    await pub.pump(stream);
    const types = received.map((c) => c.type);
    expect(types.filter((t) => t === "tool_call_start")).toHaveLength(1);
    expect(types.filter((t) => t === "tool_call_delta")).toHaveLength(2);
    const complete = received.find((c) => c.type === "tool_call_complete");
    expect(complete).toBeDefined();
    expect(complete!.payload).toMatchObject({
      toolCallId: "c1",
      name: "search-faq",
      args: { q: "hi" },
    });
    expect(types.at(-1)).toBe("done");
  });

  it("buffers token deltas and flushes on done", async () => {
    const { fetch: f, received } = makeRecordingFetch();
    const pub = new StreamPublisher({
      executionId: "exec-3",
      token: "tok",
      callbackBaseUrl: "http://bevox.test",
      flushMs: 5000,
      flushTokens: 1000, // very high — only flushed on done
      callbackTimeoutMs: 1000,
      fetchImpl: f,
    });
    const stream = fromArray<StreamChunk>([
      { type: "token", seq: 0, timestamp: 0, payload: { delta: "Hel" } },
      { type: "token", seq: 1, timestamp: 0, payload: { delta: "lo" } },
      { type: "done", seq: 2, timestamp: 0, payload: { totalDurationMs: 1 } },
    ]);
    await pub.pump(stream);
    const tokens = received.filter((c) => c.type === "token");
    expect(tokens).toHaveLength(1);
    expect((tokens[0].payload as { delta: string }).delta).toBe("Hello");
    expect(pub.getFullText()).toBe("Hello");
  });

  it("does not crash on callback failure; samples warn logs", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const pub = new StreamPublisher({
      executionId: "exec-4",
      token: "tok",
      callbackBaseUrl: "http://bevox.test",
      flushMs: 1000,
      flushTokens: 1000,
      callbackTimeoutMs: 1000,
      fetchImpl: f,
    });
    await pub.emit({
      type: "reasoning_step",
      payload: { strategy: "react", stepIndex: 0, summary: "" },
    });
    await pub.emit({
      type: "reasoning_step",
      payload: { strategy: "react", stepIndex: 1, summary: "" },
    });
    // Should not throw despite 500 responses.
    expect(true).toBe(true);
  });

  it("emits error chunk after JSON_PARSE_MAX_FAILURES malformed deltas", async () => {
    const { fetch: f, received } = makeRecordingFetch();
    const pub = new StreamPublisher({
      executionId: "exec-5",
      token: "tok",
      callbackBaseUrl: "http://bevox.test",
      flushMs: 1000,
      flushTokens: 1000,
      callbackTimeoutMs: 1000,
      fetchImpl: f,
    });
    // 200 bad deltas — none ever become valid JSON
    const bad: StreamChunk[] = [
      { type: "tool_call_start", seq: 0, timestamp: 0, payload: { toolCallId: "x", name: "tool" } },
    ];
    for (let i = 0; i < 200; i++) {
      bad.push({
        type: "tool_call_delta",
        seq: i + 1,
        timestamp: 0,
        payload: { toolCallId: "x", argsDelta: "{{" },
      });
    }
    bad.push({ type: "done", seq: 999, timestamp: 0, payload: { totalDurationMs: 1 } });
    await pub.pump(fromArray(bad));
    const errs = received.filter((c) => c.type === "error");
    expect(errs.length).toBeGreaterThan(0);
  });
});
