import { describe, it, expect } from "vitest";
import { DirectEngine } from "../../../src/reasoning/direct.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import { makeContext, llmJson } from "./_helpers.js";

describe("DirectEngine doctrine channel separation (Fase 0 §3.4)", () => {
  it("doctrine arrives via separate doctrine field, NOT in goal/system/user", async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ result: "ok" })] });
    const ctx = makeContext(llm, { systemPrompt: "SENTINEL_DOCTRINE" });
    const engine = new DirectEngine();
    const plan = await engine.plan("User request:\nhello", ctx);
    await engine.step(plan, 0, [], ctx, async () => undefined);

    expect(plan.goal).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].doctrine).toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].system).not.toContain("SENTINEL_DOCTRINE");
    expect(llm.calls[0].user ?? "").not.toContain("SENTINEL_DOCTRINE");
  });
});
