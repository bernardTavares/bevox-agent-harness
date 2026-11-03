import { describe, it, expect } from 'vitest';
import { ReflexionWrapper } from "../../../src/reasoning/reflexion.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import { makeContext, llmJson } from "./_helpers.js";
import type {
  AgentResponse,
  Observation,
  Plan,
  ReasoningEngine,
  StepResult } from
"../../../src/reasoning/engine.js";

interface StubEngineOptions {
  stepResults?: StepResult[];
  stepThrow?: Error;
  plan?: Plan;
  synthesize?: AgentResponse;
}

function makeStubEngine(opts: StubEngineOptions = {}): ReasoningEngine & {stepCalls: number;} {
  let stepCalls = 0;
  const plan: Plan = opts.plan ?? {
    goal: 'g',
    steps: [{ index: 0, description: 's' }],
    estimatedComplexity: 'low'
  };
  const engine: ReasoningEngine & {stepCalls: number;} = {
    get stepCalls() {
      return stepCalls;
    },
    set stepCalls(v: number) {
      stepCalls = v;
    },
    strategy: 'react',
    plan: async () => plan,
    step: async () => {
      if (opts.stepThrow) throw opts.stepThrow;
      const next = opts.stepResults?.[stepCalls];
      stepCalls++;
      return (
        next ?? { stepIndex: 0, success: true, toolOutput: 'ok', durationMs: 1 });

    },
    observe: async (stepResult) => ({
      stepIndex: stepResult.stepIndex,
      summary: stepResult.errorMessage ?? 'ok',
      success: stepResult.success,
      raw: stepResult
    }),
    shouldContinue: async () => false,
    synthesize: async (): Promise<AgentResponse> =>
    opts.synthesize ?? {
      answer: 'done',
      observations: [],
      totalSteps: 0,
      strategy: 'react',
      escalated: false,
      retriesUsed: 0
    }
  } as ReasoningEngine & {stepCalls: number;};
  return engine;
}

