import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, vi } from "vitest";

import type {
  LLMGateway,
  LLMRequestOptions,
  LLMResponse,
} from "../../../../src/integration/llm-gateway.js";
import { CassetteStore } from "../../../../src/integration/llm/cassette-store.js";
import { LLMRecorder } from "../../../../src/integration/llm/recorder.js";

const MODEL = "gpt-4o-mini";

function makeResponse(content = "ok"): LLMResponse {
  return {
    content,
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    model: MODEL,
    provider: "openai",
    latency_ms: 42,
  };
}

const baseOpts: LLMRequestOptions = {
  messages: [{ role: "user", content: "hi" }],
};

describe("LLMRecorder", () => {
  let dir: string;
  let store: CassetteStore;
  let wrapped: { complete: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "recorder-"));
    store = new CassetteStore(dir);
    wrapped = { complete: vi.fn() };
  });

  it("records a miss and returns the underlying response", async () => {
    const fake = makeResponse("recorded");
    wrapped.complete.mockResolvedValue(fake);
    const recorder = new LLMRecorder(wrapped as unknown as LLMGateway, store, "test", MODEL);

    const res = await recorder.complete(baseOpts);

    expect(res).toEqual(fake);
    expect(wrapped.complete).toHaveBeenCalledOnce();
    const cassette = await store.load("test");
    expect(cassette?.entries).toHaveLength(1);
    expect(cassette?.entries[0]?.response.content).toBe("recorded");
  });

  it("does not call upstream on cassette hit", async () => {
    wrapped.complete.mockResolvedValue(makeResponse("first"));
    const recorder = new LLMRecorder(wrapped as unknown as LLMGateway, store, "test", MODEL);

    await recorder.complete(baseOpts); // miss → records
    wrapped.complete.mockClear();
    const res = await recorder.complete(baseOpts); // hit

    expect(wrapped.complete).not.toHaveBeenCalled();
    expect(res.content).toBe("first");
  });

  it("captures request_summary fields correctly", async () => {
    wrapped.complete.mockResolvedValue(makeResponse());
    const recorder = new LLMRecorder(wrapped as unknown as LLMGateway, store, "test", MODEL);
    await recorder.complete({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      tools: [{ name: "t", description: "d", parameters: {} }],
      temperature: 0.3,
    });
    const cassette = await store.load("test");
    const summary = cassette!.entries[0]!.request_summary;
    expect(summary.n_messages).toBe(2);
    expect(summary.n_tools).toBe(1);
    expect(summary.temperature).toBe(0.3);
    expect(summary.has_response_schema).toBe(false);
    expect(summary.provider).toBe("openai");
  });

  it("normalizes absent tools to n_tools = 0", async () => {
    wrapped.complete.mockResolvedValue(makeResponse());
    const recorder = new LLMRecorder(wrapped as unknown as LLMGateway, store, "test", MODEL);
    await recorder.complete(baseOpts);
    const cassette = await store.load("test");
    expect(cassette!.entries[0]!.request_summary.n_tools).toBe(0);
  });

  it("exposes wrapped per LLMDecorator contract", () => {
    const recorder = new LLMRecorder(wrapped as unknown as LLMGateway, store, "test", MODEL);
    expect(recorder.wrapped).toBe(wrapped);
  });

  it("emits a log line on hit and miss when logger is provided", async () => {
    const logger = { info: vi.fn() };
    wrapped.complete.mockResolvedValue(makeResponse());
    const recorder = new LLMRecorder(
      wrapped as unknown as LLMGateway,
      store,
      "test",
      MODEL,
      logger,
    );
    await recorder.complete(baseOpts);
    await recorder.complete(baseOpts);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls[0]![1]).toMatch(/recorded/);
    expect(logger.info.mock.calls[1]![1]).toMatch(/hit/);
  });
});
