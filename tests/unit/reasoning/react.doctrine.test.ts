import { describe, it, expect } from "vitest";
import { ReactEngine } from "../../../src/reasoning/react.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import { makeContext, llmJson } from "./_helpers.js";

describe("ReAct doctrine channel separation (Fase 0 §3.4)", () => {
  it("doctrine arrives via separate doctrine field, NOT in goal/system/user", async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ action: "finish", final: "done" })] });
    const ctx = makeContext(llm, { systemPrompt: "SENTINEL_DOCTRINE" });
    const engine = new ReactEngine();
    const plan = await engine.plan("User request:\nhello", ctx);
    await engine.step(plan, 0, [], ctx, async () => ({ ok: true, data: {} }));

    expect(plan.goal).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].doctrine).toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].system).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].user ?? "").not.toContain("SENTINEL_DOCTRINE");
  });

  it("trace event carries resolvedSystemPrompt", async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ action: "finish", final: "done" })] });
    const ctx = makeContext(llm, { systemPrompt: "SENTINEL_DOCTRINE" });
    const engine = new ReactEngine();
    const plan = await engine.plan("User request:\nhi", ctx);
    let captured: unknown;
    await engine.step(plan, 0, [], ctx, async () => ({ ok: true, data: {} }),
      (e) => { captured = (e as { resolvedSystemPrompt?: string }).resolvedSystemPrompt; });
    expect(captured).toBe("SENTINEL_DOCTRINE");
  });
});
