import { describe, it, expect, vi } from "vitest";

import { runSurfaceAgentLoop } from "../../../src/runtime/execution-handler.js";
import type { AgentDefinition } from "../../../src/agents/types.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { ToolExecutor } from "../../../src/reasoning/engine.js";
import { ReflexionWrapper } from "../../../src/reasoning/reflexion.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";

function makeLoopContext(
  llm: FakeLlmClient,
  extra: Partial<AgentExecutionContext> = {},
): AgentExecutionContext {
  return {
    executionId: "exec-loop-1",
    organizationId: "org-loop-1",
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

// Scheduler-like agent: React default + onFailure:reflexion. The router wraps
// the engine in a ReflexionWrapper at build time (escalation.onFailure ===
// "reflexion"), so the loop ALREADY starts wrapped.
const reflexionAgent: AgentDefinition = {
  name: "loop-test-react",
  type: "surface",
  description: "react + reflexion",
  reasoning: {
    default: "react",
    escalation: {
      stepThreshold: 99,
      escalateTo: "plan-execute",
      parallelThreshold: 99,
      onFailure: "reflexion",
    },
  },
  permissions: { required: [], denied: [] },
};

const noop: ToolExecutor = async () => ({ ok: true });

describe("runSurfaceAgentLoop — SurfaceLoopResult (R02)", () => {
  it("non-escalated run returns escalated=false and chain=[engine.strategy]", async () => {
    // ReAct returns a plain-text answer on step 0 → loop ends without failure.
    const llm = new FakeLlmClient({
      responses: [{ content: JSON.stringify({ thinking: "t", text: "done" }), model: "m", promptTokens: 1, completionTokens: 1 }],
    });
    const result = await runSurfaceAgentLoop(reflexionAgent, "goal", makeLoopContext(llm), [], noop);
    expect(result.observations.length).toBeGreaterThanOrEqual(1);
    expect(result.escalated).toBe(false);
    expect(result.escalationChain).toEqual(["react"]);
    expect(result.engine.strategy).toBe("react");
  });

  it("wrap-reflexion: emits engine_strategy + pushes 'reflexion' to chain EVEN when already wrapped", async () => {
    // The ReAct step always requests a tool, and the tool always throws, so the
    // already-wrapped ReflexionWrapper exhausts its retries → step 0 surfaces
    // success=false → Rule 1 fires wrap-reflexion. The engine is ALREADY a
    // ReflexionWrapper (router wrapped it via onFailure:'reflexion'), so the
    // guard must NOT re-wrap, but the telemetry/chain MUST still fire.
    const llm = new FakeLlmClient({
      // Every ReAct turn requests the failing tool (incl. wrapper retries).
      defaultResponse: { content: JSON.stringify({ toolName: "boom", toolParams: {} }), model: "m", promptTokens: 1, completionTokens: 1 },
    });
    const events: Array<{ type: string; payload: unknown }> = [];
    const ctx = makeLoopContext(llm, {
      streamCallback: async (e) => {
        events.push(e);
      },
    });
    // Tool always throws → ReflexionWrapper retries are all failures → exhausts.
    const throwingTool: ToolExecutor = async () => {
      throw new Error("tool boom");
    };
    const result = await runSurfaceAgentLoop(reflexionAgent, "goal", ctx, [], throwingTool);
    // chain includes the reflexion marker exactly once (deduped)
    expect(result.escalationChain).toContain("reflexion");
    expect(result.escalationChain.filter((s) => s === "reflexion")).toHaveLength(1);
    expect(result.escalated).toBe(true);
    // engine_strategy event fired for the reflexion transition
    const strat = events.filter((e) => e.type === "engine_strategy");
    expect(strat.some((e) => (e.payload as { to?: string }).to === "reflexion")).toBe(true);
    // No multiplicative nesting: final engine is a SINGLE ReflexionWrapper,
    // whose inner is NOT itself a ReflexionWrapper.
    expect(result.engine).toBeInstanceOf(ReflexionWrapper);
    expect((result.engine as unknown as { inner: unknown }).inner).not.toBeInstanceOf(
      ReflexionWrapper,
    );
  });
});
