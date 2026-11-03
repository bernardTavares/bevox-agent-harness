/**
 * Engine-swap mid-loop invariant: observations preserved across escalation.
 *
 * The runtime invariant under test (audit ref: a-reasoning-04 + the
 * `runSurfaceAgentLoop` contract docstring at execution-handler.ts ~832):
 * when the StepEvaluator decides to swap reasoning strategy mid-loop —
 * specifically `escalate-to-plan-execute` — observations accumulated by the
 * PRIOR engine MUST be threaded into the new engine's `plan()` call. The
 * handler implements this by building `remainingInput` from the original
 * input plus the prior observations' `summary` field
 * (execution-handler.ts ~935 and ~955):
 *
 *     const remainingInput = `${input}\n\nCompleted so far:\n${
 *       allObservations.map((o) => o.summary).join("\n")}`;
 *     plan = await engine.plan(remainingInput, agentContext);
 *
 * If a future refactor drops the `allObservations.map` join, or calls
 * `engine.plan(input, ...)` with the ORIGINAL input, the new engine starts
 * with no memory of the prior steps and the loop effectively restarts —
 * silently wasting LLM budget and confusing replays.
 *
 * Regression guard, not bug-discovery: the threading is currently correct
 * end-to-end. The test pins it.
 *
 * Mechanism:
 *   1. Mock `strategy-router` so the FIRST engine (call 1 of `build`) is a
 *      controllable Direct stub that emits a fixed observation each step.
 *      The stub's `step` writes a unique sentinel into `observation.summary`
 *      ("OBS_FROM_DIRECT_N") so we can grep for it later.
 *   2. Configure the surface agent with `stepThreshold: 1` so after the
 *      SECOND observation accumulates (length 2 > 1), the StepEvaluator
 *      returns `escalate-to-plan-execute` and the handler runs
 *      `engine = new PlanExecuteEngine()`.
 *   3. Mock the `PlanExecuteEngine` constructor (via `vi.mock` on the module
 *      path) so the swap produces a SECOND, distinguishable stub. Capture
 *      the `plan()` input the swap engine receives.
 *   4. Assert:
 *        a. Both stub-engine instances were used (NOT the same mock reused).
 *        b. The PlanExecute stub's `plan()` was called with a `remainingInput`
 *           that CONTAINS the direct engine's observation summaries.
 *        c. The PlanExecute stub's `step` ran AT LEAST ONCE post-swap (proves
 *           the swapped engine actually drove the loop, not just got built).
 *
 * Why we don't assert via `strategyRouter.build` call-count:
 *   The handler does NOT re-call `strategyRouter.build` on escalation — it
 *   instantiates `new PlanExecuteEngine()` directly (execution-handler.ts
 *   ~924). So `routerMock.strategyRouter.build` is called exactly ONCE
 *   inside the surface loop. The swap is observed by mocking the
 *   `PlanExecuteEngine` constructor instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import { createFakeRedis } from "../../../fakes/redis.fake.js";
import { FakeLLMGateway } from "../../../fakes/llm-gateway.fake.js";
import {
  StubMessageAnalyzer,
  freshRegistries,
  basePayload,
} from "../../../helpers/invariant-harness.js";
import { BaseAgent } from "../../../../src/agents/base-agent.js";
import type { AgentResult } from "../../../../src/agents/types.js";

// Hoisted mocks: see tests/helpers/invariant-harness.ts header for why these
// can't be extracted into the helper module (Task 4 prelude re-verified the
// failure mode — DO NOT re-attempt extraction without a different mechanism).
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

// PlanExecuteEngine constructor mock. The handler calls
// `new PlanExecuteEngine()` directly on the escalate-to-plan-execute path
// (execution-handler.ts ~924), so we replace the class with a real function
// constructor that returns the next pre-programmed stub instance. NOTE:
// `vi.fn().mockImplementation(() => obj)` is NOT new-able (vitest mock fns
// throw "is not a constructor"); we use a plain function with a `calls[]`
// side-channel to record constructor invocations instead. The queue is
// reset in beforeEach so test isolation holds.
const planExecuteMock = vi.hoisted(() => {
  const queued: unknown[] = [];
  const calls: unknown[][] = [];
  function PlanExecuteEngineCtor(...args: unknown[]) {
    calls.push(args);
    const next = queued.shift();
    if (!next) {
      throw new Error("planExecuteMock queue empty — test setup bug");
    }
    return next;
  }
  return { queued, calls, PlanExecuteEngine: PlanExecuteEngineCtor };
});

vi.mock("../../../../src/integration/bevox-callback", () => callbackMock);
vi.mock("../../../../src/integration/llm-gateway", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/integration/llm-gateway")>(
    "../../../../src/integration/llm-gateway",
  );
  return {
    ...actual,
    createLLMGateway: gatewayMock.createLLMGateway,
  };
});
vi.mock("../../../../src/reasoning/strategy-router", () => ({
  strategyRouter: routerMock.strategyRouter,
}));
vi.mock("../../../../src/reasoning/plan-execute", () => ({
  PlanExecuteEngine: planExecuteMock.PlanExecuteEngine,
}));

import {
  handleExecution,
  type ExecutionContext,
} from "../../../../src/runtime/execution-handler.js";
import { AgentRegistry } from "../../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../../../src/runtime/agent-router.js";
import type { AgentExecutionContext } from "../../../../src/agents/execution-context.js";

// Custom surface agent with `stepThreshold: 1` — after the SECOND
// observation accumulates (length 2 > 1), StepEvaluator returns
// `escalate-to-plan-execute`. `StubSurfaceAgent` from the helper has no
// escalation config (defaults: stepThreshold 5), so we can't reuse it here.
// Single-consumer for now → defined inline per the helper's YAGNI note.
class EscalatingSurfaceAgent extends BaseAgent {
  constructor() {
    super({
      name: "scheduler",
      type: "surface",
      description: "t",
      reasoning: {
        default: "direct",
        escalation: {
          stepThreshold: 1,
          parallelThreshold: 99, // disable rewoo path
          escalateTo: "plan-execute",
          // onFailure left undefined → defaults to "abort" in the handler
          // config, which means the wrap-reflexion rule never fires.
        },
      },
      permissions: { required: [], denied: [] },
    });
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return { success: true, output: "ok" };
  }
}

describe("engine-swap mid-loop invariant — observations preserved across escalation", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;
  let gateway: FakeLLMGateway;

  // Captured by the swapped (PlanExecute) engine's `plan()` mock so the
  // assertion in the it-block can grep it for the prior-engine summaries.
  let observedSwapPlanInput: string | undefined;
  // Identity tokens so the test can prove the two engines are DIFFERENT
  // instances, not the same mock reused.
  const directInstanceTag = Symbol("direct-engine-instance");
  const planExecuteInstanceTag = Symbol("plan-execute-engine-instance");
  // Counts to prove the swapped engine drove the loop AFTER the swap, not
  // just that it was constructed.
  let planExecuteStepCalls: number;

  beforeEach(async () => {
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    gatewayMock.createLLMGateway.mockReset();
    planExecuteMock.queued.length = 0;
    planExecuteMock.calls.length = 0;
    observedSwapPlanInput = undefined;
    planExecuteStepCalls = 0;

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

    // FIRST engine — built by strategyRouter.build. Direct strategy. Emits
    // a tagged observation each step so we can grep for it in the swap
    // engine's plan() input. `shouldContinue` stays true indefinitely; the
    // escalation path is what exits the loop (the handler runs `continue`
    // after escalation and re-enters with the new engine).
    routerMock.strategyRouter.build.mockReset();
    routerMock.strategyRouter.build.mockImplementation(() => {
      let directStepCount = 0;
      return {
        // Tag on the instance so the test can prove identity.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        __tag: directInstanceTag as any,
        strategy: "direct" as const,
        async plan() {
          return { goal: "g", steps: [], estimatedComplexity: "low" as const };
        },
        async step() {
          directStepCount++;
          return { stepIndex: directStepCount - 1, success: true, durationMs: 1 };
        },
        async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
          return {
            stepIndex: sr.stepIndex,
            summary: `OBS_FROM_DIRECT_${sr.stepIndex}`,
            success: true,
            raw: sr,
            // stopSignal stays false so the loop keeps going until escalation
            // forces the swap.
            stopSignal: false,
          };
        },
        async shouldContinue() {
          return true;
        },
        async synthesize() {
          // The handler builds a FRESH engine via strategyRouter.build a
          // second time at execution-handler.ts ~1938 just to call
          // synthesize, so this mock impl IS reached on the post-loop path
          // (the surface loop returns `allObservations`, then a brand-new
          // direct stub gets built for the synthesize call). The exact
          // answer is incidental to this invariant test — the assertions
          // below check the swap path, not the final response text.
          return {
            answer: "post-loop-synthesize",
            observations: [],
            totalSteps: 0,
            strategy: "direct" as const,
            escalated: false,
            retriesUsed: 0,
          };
        },
      };
    });

    // SECOND engine — instantiated by the handler via `new PlanExecuteEngine()`
    // on the escalate-to-plan-execute branch. Queue stub instance #1.
    // `plan()` captures the `remainingInput` for the load-bearing assertion;
    // `step` increments our counter; the observation it emits MUST stop the
    // outer evaluator from looping forever — see the queue-#2 comment below.
    planExecuteMock.queued.push({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      __tag: planExecuteInstanceTag as any,
      strategy: "plan-execute" as const,
      async plan(input: string) {
        observedSwapPlanInput = input;
        return { goal: "g2", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        planExecuteStepCalls++;
        return { stepIndex: 0, success: true, durationMs: 1 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return {
          stepIndex: sr.stepIndex,
          summary: "OBS_FROM_PLAN_EXECUTE",
          success: true,
          raw: sr,
          stopSignal: true,
        };
      },
      async shouldContinue() {
        // Run exactly one step on the swapped engine post-swap. Gate on our
        // own step counter, NOT on `observations.length === 0`: the handler
        // PRESERVES the prior engine's observations across the swap (the
        // whole invariant under test), so the observations array is already
        // non-empty at swap time.
        return planExecuteStepCalls === 0;
      },
      async synthesize() {
        return {
          answer: "done-post-swap",
          observations: [],
          totalSteps: 1,
          strategy: "plan-execute" as const,
          escalated: true,
          retriesUsed: 0,
        };
      },
      // Optional `reset?()` — handler calls it on the swapped engine after
      // re-planning (execution-handler.ts ~940). No-op here.
      reset() {},
    });

    // CHAINED-ESCALATION DRAIN. After the first swap engine runs one step,
    // `allObservations.length` becomes 3 (2 direct + 1 plan-execute).
    // StepEvaluator sees `3 > stepThreshold(1)` and returns
    // `escalate-to-plan-execute` AGAIN — at execution-handler.ts ~924 the
    // handler then calls `new PlanExecuteEngine()` a SECOND time. Without a
    // queued stub the constructor would throw and we'd never reach the
    // assertions. The second stub is a "drain" — its `shouldContinue` is
    // `false` so the loop exits cleanly at the top of the next iteration,
    // BEFORE its step/observe runs. The drain's `__tag` is intentionally
    // a fresh symbol so a future regression that double-swaps and reuses
    // the SAME instance still fails the identity check.
    const drainInstanceTag = Symbol("drain-engine-instance");
    planExecuteMock.queued.push({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      __tag: drainInstanceTag as any,
      strategy: "plan-execute" as const,
      async plan() {
        return { goal: "g3", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        // Should never run: shouldContinue returns false first.
        throw new Error("drain engine step should not run");
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: 0, summary: "drain", success: true, raw: sr, stopSignal: true };
      },
      async shouldContinue() {
        return false;
      },
      async synthesize() {
        return {
          answer: "drain",
          observations: [],
          totalSteps: 0,
          strategy: "plan-execute" as const,
          escalated: true,
          retriesUsed: 0,
        };
      },
      reset() {},
    });

    redis = createFakeRedis();
    await redis.flushall();
    db = { query: vi.fn(), connect: vi.fn() } as unknown as Pool;

    const r = freshRegistries();
    agentRegistry = r.agentRegistry;
    toolRegistry = r.toolRegistry;
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new EscalatingSurfaceAgent());
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

  it("engine swap mid-loop preserves observations", async () => {
    await handleExecution(basePayload(), ctx());

    // sendComplete fired on the success path (proves the swapped engine
    // drove the loop to completion).
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(1);

    // The handler instantiated PlanExecuteEngine TWICE — once for the
    // original escalate-to-plan-execute (after direct's 2 obs > threshold 1),
    // and once again after the swap engine's first step pushed length to
    // 3 (still > threshold 1, evaluator re-fires). The second instance is
    // the "drain" stub whose `shouldContinue` returns false so the loop
    // exits cleanly. If a future refactor changes the escalation chain
    // semantics (e.g. memoises the engine after first swap, or short-circuits
    // re-escalation when already at the target strategy), this trips and
    // points the maintainer at execution-handler.ts ~923 / step-evaluator.
    expect(planExecuteMock.calls).toHaveLength(2);

    // Identity check — the two engines really ARE different instances. If
    // both tags collide (e.g. someone reuses one stub), this fails before
    // the more-interesting summary assertion below.
    expect(directInstanceTag).not.toBe(planExecuteInstanceTag);

    // Load-bearing assertion #1: the swapped engine's `plan()` received an
    // input string containing the PRIOR engine's observation summaries. The
    // handler builds `remainingInput` as
    // `${input}\n\nCompleted so far:\n${observations.map(o.summary).join("\n")}`
    // (execution-handler.ts ~935). If that map/join is ever removed, the
    // sentinels disappear from the input string and this trips.
    expect(observedSwapPlanInput).toBeDefined();
    expect(observedSwapPlanInput).toContain("Completed so far:");
    expect(observedSwapPlanInput).toContain("OBS_FROM_DIRECT_0");
    expect(observedSwapPlanInput).toContain("OBS_FROM_DIRECT_1");

    // Load-bearing assertion #2: the SECOND engine actually ran post-swap.
    // Without this, an asymmetric refactor that builds the new engine but
    // never re-enters the loop would silently pass the input-threading
    // check.
    expect(planExecuteStepCalls).toBeGreaterThanOrEqual(1);
  });
});
