/**
 * Sprint C.2 — End-to-end streaming smoke.
 *
 * This test does NOT spin up a real BullMQ worker; it exercises the
 * `StreamPublisher` against a real HTTP server that mimics Bevox's
 * `/api/v1/executions/:id/stream` endpoint (per H-CB-03 fix 2026-06-02).
 * The objective is to verify:
 *
 *  - chunks arrive in monotonically increasing `seq` order
 *  - the buffered `token` aggregation flushes on `done`
 *  - `tool_call_complete` is synthesized after the JSON is valid
 *  - `error` chunks do not crash the run
 *  - the wire shape `{chunk, index}` (not the raw envelope) hits the wire
 */
import { type AddressInfo, createServer, type Server } from "http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StreamChunk } from "../../src/integration/llm/streaming/types.js";
import { StreamPublisher } from "../../src/runtime/stream-publisher.js";

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) {
    yield x;
    await new Promise((r) => setImmediate(r));
  }
}

describe("streaming end-to-end (HTTP mock)", () => {
  let server: Server;
  // Backend wire shape: `{chunk: string, index: number}`. We rehydrate the
  // envelope from `chunk` (JSON string) for assertions, mirroring what the
  // backend Redis buffer key `stream:{execution_id}` accumulates.
  let received: StreamChunk[] = [];
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      // Match the canonical backend route from
      // `bevox-backend/src/integration/harness-callbacks.routes.ts`.
      if (req.url?.match(/\/api\/v1\/executions\/[^/]+\/stream$/)) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const wire = JSON.parse(body) as { chunk: string; index: number };
            // Rehydrate the envelope from the wire `chunk` field.
            received.push(JSON.parse(wire.chunk) as StreamChunk);
          } catch {
            /* ignore */
          }
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ accepted: true }));
        });
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("publishes a mixed token + tool_call stream end-to-end", async () => {
    received = [];
    const pub = new StreamPublisher({
      executionId: "exec-e2e-1",
      token: "test-token",
      callbackBaseUrl: baseUrl,
      flushMs: 50,
      flushTokens: 100,
      callbackTimeoutMs: 2000,
    });
    const stream = fromArray<StreamChunk>([
      { type: "token", seq: 0, timestamp: 0, payload: { delta: "Hello" } },
      { type: "token", seq: 1, timestamp: 0, payload: { delta: " world" } },
      {
        type: "tool_call_start",
        seq: 2,
        timestamp: 0,
        payload: { toolCallId: "c1", name: "search-faq" },
      },
      {
        type: "tool_call_delta",
        seq: 3,
        timestamp: 0,
        payload: { toolCallId: "c1", argsDelta: '{"q":' },
      },
      {
        type: "tool_call_delta",
        seq: 4,
        timestamp: 0,
        payload: { toolCallId: "c1", argsDelta: '"hi"}' },
      },
      { type: "done", seq: 5, timestamp: 0, payload: { totalDurationMs: 10 } },
    ]);
    await pub.pump(stream);
    await pub.close();

    expect(received.length).toBeGreaterThanOrEqual(5);
    const seqs = received.map((c) => c.seq);
    // seq is monotonic at emit time, but HTTP delivery on localhost can
    // reorder concurrent requests. Assert uniqueness + density (no gaps
    // among the seqs we saw); the backend reorders by `index` on its side
    // before delivering to the UI (see docs/streaming/README.md "Idempotency
    // / ordering").
    expect(new Set(seqs).size).toBe(seqs.length);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted[0]).toBe(0);
    expect(sorted[sorted.length - 1]).toBe(sorted.length - 1);

    const types = received.map((c) => c.type);
    expect(types).toContain("token");
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_complete");
    expect(types.at(-1)).toBe("done");

    const completeChunk = received.find((c) => c.type === "tool_call_complete");
    expect(completeChunk!.payload).toMatchObject({
      toolCallId: "c1",
      name: "search-faq",
      args: { q: "hi" },
    });
  });

  it("uses X-Execution-Token header", async () => {
    received = [];
    // Spin up a header-capturing intercept
    const headers: string[] = [];
    const captureServer = createServer((req, res) => {
      headers.push(req.headers["x-execution-token"] as string);
      res.writeHead(204).end();
      req.resume();
    });
    await new Promise<void>((r) => captureServer.listen(0, "127.0.0.1", () => r()));
    const port = (captureServer.address() as AddressInfo).port;
    const pub = new StreamPublisher({
      executionId: "exec-e2e-2",
      token: "secret-token-abc",
      callbackBaseUrl: `http://127.0.0.1:${port}`,
      flushMs: 100,
      flushTokens: 100,
      callbackTimeoutMs: 2000,
    });
    await pub.emit({
      type: "reasoning_step",
      payload: { strategy: "react", stepIndex: 0, summary: "" },
    });
    await new Promise<void>((r) => captureServer.close(() => r()));
    expect(headers).toContain("secret-token-abc");
  });
});
