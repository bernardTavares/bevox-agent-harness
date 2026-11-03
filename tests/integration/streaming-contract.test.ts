/**
 * H-CB-03 — Streaming wire contract test.
 *
 * Pins the harness → backend contract for `POST /api/v1/executions/:id/stream`
 * (per `bevox-backend/src/integration/harness-callbacks.{routes,schema}.ts`):
 *
 *   Body: { chunk: string (max 4096), index: number (int, >= 0) }
 *   Header: X-Execution-Token
 *   Response: 200 (or any 2xx); body `{accepted, index}`.
 *
 * If any of these drift on the backend side, the lower-level
 * `StreamCallbackSchema` test in `bevox-backend/test/unit/harness-callbacks-schema.test.ts`
 * will also fail — those two together are the contract guard.
 */
import { type AddressInfo, createServer, type Server } from "http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  STREAM_CHUNK_MAX_CHARS,
  sendStreamChunk,
  toBackendStreamChunk,
} from "../../src/integration/bevox-stream-callback.js";
import type { StreamChunk } from "../../src/integration/llm/streaming/types.js";
import { StreamPublisher } from "../../src/runtime/stream-publisher.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

async function withMockBackend(
  handler: (req: CapturedRequest) => { status: number; body?: unknown },
): Promise<{ baseUrl: string; close: () => Promise<void>; received: CapturedRequest[] }> {
  const received: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = raw.length ? JSON.parse(raw) : undefined;
      } catch {
        parsed = raw;
      }
      const captured: CapturedRequest = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body: parsed,
      };
      received.push(captured);
      const out = handler(captured);
      const responseBody = out.body !== undefined ? JSON.stringify(out.body) : "";
      res.writeHead(out.status, { "Content-Type": "application/json" }).end(responseBody);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    received,
  };
}

describe("toBackendStreamChunk (pure mapping)", () => {
  it("maps seq → index and serializes envelope into chunk", () => {
    const env: StreamChunk = {
      type: "token",
      seq: 7,
      timestamp: 1717000000000,
      payload: { delta: "hi" },
    };
    const wire = toBackendStreamChunk(env);
    expect(wire.index).toBe(7);
    expect(typeof wire.chunk).toBe("string");
    const rehydrated = JSON.parse(wire.chunk) as StreamChunk;
    expect(rehydrated).toEqual(env);
  });

  it("truncates oversized envelopes to STREAM_CHUNK_MAX_CHARS", () => {
    // Build a payload large enough to exceed the 4096-char backend cap.
    const huge = "x".repeat(8192);
    const env: StreamChunk = {
      type: "tool_call_delta",
      seq: 1,
      timestamp: 0,
      payload: { toolCallId: "c1", argsDelta: huge },
    };
    const wire = toBackendStreamChunk(env);
    expect(wire.chunk.length).toBeLessThanOrEqual(STREAM_CHUNK_MAX_CHARS);
    expect(wire.chunk.endsWith("…")).toBe(true);
    expect(wire.index).toBe(1);
  });

  it("preserves small envelopes byte-for-byte (no truncation marker)", () => {
    const env: StreamChunk = {
      type: "done",
      seq: 42,
      timestamp: 0,
      payload: { totalDurationMs: 5 },
    };
    const wire = toBackendStreamChunk(env);
    expect(wire.chunk.endsWith("…")).toBe(false);
    expect(JSON.parse(wire.chunk)).toEqual(env);
  });
});

