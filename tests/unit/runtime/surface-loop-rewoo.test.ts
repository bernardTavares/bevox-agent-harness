import { describe, it, expect } from "vitest";

import { runSurfaceAgentLoop } from "../../../src/runtime/execution-handler.js";
import type { AgentDefinition } from "../../../src/agents/types.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { ToolExecutor } from "../../../src/reasoning/engine.js";
import { ExecutionAbortError } from "../../../src/runtime/errors.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";

function jsonResp(obj: unknown) {
  return { content: JSON.stringify(obj), model: "m", promptTokens: 1, completionTokens: 1 };
}

function makeLoopContext(
  llm: FakeLlmClient,
  extra: Partial<AgentExecutionContext> = {},
): AgentExecutionContext {
  return {
    executionId: "exec-rewoo-1",
    organizationId: "org-rewoo-1",
    conversationKey: "conv-1",
    db: {} as never,
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
    } as never,
    llmClient: llm,
    accountConfig: { llmModel: "fake-model" },
    systemPrompt: "DOCTRINE",
    ...extra,
  };
}

// plan-execute default → router builds PlanExecuteEngine (no reflexion wrap),
// whose plan() preserves dependsOn from the LLM JSON. StepEvaluator Rule 2
// counts INDEPENDENT (dependsOn:[]) plan steps NOT YET completed at evaluation
// time. Because PlanExecute drains steps sequentially, by the time `evaluate`
// runs (AFTER the first step's observation is pushed) only ONE independent step
// remains (step 0 done; step 1 independent; step 2 depends on [0,1]). So
// parallelThreshold:1 is what makes Rule 2 fire after the first PlanExecute
// step and escalate to ReWOO — threshold:2 would never trip on this sequential
// path. We exercise the REAL PlanExecuteEngine + ReWOOEngine against a fake LLM
// and assert ORDER (dependent step in a later wave), NOT data-flow (OQ6).
const planExecAgent: AgentDefinition = {
  name: "rewoo-test-agent",
  type: "surface",
  description: "plan-execute that escalates to rewoo",
  reasoning: {
    default: "plan-execute",
    escalation: {
      stepThreshold: 99,
      escalateTo: "rewoo",
      parallelThreshold: 1,
      onFailure: "abort",
    },
  },
  permissions: { required: [], denied: [] },
};

// Plan with 0 and 1 independent, 2 depends on [0,1]. PlanExecuteEngine.plan
// and ReWOOEngine.plan both parse `steps` from the LLM JSON, so the same shape
// works for whichever engine re-plans. Provide enough responses for the
// PlanExecute initial plan + step + the ReWOO re-plan + 3 wave steps.
const depPlan = {
  steps: [
    { index: 0, description: "A", dependsOn: [] },
    { index: 1, description: "B", dependsOn: [] },
    { index: 2, description: "C", dependsOn: [0, 1] },
  ],
};

describe("runSurfaceAgentLoop — ReWOO via executeWaves (R03)", () => {
  it("escalate-to-rewoo runs executeWaves; dependent step runs AFTER prerequisites (ORDER)", async () => {
    // PlanExecuteEngine.observe() runs a divergence-scorer LLM micro-call after
    // each successful step, so there is ONE extra LLM call between the first
    // PlanExecute step and the ReWOO re-plan. We line up an explicit response
    // for it and use defaultResponse: depPlan so any stray call yields parseable
    // JSON (the scorer reads `score`; a depPlan body → NaN → 0, no replan).
    const llm = new FakeLlmClient({
      defaultResponse: jsonResp(depPlan),
      responses: [
        jsonResp(depPlan), // PlanExecute initial plan → multi-step, >=1 independent
        jsonResp({ thinking: "t", toolName: "noop", toolParams: {} }), // first PlanExecute step
        jsonResp(depPlan), // PlanExecute observe() divergence-scorer micro-call
        jsonResp(depPlan), // ReWOO re-plan after escalation
        jsonResp({ toolName: "t0", toolParams: {} }), // wave 1 step 0
        jsonResp({ toolName: "t1", toolParams: {} }), // wave 1 step 1
        jsonResp({ toolName: "t2", toolParams: {} }), // wave 2 step 2
      ],
    });
    const callOrder: string[] = [];
    const tracer: ToolExecutor = async (name) => {
      callOrder.push(name);
      return { ok: name };
    };
    const result = await runSurfaceAgentLoop(planExecAgent, "goal", makeLoopContext(llm), [], tracer);
    expect(result.escalationChain).toContain("rewoo");
    expect(result.escalated).toBe(true);
    // t2 (depends on 0,1) must run after t0 AND t1 (ORDER, not data-flow)
    expect(callOrder.indexOf("t2")).toBeGreaterThan(callOrder.indexOf("t0"));
    expect(callOrder.indexOf("t2")).toBeGreaterThan(callOrder.indexOf("t1"));
  });

  it("J9 cost ceiling crossed before waves → ExecutionAbortError(cost_ceiling)", async () => {
    const llm = new FakeLlmClient({
      responses: [
        jsonResp(depPlan), // PlanExecute initial plan
        jsonResp({ thinking: "t", toolName: "noop", toolParams: {} }), // first step
      ],
    });
    const ctx = makeLoopContext(llm, {
      costCeilingCents: 10,
      costAccumulator: { costCents: 50 }, // already over ceiling
    });
    await expect(
      runSurfaceAgentLoop(planExecAgent, "goal", ctx, [], async () => ({ ok: true })),
    ).rejects.toBeInstanceOf(ExecutionAbortError);
  });
});
