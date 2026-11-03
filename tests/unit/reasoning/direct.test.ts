import { describe, it, expect } from 'vitest';
import { DirectEngine } from "../../../src/reasoning/direct.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";

function makeContext(llm: FakeLlmClient): AgentExecutionContext {
  return {
    executionId: 'exec-1',
    accountId: 1,
    conversationKey: 'conv-1',
    db: {} as never,
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
    llmClient: llm,
    accountConfig: { llmModel: 'fake-model' }
  };
}

describe('DirectEngine', () => {
  it('plan() returns a single-step plan with the input as goal', async () => {
    const engine = new DirectEngine();
    const plan = await engine.plan('classify this message', makeContext(new FakeLlmClient()));
    expect(plan.goal).toBe('classify this message');
    expect(plan.steps).toHaveLength(1);
    expect(plan.estimatedComplexity).toBe('low');
  });

  it('step() invokes the LLM exactly once and parses JSON output', async () => {
    const llm = new FakeLlmClient({
      defaultResponse: { content: '{"intent":"scheduling"}', model: 'fake' }
    });
    const ctx = makeContext(llm);
    const engine = new DirectEngine();
    const plan = await engine.plan('hello', ctx);
    const result = await engine.step(plan, 0, [], ctx, async () => undefined);
    expect(llm.calls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.toolOutput).toEqual({ intent: 'scheduling' });
  });

  it('step() falls back to raw string when LLM returns non-JSON content', async () => {
    const llm = new FakeLlmClient({
      defaultResponse: { content: 'plain text', model: 'fake' }
    });
    const ctx = makeContext(llm);
    const engine = new DirectEngine();
    const plan = await engine.plan('hello', ctx);
    const result = await engine.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(true);
    expect(result.toolOutput).toBe('plain text');
  });

  it('step() captures error when LLM throws', async () => {
    const llm = new FakeLlmClient({ responses: [new Error('llm down')] });
    const ctx = makeContext(llm);
    const engine = new DirectEngine();
    const plan = await engine.plan('hello', ctx);
    const result = await engine.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('llm down');
  });

  it('shouldContinue() always returns false (DirectEngine is single-shot)', async () => {
    const engine = new DirectEngine();
    const ctx = makeContext(new FakeLlmClient());
    const plan = await engine.plan('hello', ctx);
    const result = await engine.shouldContinue([], plan, ctx);
    expect(result).toBe(false);
  });

  it('synthesize() returns the first observation summary as answer', async () => {
    const engine = new DirectEngine();
    const ctx = makeContext(new FakeLlmClient());
    const plan = await engine.plan('hello', ctx);
    const response = await engine.synthesize(
      [
      {
        stepIndex: 0,
        summary: '{"answer":"yes"}',
        success: true,
        raw: { stepIndex: 0, success: true, durationMs: 1 }
      }],

      plan,
      ctx
    );
    expect(response.strategy).toBe('direct');
    expect(response.answer).toBe('{"answer":"yes"}');
    expect(response.totalSteps).toBe(1);
    expect(response.escalated).toBe(false);
  });
});