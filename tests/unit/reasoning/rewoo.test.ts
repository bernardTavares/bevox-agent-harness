import { describe, it, expect } from 'vitest';
import { ReWOOEngine, CyclicDependencyError } from "../../../src/reasoning/rewoo.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import { makeContext, llmJson, llmText } from "./_helpers.js";
import type { Observation, Plan } from "../../../src/reasoning/engine.js";

describe('ReWOOEngine', () => {
  it('plan() builds a dependency-annotated plan', async () => {
    const llm = new FakeLlmClient({
      responses: [
      llmJson({
        steps: [
        { index: 0, description: 'A', dependsOn: [] },
        { index: 1, description: 'B', dependsOn: [] },
        { index: 2, description: 'C', dependsOn: [0, 1] }]

      })]

    });
    const engine = new ReWOOEngine();
    const plan = await engine.plan('parallel-goal', makeContext(llm));
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[2].dependsOn).toEqual([0, 1]);
    expect(plan.estimatedComplexity).toBe('high');
  });

  it('plan() normalises missing dependsOn to empty array', async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ steps: [{ index: 0, description: 'X' }] })]
    });
    const engine = new ReWOOEngine();
    const plan = await engine.plan('g', makeContext(llm));
    expect(plan.steps[0].dependsOn).toEqual([]);
  });

  it('plan() returns fallback when LLM returns non-JSON', async () => {
    const llm = new FakeLlmClient({ responses: [llmText('not-json')] });
    const engine = new ReWOOEngine();
    const plan = await engine.plan('g', makeContext(llm));
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toBe('execute-goal-directly');
  });

  it('plan() returns fallback when steps array is empty', async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ steps: [] })] });
    const engine = new ReWOOEngine();
    const plan = await engine.plan('g', makeContext(llm));
    expect(plan.steps[0].description).toBe('execute-goal-directly');
  });

  it('plan() throws CyclicDependencyError when cycle detected', async () => {
    const llm = new FakeLlmClient({
      responses: [
      llmJson({
        steps: [
        { index: 0, description: 'A', dependsOn: [1] },
        { index: 1, description: 'B', dependsOn: [0] }]

      })]

    });
    const engine = new ReWOOEngine();
    await expect(engine.plan('g', makeContext(llm))).rejects.toBeInstanceOf(CyclicDependencyError);
  });

  it('step() executes a tool call', async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ toolName: 'fetch', toolParams: { id: 1 } })]
    });
    const engine = new ReWOOEngine();
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: 'g',
      steps: [{ index: 0, description: 'do', dependsOn: [] }],
      estimatedComplexity: 'medium'
    };
    const result = await engine.step(plan, 0, [], ctx, async () => ({ data: 'x' }));
    expect(result.success).toBe(true);
    expect(result.toolName).toBe('fetch');
    expect(result.toolOutput).toEqual({ data: 'x' });
  });

  it('step() returns failure for missing step index', async () => {
    const engine = new ReWOOEngine();
    const plan: Plan = { goal: 'g', steps: [], estimatedComplexity: 'low' };
    const result = await engine.step(plan, 99, [], makeContext(), async () => undefined);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('not found');
  });

  it('step() handles plain-text response', async () => {
    const llm = new FakeLlmClient({ responses: [llmJson({ text: 'answer' })] });
    const engine = new ReWOOEngine();
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: 'g',
      steps: [{ index: 0, description: 'd', dependsOn: [] }],
      estimatedComplexity: 'low'
    };
    const result = await engine.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(true);
    expect(result.toolOutput).toEqual({ text: 'answer' });
  });

  it('step() captures LLM error', async () => {
    const llm = new FakeLlmClient({ responses: [new Error('llm fail')] });
    const engine = new ReWOOEngine();
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: 'g',
      steps: [{ index: 0, description: 'd', dependsOn: [] }],
      estimatedComplexity: 'low'
    };
    const result = await engine.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('llm fail');
  });

  it('observe() flags stopSignal for request-human tool', async () => {
    const engine = new ReWOOEngine();
    const obs = await engine.observe(
      { stepIndex: 0, success: true, toolName: 'request-human', toolOutput: { handed: true }, durationMs: 1 },
      makeContext()
    );
    expect(obs.stopSignal).toBe(true);
  });

  it('observe() summarises error step', async () => {
    const engine = new ReWOOEngine();
    const obs = await engine.observe(
      { stepIndex: 0, success: false, errorMessage: 'oops', durationMs: 1 },
      makeContext()
    );
    expect(obs.summary).toBe('[Error] oops');
    expect(obs.stopSignal).toBe(false);
  });

  it('shouldContinue() returns false if any observation has stopSignal', async () => {
    const engine = new ReWOOEngine();
    const plan: Plan = { goal: 'g', steps: [], estimatedComplexity: 'low' };
    const obs: Observation[] = [
    {
      stepIndex: 0,
      summary: '',
      success: true,
      raw: { stepIndex: 0, success: true, toolName: 'send-message', durationMs: 1 },
      stopSignal: true
    }];

    expect(await engine.shouldContinue(obs, plan, makeContext())).toBe(false);
  });

  it('shouldContinue() returns true when no stopSignal present', async () => {
    const engine = new ReWOOEngine();
    const plan: Plan = { goal: 'g', steps: [], estimatedComplexity: 'low' };
    expect(await engine.shouldContinue([], plan, makeContext())).toBe(true);
  });

  it('synthesize() returns last successful summary with rewoo strategy', async () => {
    const engine = new ReWOOEngine();
    const plan: Plan = { goal: 'g', steps: [], estimatedComplexity: 'low' };
    const obs: Observation[] = [
    { stepIndex: 0, summary: 'a', success: true, raw: { stepIndex: 0, success: true, durationMs: 1 } },
    { stepIndex: 1, summary: 'b', success: true, raw: { stepIndex: 1, success: true, durationMs: 1 } }];

    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.strategy).toBe('rewoo');
    expect(resp.answer).toBe('b');
    expect(resp.totalSteps).toBe(2);
  });

  it('executeWaves() runs independent steps in parallel waves and respects dependencies', async () => {
    // Plan: 0 and 1 are independent; 2 depends on [0,1]
    const llm = new FakeLlmClient({
      responses: [
      llmJson({ toolName: 't0' }),
      llmJson({ toolName: 't1' }),
      llmJson({ toolName: 't2' })]

    });
    const engine = new ReWOOEngine({ maxParallel: 5 });
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: 'parallel',
      steps: [
      { index: 0, description: 'A', dependsOn: [] },
      { index: 1, description: 'B', dependsOn: [] },
      { index: 2, description: 'C', dependsOn: [0, 1] }],

      estimatedComplexity: 'high'
    };
    const callOrder: string[] = [];
    const observations = await engine.executeWaves(plan, [], ctx, async (name) => {
      callOrder.push(name);
      return { ok: name };
    });
    expect(observations).toHaveLength(3);
    expect(callOrder).toContain('t0');
    expect(callOrder).toContain('t1');
    expect(callOrder).toContain('t2');
    // Wave 2 (t2) must be after wave 1 (t0, t1)
    expect(callOrder.indexOf('t2')).toBeGreaterThan(callOrder.indexOf('t0'));
    expect(callOrder.indexOf('t2')).toBeGreaterThan(callOrder.indexOf('t1'));
  });

  it('executeWaves() chunks parallel execution by maxParallel', async () => {
    const llm = new FakeLlmClient({
      responses: [
      llmJson({ toolName: 't0' }),
      llmJson({ toolName: 't1' }),
      llmJson({ toolName: 't2' })]

    });
    const engine = new ReWOOEngine({ maxParallel: 1 });
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: 'g',
      steps: [
      { index: 0, description: 'A', dependsOn: [] },
      { index: 1, description: 'B', dependsOn: [] },
      { index: 2, description: 'C', dependsOn: [] }],

      estimatedComplexity: 'high'
    };
    const observations = await engine.executeWaves(plan, [], ctx, async () => ({ ok: 1 }));
    expect(observations).toHaveLength(3);
  });

  it('executeWaves() halts after a stopSignal wave', async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ toolName: 'send-message', toolParams: {} })]
    });
    const engine = new ReWOOEngine();
    const ctx = makeContext(llm);
    const plan: Plan = {
      goal: 'g',
      steps: [
      { index: 0, description: 'stop-step', dependsOn: [] },
      { index: 1, description: 'never-runs', dependsOn: [0] }],

      estimatedComplexity: 'high'
    };
    const observations = await engine.executeWaves(plan, [], ctx, async () => ({ sent: true }));
    expect(observations).toHaveLength(1);
    expect(observations[0].stopSignal).toBe(true);
  });
});