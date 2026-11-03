import { describe, expect, it, vi } from "vitest";

import { StreamBuffer } from "../../../../../src/integration/llm/streaming/buffer.js";

describe("StreamBuffer", () => {
  it("flushes when flushTokens threshold reached", async () => {
    const onFlush = vi.fn(async () => undefined);
    const buf = new StreamBuffer({ flushMs: 1000, flushTokens: 3, onFlush });
    buf.push("a");
    buf.push("b");
    buf.push("c"); // triggers flush
    await buf.flush(); // drain inflight
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({ text: "abc", tokenCount: 3 });
  });

  it("flushes via timer when threshold not reached", async () => {
    const onFlush = vi.fn(async () => undefined);
    const buf = new StreamBuffer({ flushMs: 30, flushTokens: 100, onFlush });
    buf.push("x");
    await new Promise((r) => setTimeout(r, 60));
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("manual flush works at any moment", async () => {
    const onFlush = vi.fn(async () => undefined);
    const buf = new StreamBuffer({ flushMs: 5000, flushTokens: 100, onFlush });
    buf.push("hi");
    await buf.flush();
    expect(onFlush).toHaveBeenCalledWith({ text: "hi", tokenCount: 1 });
  });

  it("push after flush restarts timer", async () => {
    const onFlush = vi.fn(async () => undefined);
    const buf = new StreamBuffer({ flushMs: 20, flushTokens: 100, onFlush });
    buf.push("a");
    await new Promise((r) => setTimeout(r, 40));
    buf.push("b");
    await new Promise((r) => setTimeout(r, 40));
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("close() drains and rejects further pushes", async () => {
    const onFlush = vi.fn(async () => undefined);
    const buf = new StreamBuffer({ flushMs: 5000, flushTokens: 100, onFlush });
    buf.push("a");
    await buf.close();
    expect(onFlush).toHaveBeenCalledTimes(1);
    buf.push("b");
    await buf.flush();
    expect(onFlush).toHaveBeenCalledTimes(1); // ignored after close
  });

  it("flush() with empty buffer is a no-op", async () => {
    const onFlush = vi.fn(async () => undefined);
    const buf = new StreamBuffer({ flushMs: 100, flushTokens: 10, onFlush });
    await buf.flush();
    expect(onFlush).not.toHaveBeenCalled();
  });
});
