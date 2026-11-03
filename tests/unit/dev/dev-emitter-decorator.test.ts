import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetDevEventBusForTests,
  getDevEventBus,
} from "../../../src/dev/event-bus.js";
import type { DevEvent, LLMCallEvent } from "../../../src/dev/types.js";
import { DevEmitterLLM } from "../../../src/integration/llm/dev-emitter-decorator.js";
import type { LLMGateway, LLMResponse } from "../../../src/integration/llm-gateway.js";

function fakeGateway(response: LLMResponse): LLMGateway {
  return {
    async complete(): Promise<LLMResponse> {
      return response;
    },
  };
}

const baseResponse: LLMResponse = {
  content: "hello world",
  tool_calls: [],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  model: "gpt-4o-mini",
  provider: "openai",
  latency_ms: 100,
};

describe("DevEmitterLLM", () => {
  beforeEach(() => {
    _resetDevEventBusForTests();
    process.env["HARNESS_DEV_MODE"] = "1";
    process.env["NODE_ENV"] = "development";
  });

  afterEach(() => {
    _resetDevEventBusForTests();
    delete process.env["HARNESS_DEV_MODE"];
    delete process.env["NODE_ENV"];
  });

  it("passes through when dev mode is disabled", async () => {
    delete process.env["HARNESS_DEV_MODE"];
    const events: DevEvent[] = [];
    getDevEventBus().on("event", (e: DevEvent) => events.push(e));
    const decorator = new DevEmitterLLM(fakeGateway(baseResponse));
    const res = await decorator.complete({
      messages: [{ role: "user", content: "hi" }],
      meta: { executionId: "exec-1" },
    });
    expect(res.content).toBe("hello world");
    expect(events).toHaveLength(0);
  });

  it("does not emit when meta.executionId is missing", async () => {
    const events: DevEvent[] = [];
    getDevEventBus().on("event", (e: DevEvent) => events.push(e));
    const decorator = new DevEmitterLLM(fakeGateway(baseResponse));
    await decorator.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(events).toHaveLength(0);
  });

  it("emits llm.call event with truncation when payload exceeds default budget", async () => {
    const events: DevEvent[] = [];
    getDevEventBus().on("event", (e: DevEvent) => events.push(e));
    const decorator = new DevEmitterLLM(fakeGateway(baseResponse));
    // Default HARNESS_DEV_PROMPT_MAX_BYTES is 8192; well below 20_000.
    await decorator.complete({
      messages: [{ role: "user", content: "x".repeat(20_000) }],
      meta: { executionId: "exec-1", purpose: "test" },
    });
    expect(events).toHaveLength(1);
    const ev = events[0] as LLMCallEvent;
    expect(ev.kind).toBe("llm.call");
    expect(ev.executionId).toBe("exec-1");
    expect(ev.purpose).toBe("test");
    expect(ev.prompt.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(ev.prompt, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("emits even on inner error and rethrows", async () => {
    const events: DevEvent[] = [];
    getDevEventBus().on("event", (e: DevEvent) => events.push(e));
    const decorator = new DevEmitterLLM({
      async complete(): Promise<LLMResponse> {
        throw new Error("upstream boom");
      },
    });
    await expect(
      decorator.complete({
        messages: [{ role: "user", content: "hi" }],
        meta: { executionId: "exec-x" },
      }),
    ).rejects.toThrow("upstream boom");
    expect(events).toHaveLength(1);
    expect((events[0] as LLMCallEvent).response).toContain("error");
  });
});
