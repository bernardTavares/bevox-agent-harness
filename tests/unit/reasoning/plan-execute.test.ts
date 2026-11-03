import { describe, it, expect } from "vitest";
import { PlanExecuteEngine } from "../../../src/reasoning/plan-execute.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import { makeContext, llmJson, llmText } from "./_helpers.js";
import type { Observation, Plan } from "../../../src/reasoning/engine.js";

describe("PlanExecuteEngine", () => {
  it("plan() builds a multi-step plan from LLM JSON output", async () => {
    const llm = new FakeLlmClient({
      responses: [
        llmJson({
          steps: [
            { index: 0, description: "check availability", toolName: "list-appointments" },
            { index: 1, description: "book slot", toolName: "create-appointment" },
          ],
        }),
      ],
    });
    const engine = new PlanExecuteEngine();
    const plan = await engine.plan("schedule", makeContext(llm));
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].index).toBe(0);
    expect(plan.steps[1].index).toBe(1);
    expect(plan.estimatedComplexity).toBe("high");
  });

  it("plan() falls back when LLM returns invalid JSON", async () => {
    const llm = new FakeLlmClient({ responses: [llmText("not json")] });
    const engine = new PlanExecuteEngine();
    const plan = await engine.plan("goal", makeContext(llm));
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toBe("execute-goal-directly");
  });

  it("plan() falls back when steps array is empty", async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ steps: [] })] });
    const engine = new PlanExecuteEngine();
    const plan = await engine.plan("goal", makeContext(llm));
    expect(plan.steps).toHaveLength(1);
    expect(plan.estimatedComplexity).toBe("low");
  });

  it("step() executes current step with tool call", async () => {
    const llm = new FakeLlmClient({
      responses: [
        llmJson({ thinking: "t", toolName: "list-appointments", toolParams: { day: "today" } }),
      ],
    });
    const engine = new PlanExecuteEngine();
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: "g",
      steps: [{ index: 0, description: "fetch", toolName: "list-appointments" }],
      estimatedComplexity: "medium",
    };
    const result = await engine.step(plan, 0, [], ctx, async () => ({ items: [] }));
    expect(result.success).toBe(true);
    expect(result.toolName).toBe("list-appointments");
    expect(result.toolOutput).toEqual({ items: [] });
  });

  it("step() returns failure for missing step index", async () => {
    const engine = new PlanExecuteEngine();
    const ctx = makeContext();
    const plan: Plan = { goal: "g", steps: [], estimatedComplexity: "low" };
    const result = await engine.step(plan, 99, [], ctx, async () => undefined);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("not found");
  });

  it("step() handles plain-text LLM answer (no tool)", async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ thinking: "t", text: "final" })] });
    const engine = new PlanExecuteEngine();
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: "g",
      steps: [{ index: 0, description: "answer" }],
      estimatedComplexity: "low",
    };
    const result = await engine.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(true);
    expect(result.toolOutput).toEqual({ text: "final" });
  });

  it("step() captures error on LLM failure", async () => {
    const llm = new FakeLlmClient({ responses: [new Error("llm exploded")] });
    const engine = new PlanExecuteEngine();
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: "g",
      steps: [{ index: 0, description: "s" }],
      estimatedComplexity: "low",
    };
    const result = await engine.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("llm exploded");
  });

  it("step() invokes traceCallback", async () => {
    // step() makes 1 LLM call; trace callback then invokes observe() which scores divergence (1 more LLM call)
    const llm = new FakeLlmClient({
      responses: [llmJson({ text: "ok" }), llmJson({ score: 0.1 })],
    });
    const engine = new PlanExecuteEngine();
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: "g",
      steps: [{ index: 0, description: "s" }],
      estimatedComplexity: "low",
    };
    const events: unknown[] = [];
    await engine.step(
      plan,
      0,
      [],
      ctx,
      async () => undefined,
      (e) => events.push(e),
    );
    expect(events).toHaveLength(1);
  });

  it("observe() computes divergence score on success", async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ score: 0.4 })] });
    const engine = new PlanExecuteEngine();
    const obs = await engine.observe(
      { stepIndex: 0, success: true, toolName: "t", toolOutput: { ok: true }, durationMs: 1 },
      makeContext(llm),
    );
    expect(obs.divergenceScore).toBe(0.4);
    expect(obs.success).toBe(true);
  });

  it("observe() clamps divergence and handles failed LLM scoring", async () => {
    const llm = new FakeLlmClient({ responses: [new Error("scorer down")] });
    const engine = new PlanExecuteEngine();
    const obs = await engine.observe(
      { stepIndex: 0, success: true, toolOutput: "x", durationMs: 1 },
      makeContext(llm),
    );
    expect(obs.divergenceScore).toBe(0);
  });

  it("observe() skips divergence scoring on failed step", async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ score: 0.9 })] });
    const engine = new PlanExecuteEngine();
    const obs = await engine.observe(
      { stepIndex: 0, success: false, errorMessage: "boom", durationMs: 1 },
      makeContext(llm),
    );
    expect(obs.divergenceScore).toBe(0);
    expect(obs.summary).toBe("[Error] boom");
    expect(llm.calls).toHaveLength(0);
  });

  it("shouldContinue() returns true on empty observations", async () => {
    const engine = new PlanExecuteEngine();
    const plan: Plan = {
      goal: "g",
      steps: [{ index: 0, description: "s" }],
      estimatedComplexity: "low",
    };
    expect(await engine.shouldContinue([], plan, makeContext())).toBe(true);
  });

  it("shouldContinue() stops on stop-tool", async () => {
    const engine = new PlanExecuteEngine();
    const plan: Plan = {
      goal: "g",
      steps: [
        { index: 0, description: "s" },
        { index: 1, description: "s2" },
      ],
      estimatedComplexity: "low",
    };
    const obs: Observation = {
      stepIndex: 0,
      summary: "sent",
      success: true,
      raw: { stepIndex: 0, success: true, toolName: "send-message", durationMs: 1 },
    };
    expect(await engine.shouldContinue([obs], plan, makeContext())).toBe(false);
  });

  it("shouldContinue() stops when all plan steps done", async () => {
    const engine = new PlanExecuteEngine();
    const plan: Plan = {
      goal: "g",
      steps: [{ index: 0, description: "s" }],
      estimatedComplexity: "low",
    };
    const obs: Observation = {
      stepIndex: 0,
      summary: "x",
      success: true,
      raw: { stepIndex: 0, success: true, toolName: "foo", durationMs: 1 },
    };
    expect(await engine.shouldContinue([obs], plan, makeContext())).toBe(false);
  });

  it("shouldContinue() triggers replan when divergence exceeds threshold", async () => {
    // Order of LLM calls for the engine instance:
    //  1) observe() → score (returns 0.9)
    //  2) shouldContinue() → _replan() → returns new step list
    const llm = new FakeLlmClient({
      responses: [
        llmJson({ score: 0.9 }),
        llmJson({ steps: [{ index: 0, description: "revised-step" }] }),
      ],
    });
    const engine = new PlanExecuteEngine({ replanThreshold: 0.5 });
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: "g",
      steps: [
        { index: 0, description: "s0" },
        { index: 1, description: "s1" },
        { index: 2, description: "s2" },
      ],

      estimatedComplexity: "high",
    };
    // Mutate engine state via observe()
    const observation = await engine.observe(
      { stepIndex: 0, success: true, toolName: "foo", toolOutput: { x: 1 }, durationMs: 1 },
      ctx,
    );
    expect(observation.divergenceScore).toBe(0.9);
    const shouldGo = await engine.shouldContinue([observation], plan, ctx);
    expect(shouldGo).toBe(true);
    const synth = await engine.synthesize([observation], plan, ctx);
    expect(synth.escalated).toBe(true);
  });

  it("shouldContinue() does NOT replan when allowReplan is false", async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ score: 0.9 })] });
    const engine = new PlanExecuteEngine({ replanThreshold: 0.5, allowReplan: false });
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: "g",
      steps: [
        { index: 0, description: "s0" },
        { index: 1, description: "s1" },
      ],
      estimatedComplexity: "high",
    };
    const observation = await engine.observe(
      { stepIndex: 0, success: true, toolName: "foo", toolOutput: { x: 1 }, durationMs: 1 },
      ctx,
    );
    await engine.shouldContinue([observation], plan, ctx);
    const synth = await engine.synthesize([observation], plan, ctx);
    expect(synth.escalated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // a-reasoning-04: replan-boundary correctness (issue #47)
  // -------------------------------------------------------------------------

  it("plan() stamps initial generation=0 on the returned plan", async () => {
    const llm = new FakeLlmClient({
      responses: [
        llmJson({
          steps: [
            { index: 0, description: "s0" },
            { index: 1, description: "s1" },
          ],
        }),
      ],
    });
    const engine = new PlanExecuteEngine();
    const plan = await engine.plan("g", makeContext(llm));
    expect(plan.generation).toBe(0);
  });

  it("observe() stamps planGeneration matching the engine state", async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ score: 0.2 })] });
    const engine = new PlanExecuteEngine();
    const obs = await engine.observe(
      { stepIndex: 0, success: true, toolName: "t", toolOutput: { ok: true }, durationMs: 1 },
      makeContext(llm),
    );
    expect(obs.planGeneration).toBe(0);
  });

  it("shouldContinue() reads divergence from last observation, not stale instance state", async () => {
    // Scenario: engine.lastDivergenceScore was reset to 0 by a prior _replan(),
    // but the next step's observation reports a fresh high divergence.
    // The fix must re-trigger replan using observation.divergenceScore, not
    // the instance field.
    const llm = new FakeLlmClient({
      responses: [
        // _replan() LLM call returning a fresh plan
        llmJson({
          steps: [
            { index: 0, description: "revised" },
            { index: 1, description: "revised2" },
          ],
        }),
      ],
    });
    const engine = new PlanExecuteEngine({ replanThreshold: 0.5 });
    const ctx = makeContext(llm);

    // Simulate that a previous _replan() zeroed the instance field
    // (engine.lastDivergenceScore is private — we exercise the code path
    // by relying on engine never having observed yet, so it's 0 by default).
    const plan: Plan = {
      goal: "g",
      steps: [
        { index: 0, description: "s0" },
        { index: 1, description: "s1" },
        { index: 2, description: "s2" },
      ],
      estimatedComplexity: "high",
      generation: 0,
    };

    // Observation carries divergenceScore = 0.9 inline; this must be read
    // by shouldContinue() and trigger a replan even though
    // engine.lastDivergenceScore is still 0.
    const obs: Observation = {
      stepIndex: 0,
      summary: "x",
      success: true,
      raw: { stepIndex: 0, success: true, toolName: "foo", durationMs: 1 },
      divergenceScore: 0.9,
      planGeneration: 0,
    };

    const cont = await engine.shouldContinue([obs], plan, ctx);
    expect(cont).toBe(true);
    const synth = await engine.synthesize([obs], plan, ctx);
    expect(synth.escalated).toBe(true);
    // Plan generation must have been bumped by _replan()
    expect(plan.generation).toBe(1);
  });

  it("shouldContinue() stops after replan when current-generation observations match new plan length", async () => {
    // Bug scenario: after a replan, accumulated observations from the
    // pre-replan plan would satisfy `observations.length >= plan.steps.length`
    // and prematurely terminate (or, if the new plan was longer, fail to
    // terminate when all new steps were done).
    const engine = new PlanExecuteEngine({ replanThreshold: 0.5 });
    const ctx = makeContext();

    // 2-step plan in the *new* generation (gen=1)
    const plan: Plan = {
      goal: "g",
      steps: [
        { index: 0, description: "new-s0" },
        { index: 1, description: "new-s1" },
      ],
      estimatedComplexity: "high",
      generation: 1,
    };

    // Observations: 3 from old gen (gen=0) + 2 from new gen (gen=1).
    // Total length = 5, but only the 2 current-gen entries should count.
    const observations: Observation[] = [
      {
        stepIndex: 0,
        summary: "old0",
        success: true,
        raw: { stepIndex: 0, success: true, durationMs: 1 },
        planGeneration: 0,
      },
      {
        stepIndex: 1,
        summary: "old1",
        success: true,
        raw: { stepIndex: 1, success: true, durationMs: 1 },
        planGeneration: 0,
      },
      {
        stepIndex: 2,
        summary: "old2",
        success: true,
        raw: { stepIndex: 2, success: true, durationMs: 1 },
        planGeneration: 0,
      },
      {
        stepIndex: 0,
        summary: "new0",
        success: true,
        raw: { stepIndex: 0, success: true, durationMs: 1 },
        divergenceScore: 0.1,
        planGeneration: 1,
      },
      {
        stepIndex: 1,
        summary: "new1",
        success: true,
        raw: { stepIndex: 1, success: true, durationMs: 1 },
        divergenceScore: 0.1,
        planGeneration: 1,
      },
    ];

    // 2 current-gen observations >= 2 plan steps → stop.
    const cont = await engine.shouldContinue(observations, plan, ctx);
    expect(cont).toBe(false);
  });

  it("shouldContinue() does NOT terminate while current-gen observations are below new plan length, even when accumulated total exceeds it", async () => {
    // Inverse of the above: new plan has 3 steps, only 1 new-gen observation
    // recorded. Legacy code would see total length 4 >= 3 and stop early.
    // The fix should keep going.
    const engine = new PlanExecuteEngine({ replanThreshold: 0.5, allowReplan: false });
    const ctx = makeContext();

    const plan: Plan = {
      goal: "g",
      steps: [
        { index: 0, description: "new-s0" },
        { index: 1, description: "new-s1" },
        { index: 2, description: "new-s2" },
      ],
      estimatedComplexity: "high",
      generation: 1,
    };

    const observations: Observation[] = [
      {
        stepIndex: 0,
        summary: "old0",
        success: true,
        raw: { stepIndex: 0, success: true, durationMs: 1 },
        planGeneration: 0,
      },
      {
        stepIndex: 1,
        summary: "old1",
        success: true,
        raw: { stepIndex: 1, success: true, durationMs: 1 },
        planGeneration: 0,
      },
      {
        stepIndex: 2,
        summary: "old2",
        success: true,
        raw: { stepIndex: 2, success: true, durationMs: 1 },
        planGeneration: 0,
      },
      {
        stepIndex: 0,
        summary: "new0",
        success: true,
        raw: { stepIndex: 0, success: true, durationMs: 1 },
        divergenceScore: 0.1,
        planGeneration: 1,
      },
    ];

    const cont = await engine.shouldContinue(observations, plan, ctx);
    expect(cont).toBe(true);
  });

  it("reset() clears divergence and replan flags but preserves plan generation counter", async () => {
    const llm = new FakeLlmClient({
      responses: [
        // observe() → divergence score
        llmJson({ score: 0.9 }),
        // _replan() inside shouldContinue() → new plan steps
        llmJson({ steps: [{ index: 0, description: "r0" }] }),
      ],
    });
    const engine = new PlanExecuteEngine({ replanThreshold: 0.5 });
    const ctx = makeContext(llm);

    // Walk through one cycle to mutate state
    const plan: Plan = {
      goal: "g",
      steps: [
        { index: 0, description: "s0" },
        { index: 1, description: "s1" },
      ],
      estimatedComplexity: "high",
      generation: 0,
    };
    const obs = await engine.observe(
      { stepIndex: 0, success: true, toolName: "foo", toolOutput: { x: 1 }, durationMs: 1 },
      ctx,
    );
    await engine.shouldContinue([obs], plan, ctx);
    // Synthesize confirms replanOccurred=true post-cycle
    const before = await engine.synthesize([obs], plan, ctx);
    expect(before.escalated).toBe(true);
    expect(plan.generation).toBe(1);

    // reset() must clear replanOccurred so the next synthesize() reports
    // escalated=false (instance is now treated as a fresh post-escalation state)
    engine.reset();
    const after = await engine.synthesize([obs], plan, ctx);
    expect(after.escalated).toBe(false);
  });

  it("shouldContinue() falls back to legacy length check when plan.generation is undefined", async () => {
    // Regression guard: callers that don't set plan.generation get
    // the same behaviour as before the fix.
    const engine = new PlanExecuteEngine();
    const plan: Plan = {
      goal: "g",
      steps: [{ index: 0, description: "s0" }],
      estimatedComplexity: "low",
      // no generation field
    };
    const obs: Observation = {
      stepIndex: 0,
      summary: "x",
      success: true,
      raw: { stepIndex: 0, success: true, toolName: "foo", durationMs: 1 },
      // no planGeneration field
    };
    const cont = await engine.shouldContinue([obs], plan, makeContext());
    expect(cont).toBe(false);
  });

  it("synthesize() returns last successful observation summary", async () => {
    const engine = new PlanExecuteEngine();
    const plan: Plan = {
      goal: "g",
      steps: [{ index: 0, description: "s" }],
      estimatedComplexity: "low",
    };
    const obs: Observation[] = [
      {
        stepIndex: 0,
        summary: "first",
        success: true,
        raw: { stepIndex: 0, success: true, durationMs: 1 },
      },
      {
        stepIndex: 1,
        summary: "fail",
        success: false,
        raw: { stepIndex: 1, success: false, durationMs: 1 },
      },
    ];

    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe("first");
    expect(resp.strategy).toBe("plan-execute");
    expect(resp.escalated).toBe(false);
  });
});