describe("sendStreamChunk (HTTP contract)", () => {
  let mock: Awaited<ReturnType<typeof withMockBackend>>;

  beforeAll(async () => {
    mock = await withMockBackend(() => ({ status: 200, body: { accepted: true, index: 0 } }));
  });

  afterAll(async () => {
    await mock.close();
  });

  it("POSTs to /api/v1/executions/{id}/stream (not /stream-chunk)", async () => {
    const before = mock.received.length;
    await sendStreamChunk({
      baseUrl: mock.baseUrl,
      executionId: "exec-abc",
      token: "tok-1",
      chunk: {
        type: "token",
        seq: 0,
        timestamp: 0,
        payload: { delta: "ok" },
      },
      timeoutMs: 1000,
    });
    const last = mock.received[mock.received.length - 1];
    expect(mock.received.length).toBe(before + 1);
    expect(last.method).toBe("POST");
    expect(last.url).toBe("/api/v1/executions/exec-abc/stream");
    expect(last.url).not.toContain("stream-chunk");
  });

  it("sends `{chunk, index}` shape (matches backend StreamCallbackSchema)", async () => {
    await sendStreamChunk({
      baseUrl: mock.baseUrl,
      executionId: "exec-shape",
      token: "tok-shape",
      chunk: {
        type: "reasoning_step",
        seq: 13,
        timestamp: 1717000000000,
        payload: { strategy: "react", stepIndex: 0, summary: "step" },
      },
      timeoutMs: 1000,
    });
    const last = mock.received[mock.received.length - 1];
    expect(last.body).toBeTypeOf("object");
    const body = last.body as Record<string, unknown>;
    // The schema is `{chunk: string, index: number}` — and nothing else
    // surfaces in production today. Lock both keys to flag drift.
    expect(Object.keys(body).sort()).toEqual(["chunk", "index"]);
    expect(typeof body.chunk).toBe("string");
    expect(body.index).toBe(13);
  });

  it("includes X-Execution-Token header", async () => {
    await sendStreamChunk({
      baseUrl: mock.baseUrl,
      executionId: "exec-hdr",
      token: "secret-token-xyz",
      chunk: { type: "done", seq: 0, timestamp: 0, payload: { totalDurationMs: 0 } },
      timeoutMs: 1000,
    });
    const last = mock.received[mock.received.length - 1];
    expect(last.headers["x-execution-token"]).toBe("secret-token-xyz");
  });

  it("treats 200 + JSON body as success (backend returns 200, not 204)", async () => {
    // The handler defined above returns 200 — should not throw.
    await expect(
      sendStreamChunk({
        baseUrl: mock.baseUrl,
        executionId: "exec-200",
        token: "tok",
        chunk: { type: "done", seq: 0, timestamp: 0, payload: { totalDurationMs: 1 } },
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("sendStreamChunk (error paths)", () => {
  it("throws on non-2xx; StreamPublisher swallows it", async () => {
    const mock = await withMockBackend(() => ({ status: 500, body: { error: "boom" } }));
    try {
      // Direct call surfaces the error to the caller.
      await expect(
        sendStreamChunk({
          baseUrl: mock.baseUrl,
          executionId: "exec-500",
          token: "tok",
          chunk: { type: "token", seq: 0, timestamp: 0, payload: { delta: "x" } },
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(/HTTP 500/);

      // StreamPublisher.emit, in contrast, MUST NOT throw — streaming is
      // best-effort (PRD §16.1, ADR-013).
      const pub = new StreamPublisher({
        executionId: "exec-500-pub",
        token: "tok",
        callbackBaseUrl: mock.baseUrl,
        flushMs: 1000,
        flushTokens: 1000,
        callbackTimeoutMs: 1000,
      });
      await expect(
        pub.emit({
          type: "reasoning_step",
          payload: { strategy: "react", stepIndex: 0, summary: "" },
        }),
      ).resolves.toBeUndefined();
      await pub.close();
    } finally {
      await mock.close();
    }
  });

  it("aborts on timeout", async () => {
    // Mock server that never responds (request hangs).
    const server: Server = createServer((_req, _res) => {
      /* intentionally leave the request open */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        sendStreamChunk({
          baseUrl: `http://127.0.0.1:${port}`,
          executionId: "exec-timeout",
          token: "tok",
          chunk: { type: "token", seq: 0, timestamp: 0, payload: { delta: "x" } },
          timeoutMs: 50,
        }),
      ).rejects.toThrow();
    } finally {
      // Close forcibly to drop hung sockets.
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("StreamPublisher → backend wire (integration)", () => {
  it("dedup-by-index: replaying the same chunk reuses the same index", async () => {
    const mock = await withMockBackend(() => ({ status: 200, body: { accepted: true } }));
    try {
      // Manually invoke sendStreamChunk twice with the same envelope to
      // exercise idempotency on the backend Redis buffer key
      // `stream:{execution_id}`. (StreamPublisher itself increments `seq`
      // on every emit; this scenario simulates a network retry where the
      // SAME (already-seq'd) chunk hits the backend a second time.)
      const env: StreamChunk = {
        type: "token",
        seq: 99,
        timestamp: 0,
        payload: { delta: "retry-me" },
      };
      await sendStreamChunk({
        baseUrl: mock.baseUrl,
        executionId: "exec-dedup",
        token: "tok",
        chunk: env,
        timeoutMs: 1000,
      });
      await sendStreamChunk({
        baseUrl: mock.baseUrl,
        executionId: "exec-dedup",
        token: "tok",
        chunk: env,
        timeoutMs: 1000,
      });
      const indices = mock.received.map((r) => (r.body as { index: number }).index);
      expect(indices).toEqual([99, 99]);
    } finally {
      await mock.close();
    }
  });
});
