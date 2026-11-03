import { describe, it, expect } from 'vitest';
import { ReactEngine } from "../../../src/reasoning/react.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import { makeContext, llmJson, llmText } from "./_helpers.js";
import type { Observation, StepResult } from "../../../src/reasoning/engine.js";

describe('ReactEngine', () => {
  it('plan() returns a single-step "react-loop" plan', async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan('book a meeting', makeContext());
    expect(plan.goal).toBe('book a meeting');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toBe('react-loop');
    expect(plan.estimatedComplexity).toBe('low');
  });

  it('step() parses tool action and invokes executeTool', async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ thinking: 'need calendar', toolName: 'list-appointments', toolParams: { day: 'today' } })]
    });
    const ctx = makeContext(llm);
    const engine = new ReactEngine();
    const plan = await engine.plan('goal', ctx);
    const calls: Array<{name: string;params: unknown;}> = [];
    const result = await engine.step(plan, 0, [], ctx, async (name, params) => {
      calls.push({ name, params });
      return { ok: true };
    });
    expect(result.success).toBe(true);
    expect(result.toolName).toBe('list-appointments');
    expect(result.toolParams).toEqual({ day: 'today' });
    expect(result.toolOutput).toEqual({ ok: true });
    expect(result.thinkingTrace).toBe('need calendar');
    expect(calls).toHaveLength(1);
  });

  it('step() treats LLM text response as final answer (no tool call)', async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ thinking: 'done', text: 'final answer' })]
    });
    const ctx = makeContext(llm);
    const engine = new ReactEngine();
    const plan = await engine.plan('goal', ctx);
    const result = await engine.step(plan, 0, [], ctx, async () => 'unused');
    expect(result.success).toBe(true);
    expect(result.toolName).toBeUndefined();
    expect(result.toolOutput).toEqual({ text: 'final answer' });
  });

  it('step() falls back to plain text when LLM content is non-JSON', async () => {
    const llm = new FakeLlmClient({ responses: [llmText('not json content')] });
    const ctx = makeContext(llm);
    const engine = new ReactEngine();
    const plan = await engine.plan('goal', ctx);
    const result = await engine.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(true);
    expect(result.toolOutput).toEqual({ text: 'not json content' });
  });

  it('step() captures error when executeTool throws', async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ toolName: 'broken', toolParams: {} })]
    });
    const ctx = makeContext(llm);
    const engine = new ReactEngine();
    const plan = await engine.plan('goal', ctx);
    const result = await engine.step(plan, 0, [], ctx, async () => {
      throw new Error('tool failed');
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('tool failed');
  });

  it('step() captures error when LLM throws', async () => {
    const llm = new FakeLlmClient({ responses: [new Error('llm down')] });
    const ctx = makeContext(llm);
    const engine = new ReactEngine();
    const plan = await engine.plan('goal', ctx);
    const result = await engine.step(plan, 0, [], ctx, async () => undefined);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('llm down');
  });

  it('step() invokes traceCallback when provided', async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ toolName: 'send-message', toolParams: { text: 'hi' } })]
    });
    const ctx = makeContext(llm);
    const engine = new ReactEngine();
    const plan = await engine.plan('goal', ctx);
    const events: unknown[] = [];
    await engine.step(plan, 0, [], ctx, async () => ({ sent: true }), (ev) => events.push(ev));
    expect(events).toHaveLength(1);
  });

  it('observe() flags stopSignal for send-message tool', async () => {
    const engine = new ReactEngine();
    const result: StepResult = {
      stepIndex: 0,
      success: true,
      toolName: 'send-message',
      toolOutput: { sent: true },
      durationMs: 1
    };
    const obs = await engine.observe(result, makeContext());
    expect(obs.stopSignal).toBe(true);
    expect(obs.summary).toBe('{"sent":true}');
  });

  it('observe() summarises error with [Error] prefix', async () => {
    const engine = new ReactEngine();
    const obs = await engine.observe(
      { stepIndex: 0, success: false, errorMessage: 'boom', durationMs: 1 },
      makeContext()
    );
    expect(obs.summary).toBe('[Error] boom');
    expect(obs.stopSignal).toBe(false);
  });

  it('shouldContinue() returns true on empty observations', async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan('g', makeContext());
    expect(await engine.shouldContinue([], plan, makeContext())).toBe(true);
  });

  it('shouldContinue() stops on stopSignal', async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan('g', makeContext());
    const obs: Observation = {
      stepIndex: 0,
      summary: 'sent',
      success: true,
      raw: { stepIndex: 0, success: true, toolName: 'send-message', durationMs: 1 },
      stopSignal: true
    };
    expect(await engine.shouldContinue([obs], plan, makeContext())).toBe(false);
  });

  it('shouldContinue() stops when maxSteps reached', async () => {
    const engine = new ReactEngine({ maxSteps: 2 });
    const plan = await engine.plan('g', makeContext());
    const mk = (i: number): Observation => ({
      stepIndex: i,
      summary: 'ok',
      success: true,
      raw: { stepIndex: i, success: true, toolName: 'some-tool', durationMs: 1 },
      stopSignal: false
    });
    expect(await engine.shouldContinue([mk(0), mk(1)], plan, makeContext())).toBe(false);
  });

  it('shouldContinue() stops when last step had no tool call', async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan('g', makeContext());
    const obs: Observation = {
      stepIndex: 0,
      summary: 'text',
      success: true,
      raw: { stepIndex: 0, success: true, durationMs: 1 },
      stopSignal: false
    };
    expect(await engine.shouldContinue([obs], plan, makeContext())).toBe(false);
  });

  it('synthesize() prefers stopSignal observation, falls back to last successful', async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan('g', makeContext());
    const obs: Observation[] = [
    { stepIndex: 0, summary: 'a', success: true, raw: { stepIndex: 0, success: true, durationMs: 1 } },
    { stepIndex: 1, summary: 'STOP', success: true, raw: { stepIndex: 1, success: true, durationMs: 1 }, stopSignal: true },
    { stepIndex: 2, summary: 'after', success: true, raw: { stepIndex: 2, success: true, durationMs: 1 } }];

    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe('STOP');
    expect(resp.strategy).toBe('react');
    expect(resp.totalSteps).toBe(3);
    expect(resp.escalated).toBe(false);
  });

  it('synthesize() returns empty string when observations are empty', async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan('g', makeContext());
    const resp = await engine.synthesize([], plan, makeContext());
    expect(resp.answer).toBe('');
  });

  it('makeContext sets systemPrompt when provided', () => {
    const ctx = makeContext(undefined, { systemPrompt: "S" });
    expect(ctx.systemPrompt).toBe("S");
  });

  it('stopTools config can be customised', async () => {
    const engine = new ReactEngine({ stopTools: ['custom-stop'] });
    const result: StepResult = {
      stepIndex: 0,
      success: true,
      toolName: 'custom-stop',
      toolOutput: 'x',
      durationMs: 1
    };
    const obs = await engine.observe(result, makeContext());
    expect(obs.stopSignal).toBe(true);
  });

  it("synthesize() reads response_text from data.message (real wrapped ToolResult, autonomous)", async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan("g", makeContext());
    const obs: Observation[] = [
      {
        stepIndex: 0,
        summary: '{"success":true,"data":{"sent":true,"message":"olá cliente"}}',
        success: true,
        raw: {
          stepIndex: 0,
          success: true,
          toolName: "send-message",
          toolOutput: { success: true, data: { sent: true, message: "olá cliente" } },
          durationMs: 1,
        },
        stopSignal: true,
      },
    ];
    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe("olá cliente");
  });

  it("synthesize() reads response_text from data.proposal.params.message (draft send-message)", async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan("g", makeContext());
    const obs: Observation[] = [
      {
        stepIndex: 0,
        summary: "envelope",
        success: true,
        raw: {
          stepIndex: 0,
          success: true,
          toolName: "send-message",
          toolOutput: {
            success: true,
            data: { proposal: { action: "send-message", params: { message: "texto rascunhado" } } },
          },
          durationMs: 1,
        },
        stopSignal: true,
      },
    ];
    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe("texto rascunhado");
  });

  it("synthesize() returns empty string for request-human handoff (data.handoff)", async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan("g", makeContext());
    const obs: Observation[] = [
      {
        stepIndex: 0,
        summary: '{"success":true,"data":{"handoff":true}}',
        success: true,
        raw: {
          stepIndex: 0,
          success: true,
          toolName: "request-human",
          toolOutput: { success: true, data: { handoff: true } },
          durationMs: 1,
        },
        stopSignal: true,
      },
    ];
    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe("");
  });

  it("synthesize() tolerates legacy unwrapped shape (data.* absent → top-level message)", async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan("g", makeContext());
    const obs: Observation[] = [
      {
        stepIndex: 0,
        summary: "legacy",
        success: true,
        raw: {
          stepIndex: 0,
          success: true,
          toolName: "send-message",
          toolOutput: { message: "legacy unwrapped" },
          durationMs: 1,
        },
        stopSignal: true,
      },
    ];
    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe("legacy unwrapped");
  });

  it("step() prepends reflexionNotes to the doctrine (retry sees the lesson)", async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ thinking: "retrying", text: "done" })],
    });
    const engine = new ReactEngine();
    const ctx = {
      ...makeContext(llm, { systemPrompt: "BASE DOCTRINE" }),
      reflexionNotes: ["use param X"],
    };
    const plan = await engine.plan("goal", ctx);
    await engine.step(plan, 0, [], ctx, async () => ({ ok: true }));
    const call = llm.calls[0];
    expect(call.doctrine).toContain("use param X");
    expect(call.doctrine).toContain("BASE DOCTRINE");
    // The ReAct goal+tools prompt stays in `.system`, untouched by the note.
    expect(call.system).toContain("autonomous agent");
    expect(call.system).not.toContain("use param X");
  });

  it("step() with no reflexionNotes → doctrine is byte-identical to systemPrompt", async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ thinking: "t", text: "done" })],
    });
    const engine = new ReactEngine();
    const ctx = makeContext(llm, { systemPrompt: "BASE DOCTRINE" });
    const plan = await engine.plan("goal", ctx);
    await engine.step(plan, 0, [], ctx, async () => ({ ok: true }));
    expect(llm.calls[0].doctrine).toBe("BASE DOCTRINE");
  });
});