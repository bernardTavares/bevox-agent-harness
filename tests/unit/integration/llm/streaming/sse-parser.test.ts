import { describe, expect, it } from "vitest";

import { parseSSE } from "../../../../../src/integration/llm/streaming/sse-parser.js";

function makeResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function collect(r: Response): Promise<Array<{ event?: string; data: string }>> {
  const out: Array<{ event?: string; data: string }> = [];
  for await (const e of parseSSE(r)) out.push(e);
  return out;
}

describe("parseSSE", () => {
  it("parses single data event", async () => {
    const r = makeResponse(["data: hello\n\n"]);
    expect(await collect(r)).toEqual([{ data: "hello" }]);
  });

  it("concatenates multiple data lines per event", async () => {
    const r = makeResponse(["data: line1\ndata: line2\n\n"]);
    expect(await collect(r)).toEqual([{ data: "line1\nline2" }]);
  });

  it("respects event: marker", async () => {
    const r = makeResponse(["event: ping\ndata: x\n\n"]);
    expect(await collect(r)).toEqual([{ event: "ping", data: "x" }]);
  });

  it("handles chunk boundaries mid-event", async () => {
    const r = makeResponse(["data: hel", "lo\n", "\ndata: world\n\n"]);
    expect(await collect(r)).toEqual([{ data: "hello" }, { data: "world" }]);
  });

  it("flushes trailing buffer without final \\n\\n", async () => {
    const r = makeResponse(["data: tail"]);
    expect(await collect(r)).toEqual([{ data: "tail" }]);
  });
});
