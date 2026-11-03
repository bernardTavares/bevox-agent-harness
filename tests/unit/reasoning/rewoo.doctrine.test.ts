import { describe, it, expect } from "vitest";
import { ReWOOEngine } from "../../../src/reasoning/rewoo.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import { makeContext, llmJson } from "./_helpers.js";
import type { Plan } from "../../../src/reasoning/engine.js";

describe("ReWOOEngine doctrine channel separation (Fase 0 §3.4)", () => {
  it("doctrine arrives via separate doctrine field in plan() call, NOT in goal/system/user", async () => {
    const llm = new FakeLlmClient({
      responses: [
        llmJson({ steps: [{ index: 0, description: "do-thing", dependsOn: [] }] })
      ]
    });
    const ctx = makeContext(llm, { systemPrompt: "SENTINEL_DOCTRINE" });
    const engine = new ReWOOEngine();
    const plan = await engine.plan("User request:\nhello", ctx);

    expect(plan.goal).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].doctrine).toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].system).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].user ?? "").not.toContain("SENTINEL_DOCTRINE");
  });

  it("doctrine arrives via separate doctrine field in step() call, NOT in goal/system/user", async () => {
    const llm = new FakeLlmClient({
      responses: [
        llmJson({ thinking: "t", text: "done" })
      ]
    });
    const ctx = makeContext(llm, { systemPrompt: "SENTINEL_DOCTRINE" });
    const engine = new ReWOOEngine();
    const plan: Plan = {
      goal: "hello",
      steps: [{ index: 0, description: "do it", dependsOn: [] }],
      estimatedComplexity: "low"
    };
    await engine.step(plan, 0, [], ctx, async () => undefined);

    expect(plan.goal).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].doctrine).toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].system).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].user ?? "").not.toContain("SENTINEL_DOCTRINE");
  });
});
