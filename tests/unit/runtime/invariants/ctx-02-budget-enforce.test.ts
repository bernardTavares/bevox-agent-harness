/**
 * CTX-02 — Budget enforcement invariant: trim-before-surface.
 *
 * The runtime invariant under test (audit ref: runtime-gap-audit-2026-06-02
 * §ALTO / CTX-02): the (systemPrompt + permittedTools) pair must pass through
 * `enforceBudget()` BEFORE the surface-agent reasoning loop runs, and the
 * trimmed `systemPrompt` returned by the enforcer must be the one that
 * actually reaches the engine via `agentContext.systemPrompt`.
 *
 * NOTE on scope: the production enforcer (see `src/context/budget-enforcer.ts`)
 * only trims the system prompt — tools are counted toward the budget but
 * never trimmed by design (POC scope, audit explicitly defers tool-side
 * compression). The plan-sketch language "trimmed tools reach the surface
 * engine" therefore maps in practice to "the trimmed systemPrompt reaches
 * the surface engine via agentContext.systemPrompt". Verifying the
 * propagation of the trimmed value is the load-bearing assertion; the
 * "tools array" arg to enforceBudget is verified in the first `it`.
 *
 * Regression guard, not bug-discovery: behavior is currently correct
 * (execution-handler.ts ~1688 calls enforceBudget, then assigns
 * `agentContext.systemPrompt = enforced.systemPrompt` at ~1729 BEFORE the
 * surface loop at ~1917). This test pins the order so a future refactor
 * that defers enforcement (or forgets the assign) trips the build.
 *
 * Mechanism: partial `vi.mock` of `budget-enforcer` (preserves other exports
 * — the in-handler usage only needs `enforceBudget`) so we can assert on
 * args and force a sentinel return that we then look for at the engine seam.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import { createFakeRedis } from "../../../fakes/redis.fake.js";
import { FakeLLMGateway } from "../../../fakes/llm-gateway.fake.js";
import {
  StubMessageAnalyzer,
  StubSurfaceAgent,
  freshRegistries,
  basePayload,
} from "../../../helpers/invariant-harness.js";

// Hoisted mocks — same conventions as execution-handler.flow.test.ts.
// NOTE on extraction: vitest forbids exporting `vi.hoisted` values from a
// helper module AND hoists `vi.hoisted` blocks above top-level imports, so
// these three mocks cannot live in `invariant-harness.ts`. The stub agents,
// fresh-registries, and basePayload helpers ARE extracted there.
const callbackMock = vi.hoisted(() => ({
  updateStatus: vi.fn().mockResolvedValue(undefined),
  sendComplete: vi.fn().mockResolvedValue(undefined),
  sendTrace: vi.fn().mockResolvedValue(undefined),
  sendStream: vi.fn().mockResolvedValue(undefined),
  buildCompletePayload: (opts: {
    responseText: string;
    sentiment?: string;
    strategy?: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
    proposals?: unknown[];
  }) => ({
    response_text: opts.responseText,
    sentiment: opts.sentiment ?? "neutral",
    strategy: opts.strategy ?? "direct",
    usage: opts.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
    ...(opts.proposals && opts.proposals.length > 0 ? { proposals: opts.proposals } : {}),
  }),
}));

const gatewayMock = vi.hoisted(() => ({
  createLLMGateway: vi.fn(),
}));

const routerMock = vi.hoisted(() => ({
  strategyRouter: { build: vi.fn() },
}));

// CTX-02: hoisted enforcer mock. The handler imports a single named export
// (`enforceBudget`) from `../context/budget-enforcer.js` — preserving the
// other exports via `importActual` keeps unrelated callers (e.g. estimators
// used elsewhere in the tree) on their real implementation.
const TRIMMED_PROMPT_SENTINEL = "TRIMMED_BY_ENFORCE_BUDGET_MOCK";
const enforceBudgetMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/integration/bevox-callback", () => callbackMock);
vi.mock("../../../../src/integration/llm-gateway", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../src/integration/llm-gateway")
  >("../../../../src/integration/llm-gateway");
  return {
    ...actual,
    createLLMGateway: gatewayMock.createLLMGateway,
  };
});
vi.mock("../../../../src/reasoning/strategy-router", () => ({
  strategyRouter: routerMock.strategyRouter,
}));
vi.mock("../../../../src/context/budget-enforcer", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../src/context/budget-enforcer")
  >("../../../../src/context/budget-enforcer");
  return { ...actual, enforceBudget: enforceBudgetMock };
});

import {
  handleExecution,
  type ExecutionContext,
} from "../../../../src/runtime/execution-handler.js";
import { AgentRegistry } from "../../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../../../src/runtime/agent-router.js";
import type { AgentExecutionContext } from "../../../../src/agents/execution-context.js";

describe("CTX-02 budget-enforce invariant — trim before surface loop", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;
  let gateway: FakeLLMGateway;
  // Captured `agentContext.systemPrompt` at the moment `engine.step` runs —
  // this is the value the surface engine actually reasons with. If the
  // handler ever stops propagating the enforcer's output, this differs from
  // the sentinel and the second `it` trips.
  let observedStepSystemPrompt: string | undefined;

  beforeEach(async () => {
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    gatewayMock.createLLMGateway.mockReset();
    enforceBudgetMock.mockReset();
    observedStepSystemPrompt = undefined;

    // Default enforcer behavior: pretend we trimmed the prompt to a sentinel
    // string we can later look for at the engine seam. originalTokens >
    // finalTokens + wasCompressed=true so the handler's logger.info branch
    // exercises (not load-bearing for the assertion, just realistic).
    enforceBudgetMock.mockImplementation(
      (_input: { systemPrompt: string; tools: unknown[] }) => ({
        systemPrompt: TRIMMED_PROMPT_SENTINEL,
        originalTokens: 10_000,
        finalTokens: 1_000,
        budgetTokens: 8_000,
        wasCompressed: true,
      }),
    );

    gateway = new FakeLLMGateway({
      defaultResponse: {
        content: "ok",
        tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        model: "fake-model",
        provider: "fake",
        latency_ms: 1,
      },
    });
    gatewayMock.createLLMGateway.mockReturnValue(gateway);

    // Mock engine: `step` captures `agentContext.systemPrompt` so the second
    // `it` can assert the trimmed value propagated. One step then stop.
    routerMock.strategyRouter.build.mockReset();
    routerMock.strategyRouter.build.mockImplementation(() => {
      let stepped = false;
      return {
        strategy: "direct" as const,
        async plan() {
          return { goal: "g", steps: [], estimatedComplexity: "low" as const };
        },
        async step(
          _plan: unknown,
          _idx: number,
          _tools: unknown,
          context: AgentExecutionContext,
        ) {
          stepped = true;
          observedStepSystemPrompt = context.systemPrompt;
          return { stepIndex: 0, success: true, durationMs: 1 };
        },
        async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
          return { stepIndex: 0, summary: "ok", success: true, raw: sr, stopSignal: true };
        },
        async shouldContinue() {
          return !stepped;
        },
        async synthesize() {
          return {
            answer: "done",
            observations: [],
            totalSteps: 1,
            strategy: "direct" as const,
            escalated: false,
            retriesUsed: 0,
          };
        },
      };
    });

    redis = createFakeRedis();
    await redis.flushall();
    db = { query: vi.fn(), connect: vi.fn() } as unknown as Pool;

    const r = freshRegistries();
    agentRegistry = r.agentRegistry;
    toolRegistry = r.toolRegistry;
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
  });

  function ctx(): ExecutionContext {
    return {
      db,
      redis,
      agentRegistry,
      toolRegistry,
      agentRouter: createAgentRouter(),
    };
  }

  it("enforceBudget is called with systemPrompt and tools array", async () => {
    await handleExecution(basePayload(), ctx());

    // The handler MUST have called enforceBudget at least once on the surface
    // path. (There's a separate Model-C call site at ~463 that this test does
    // NOT exercise — sdr_profile is absent in basePayload, so the only call
    // is the ReAct/surface one at ~1688.)
    expect(enforceBudgetMock).toHaveBeenCalled();

    // The FIRST argument is an EnforceBudgetInput. Pin the two load-bearing
    // shape invariants: `systemPrompt` is a string, `tools` is an array.
    // Anything else (budget value, exact prompt content) is incidental.
    const firstCall = enforceBudgetMock.mock.calls[0]?.[0] as {
      systemPrompt: unknown;
      tools: unknown;
    };
    expect(firstCall).toBeDefined();
    expect(typeof firstCall.systemPrompt).toBe("string");
    expect(Array.isArray(firstCall.tools)).toBe(true);
  });

  it("trimmed systemPrompt reaches the surface engine via agentContext", async () => {
    await handleExecution(basePayload(), ctx());

    // The handler ran the surface loop (engine.step fired) AFTER it called
    // enforceBudget — so the prompt the engine reasoned with must equal the
    // sentinel the mock returned. If a future refactor skips the assignment
    // at ~1729, or moves enforceBudget to AFTER the loop, this fails.
    expect(enforceBudgetMock).toHaveBeenCalled();
    expect(observedStepSystemPrompt).toBe(TRIMMED_PROMPT_SENTINEL);
  });
});
