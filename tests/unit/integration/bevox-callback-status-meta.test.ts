import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { updateStatus } from "../../../src/integration/bevox-callback.js";

describe("updateStatus with meta (dead-letter signal §a2)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("backward-compatible: no meta → body is just { status }, no Idempotency-Key header", async () => {
    await updateStatus("exec-1", "tok-1", "running");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ status: "running" });
    expect(init.headers["Idempotency-Key"]).toBeUndefined();
    expect(init.headers["X-Execution-Token"]).toBe("tok-1");
  });

  it("dead_letter: meta flows into body (minus idempotencyKey) + header carries the key", async () => {
    await updateStatus("exec-2", "tok-2", "dead_letter", {
      action: "retry_exhausted",
      failedReason: "boom",
      attemptsMade: 7,
      idempotencyKey: "harness:exec-2:0:dead-letter",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/executions/exec-2/status");
    expect(JSON.parse(init.body)).toEqual({
      status: "dead_letter",
      action: "retry_exhausted",
      failedReason: "boom",
      attemptsMade: 7,
    });
    // idempotencyKey is NOT in the body — it is the header.
    expect(JSON.parse(init.body).idempotencyKey).toBeUndefined();
    expect(init.headers["Idempotency-Key"]).toBe("harness:exec-2:0:dead-letter");
  });
});
