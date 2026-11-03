import { describe, it, expect } from "vitest";
import { PlanExecuteEngine } from "../../../src/reasoning/plan-execute.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import { makeContext, llmJson } from "./_helpers.js";

describe("PlanExecuteEngine doctrine channel separation (Fase 0 §3.4)", () => {
  it("doctrine arrives via separate doctrine field in plan() call, NOT in goal/system/user", async () => {
    // plan() makes one LLM call to produce a step list
    const llm = new FakeLlmClient({
      responses: [
        llmJson({ steps: [{ index: 0, description: "do-thing" }] })
      ]
    });
    const ctx = makeContext(llm, { systemPrompt: "SENTINEL_DOCTRINE" });
    const engine = new PlanExecuteEngine();
    const plan = await engine.plan("User request:\nhello", ctx);

    expect(plan.goal).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].doctrine).toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].system).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].user ?? "").not.toContain("SENTINEL_DOCTRINE");
  });

  it("doctrine arrives via separate doctrine field in step() call, NOT in goal/system/user", async () => {
    // step() makes one LLM call to execute a plan step
    const llm = new FakeLlmClient({
      responses: [
        llmJson({ thinking: "t", text: "done" })
      ]
    });
    const ctx = makeContext(llm, { systemPrompt: "SENTINEL_DOCTRINE" });
    const engine = new PlanExecuteEngine();
    const plan = { goal: "hello", steps: [{ index: 0, description: "do it" }], estimatedComplexity: "low" as const };
    await engine.step(plan, 0, [], ctx, async () => undefined);

    expect(plan.goal).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].doctrine).toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].system).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].user ?? "").not.toContain("SENTINEL_DOCTRINE");
  });
});
