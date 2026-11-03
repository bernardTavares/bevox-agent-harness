/**
 * Reasoning engines must remain bit-for-bit compatible when `streamCallback`
 * is undefined, and emit reasoning_step events when defined.
 */
import { describe, expect, it, vi } from "vitest";

import type {
  AgentExecutionContext,
  LlmCompletionResponse,
} from "../../../../../src/agents/execution-context.js";
import { ReactEngine } from "../../../../../src/reasoning/react.js";

function makeContext(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    executionId: "ex-1",
    accountId: 1,
    conversationKey: "c-1",
    db: {} as unknown as AgentExecutionContext["db"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
      }),
    } as unknown as AgentExecutionContext["logger"],
    llmClient: {
      complete: vi.fn(
        async (): Promise<LlmCompletionResponse> => ({
          content: JSON.stringify({ thinking: "thinking...", text: "done" }),
          model: "test",
        }),
      ),
    },
    accountConfig: { llmModel: "gpt-4o-mini", llmProvider: "openai" },
    messages: [],
    ...overrides,
  };
}

describe("Reasoning engines streaming hook", () => {
  it("ReactEngine.step does not call streamCallback when undefined (baseline)", async () => {
    const engine = new ReactEngine();
    const ctx = makeContext();
    const plan = await engine.plan("goal", ctx);
    const exec = vi.fn(async () => ({ success: true }));
    const result = await engine.step(plan, 0, [], ctx, exec);
    expect(result.success).toBe(true);
  });

  it("ReactEngine.step emits reasoning_step when streamCallback defined", async () => {
    const engine = new ReactEngine();
    const calls: Array<{ type: string; payload: unknown }> = [];
    const ctx = makeContext({
      streamCallback: async (e) => {
        calls.push(e);
      },
    });
    const plan = await engine.plan("goal", ctx);
    const exec = vi.fn(async () => ({ success: true }));
    await engine.step(plan, 0, [], ctx, exec);
    expect(calls.some((c) => c.type === "reasoning_step")).toBe(true);
  });

  it("streamCallback throwing does NOT break the step", async () => {
    const engine = new ReactEngine();
    const ctx = makeContext({
      streamCallback: async () => {
        throw new Error("boom");
      },
    });
    const plan = await engine.plan("goal", ctx);
    const exec = vi.fn(async () => ({ success: true }));
    const result = await engine.step(plan, 0, [], ctx, exec);
    expect(result.success).toBe(true);
  });
});