describe('ReflexionWrapper', () => {
  it('delegates strategy to the inner engine', () => {
    const inner = makeStubEngine();
    const wrapper = new ReflexionWrapper({ inner });
    expect(wrapper.strategy).toBe('react');
  });

  it('delegates plan(), observe(), shouldContinue()', async () => {
    const inner = makeStubEngine();
    const wrapper = new ReflexionWrapper({ inner });
    const ctx = makeContext();
    const plan = await wrapper.plan('g', ctx);
    expect(plan.goal).toBe('g');
    const obs = await wrapper.observe(
      { stepIndex: 0, success: true, durationMs: 1 },
      ctx
    );
    expect(obs.success).toBe(true);
    expect(await wrapper.shouldContinue([], plan, ctx)).toBe(false);
  });

  it('returns inner step result unchanged on success', async () => {
    const inner = makeStubEngine({
      stepResults: [{ stepIndex: 0, success: true, toolOutput: 'ok', durationMs: 1 }]
    });
    const wrapper = new ReflexionWrapper({ inner });
    const plan = await wrapper.plan('g', makeContext());
    const result = await wrapper.step(plan, 0, [], makeContext(), async () => undefined);
    expect(result.success).toBe(true);
    expect(inner.stepCalls).toBe(1);
  });

  it('retries on failure and succeeds within maxRetries', async () => {
    const inner = makeStubEngine({
      stepResults: [
      { stepIndex: 0, success: false, errorMessage: 'fail-1', durationMs: 1 },
      { stepIndex: 0, success: true, toolOutput: 'recovered', durationMs: 1 }]

    });
    const llm = new FakeLlmClient({
      responses: [llmJson({ learnedContext: 'use param X' })]
    });
    const ctx = makeContext(llm);
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 2 });
    const plan = await wrapper.plan('g', ctx);
    const result = await wrapper.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(true);
    expect(inner.stepCalls).toBe(2);
    const synth = await wrapper.synthesize([], plan, ctx);
    expect(synth.retriesUsed).toBe(1);
  });

  it('exhausts retries and returns final wrapped failure', async () => {
    const inner = makeStubEngine({
      stepResults: [
      { stepIndex: 0, success: false, errorMessage: 'e1', durationMs: 1 },
      { stepIndex: 0, success: false, errorMessage: 'e2', durationMs: 1 },
      { stepIndex: 0, success: false, errorMessage: 'e3', durationMs: 1 }]

    });
    const llm = new FakeLlmClient({
      responses: [
      llmJson({ learnedContext: 'try this' }),
      llmJson({ learnedContext: 'try that' })]

    });
    const ctx = makeContext(llm);
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 2 });
    const plan = await wrapper.plan('g', ctx);
    const result = await wrapper.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('[ReflexionWrapper]');
    expect(result.errorMessage).toContain('Failed after 2 retries');
    expect(inner.stepCalls).toBe(3);
  });

  it('handles inner.step throwing as failure', async () => {
    const inner = makeStubEngine({ stepThrow: new Error('inner-blew-up') });
    const llm = new FakeLlmClient({
      responses: [llmJson({ learnedContext: 'guard for X' })]
    });
    const ctx = makeContext(llm);
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 1 });
    const plan = await wrapper.plan('g', ctx);
    const result = await wrapper.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Failed after 1 retries');
  });

  it('uses fallback learnedContext when reflection LLM fails', async () => {
    const inner = makeStubEngine({
      stepResults: [
      { stepIndex: 0, success: false, errorMessage: 'oops', durationMs: 1 },
      { stepIndex: 0, success: true, toolOutput: 'ok', durationMs: 1 }]

    });
    const llm = new FakeLlmClient({ responses: [new Error('reflexion-llm-down')] });
    const ctx = makeContext(llm);
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 1 });
    const plan = await wrapper.plan('g', ctx);
    const result = await wrapper.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(true);
    expect(inner.stepCalls).toBe(2);
  });

  it('synthesize() injects retriesUsed into inner response', async () => {
    const inner = makeStubEngine({
      stepResults: [
      { stepIndex: 0, success: false, errorMessage: 'fail', durationMs: 1 },
      { stepIndex: 0, success: true, toolOutput: 'ok', durationMs: 1 }],

      synthesize: {
        answer: 'final',
        observations: [],
        totalSteps: 1,
        strategy: 'react',
        escalated: false,
        retriesUsed: 999 // should be overwritten
      }
    });
    const llm = new FakeLlmClient({
      responses: [llmJson({ learnedContext: 'note' })]
    });
    const ctx = makeContext(llm);
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 2 });
    const plan = await wrapper.plan('g', ctx);
    await wrapper.step(plan, 0, [], ctx, async () => undefined);
    const synth = await wrapper.synthesize([] as Observation[], plan, ctx);
    expect(synth.answer).toBe('final');
    expect(synth.retriesUsed).toBe(1);
  });

  it('augments context with reflexionNotes across retries (no mutation of original)', async () => {
    let observedNotes: string[] | undefined;
    const inner: ReasoningEngine = {
      strategy: 'react',
      plan: async () => ({ goal: 'g', steps: [{ index: 0, description: 's' }], estimatedComplexity: 'low' }),
      step: async (_p, _i, _t, ctx) => {
        const extended = ctx as typeof ctx & {reflexionNotes?: string[];};
        if (extended.reflexionNotes && extended.reflexionNotes.length > 0) {
          observedNotes = extended.reflexionNotes;
          return { stepIndex: 0, success: true, toolOutput: 'recovered', durationMs: 1 };
        }
        return { stepIndex: 0, success: false, errorMessage: 'first-try-fail', toolOutput: {}, durationMs: 1 };
      },
      observe: async (r) => ({ stepIndex: 0, summary: 's', success: r.success, raw: r }),
      shouldContinue: async () => false,
      synthesize: async () => ({
        answer: '',
        observations: [],
        totalSteps: 0,
        strategy: 'react',
        escalated: false,
        retriesUsed: 0
      })
    };
    const llm = new FakeLlmClient({
      responses: [llmJson({ learnedContext: 'fix-me-up' })]
    });
    const ctx = makeContext(llm);
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 2 });
    const plan = await wrapper.plan('g', ctx);
    const result = await wrapper.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(true);
    expect(observedNotes).toEqual(['fix-me-up']);
    // Original context must not be mutated
    expect((ctx as typeof ctx & {reflexionNotes?: string[];}).reflexionNotes).toBeUndefined();
  });

  it("a-reasoning-01: retry through a REAL ReactEngine receives the reflexion note in its doctrine", async () => {
    const { ReactEngine } = await import("../../../src/reasoning/react.js");
    const inner = new ReactEngine();
    // 1) ReAct step #1 fails (executeTool throws) → step result success=false,
    //    toolOutput undefined.
    // 2) ReflexionWrapper derives a learnedContext. NB: when the failed step's
    //    `toolOutput` is undefined (the case for a thrown tool), the
    //    `_evaluateFailure` micro-call never reaches its LLM `complete` (the
    //    user-message builder short-circuits on the undefined output) and
    //    returns the deterministic error-derived FALLBACK lesson
    //    ("Step 0 failed: tool exploded"). That fallback IS a real reflexion
    //    note — what matters for a-reasoning-01 is that it flows through
    //    `augmentContext` into the RETRY's doctrine via the preamble, which is
    //    exactly the wiring this case proves end-to-end on a real ReactEngine.
    // 3) ReAct retry step succeeds (plain-text answer, no tool).
    const llm = new FakeLlmClient({
      responses: [
        llmJson({ thinking: "call tool", toolName: "boom", toolParams: {} }), // attempt 1 (tool throws)
        llmJson({ thinking: "recovered", text: "ok" }), // retry attempt
      ],
    });
    const ctx = makeContext(llm, { systemPrompt: "BASE" });
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 2 });
    const plan = await wrapper.plan("g", ctx);
    let calls = 0;
    const result = await wrapper.step(plan, 0, [], ctx, async () => {
      calls++;
      if (calls === 1) throw new Error("tool exploded");
      return { ok: true };
    });
    expect(result.success).toBe(true);
    // The retry ReAct call is the one whose `.system` is the ReAct prompt
    // (contains "autonomous agent") — NOT the failure-analyst micro-call.
    const reactCalls = llm.calls.filter((c) => c.system.includes("autonomous agent"));
    const retryCall = reactCalls[reactCalls.length - 1];
    // The retry doctrine carries the reflexion preamble + the derived lesson +
    // the original base doctrine — i.e. the note reached the retry.
    expect(retryCall.doctrine).toContain("Prior attempt(s) failed");
    expect(retryCall.doctrine).toContain("tool exploded");
    expect(retryCall.doctrine).toContain("BASE");
    // The first (failing) ReAct attempt had NO reflexion note → plain doctrine.
    expect(reactCalls[0].doctrine).toBe("BASE");
  });

  it("a-reasoning-01: success on first attempt → no _evaluateFailure micro-call", async () => {
    const { ReactEngine } = await import("../../../src/reasoning/react.js");
    const inner = new ReactEngine();
    const llm = new FakeLlmClient({
      responses: [llmJson({ thinking: "answer", text: "done" })],
    });
    const ctx = makeContext(llm, { systemPrompt: "BASE" });
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 2 });
    const plan = await wrapper.plan("g", ctx);
    const result = await wrapper.step(plan, 0, [], ctx, async () => ({ ok: true }));
    expect(result.success).toBe(true);
    // Exactly one LLM call (the ReAct step). No failure-analyst micro-call,
    // so no call carries a "failure analyst" system prompt.
    expect(llm.calls.some((c) => c.system.includes("failure analyst"))).toBe(false);
    expect(llm.calls).toHaveLength(1);
  });
});