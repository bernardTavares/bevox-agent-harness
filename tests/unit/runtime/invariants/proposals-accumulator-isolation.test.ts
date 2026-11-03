/**
 * Proposals accumulator — per-execution isolation guard.
 *
 * The runtime invariant under test: the `proposalsAccumulator` that captures
 * mutation-tool proposals (ADR-006/ADR-007 draft-mode shape; see EM-03 for
 * the end-to-end round-trip) is a PER-EXECUTION instance, scoped to a single
 * `handleExecution(payload, ctx)` call. Two distinct executions — whether
 * run sequentially or concurrently on the same `ExecutionContext` — must
 * each see ONLY their own proposals in the `/complete.proposals[]` payload.
 *
 * Why this guard exists. Today the accumulator lives in `handleExecution`'s
 * closure, so isolation is structural — the array is allocated per call. The
 * spec in `docs/superpowers/specs/2026-06-03-execution-handler-split-and-di-design.md`
 * Phase 3 migrates this state to a new `ExecutionScope` container that will
 * be threaded through the split sub-functions. If that migration accidentally
 * hoists the accumulator to a longer-lived scope (a closure higher up the
 * call stack, a module-level singleton, or an `ExecutionContext` field that
 * outlives a single execution), proposals from execution A would leak into
 * execution B's /complete payload — a cross-tenant data bleed at the runtime
 * layer, and a hard ADR-019 violation. This test is the regression net for
 * that PR-3 refactor.
 *
 * Spec ref: `docs/superpowers/specs/2026-06-03-execution-handler-split-and-di-design.md`
 *           Phase 3 (ExecutionScope) + §9.1 (invariant tests subfolder).
 *
 * Mechanism. Same skeleton as EM-03 (synthetic `waitlist-add` mutation tool,
 * mocked strategy-router that drives a single tool call per surface step,
 * mocked bevox-callback to capture sendComplete payloads). Two extensions:
 *
 *   1. The synthetic tool's returned proposal embeds `execution_id` from the
 *      AgentExecutionContext into `params.__execution_id`, so even if a leak
 *      somehow preserved the right COUNT we can still see WHICH execution
 *      produced each proposal — forensic traceability.
 *   2. The tool is configurable to emit N proposals per single tool call (by
 *      pushing to the accumulator via N sequential `executeTool` invocations
 *      inside a multi-step plan). This lets us assert exact counts per
 *      execution: A=2, B=0; concurrent 1=1, 2=3.
 *
 * The negative-case discipline (per Task 11 reviewer): the sequential test
 * asserts execution B with ZERO proposals genuinely lands an empty/omitted
 * proposals field — that's the "no cross-bleed from A's accumulator" guard.
 * The concurrent test asserts both executions land their own count, neither
 * inflated nor deflated by the other.
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

// Hoisted mocks. See `tests/helpers/invariant-harness.ts` header for the
// vitest-hoisting constraint that forces this duplication across invariant
// tests.
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

import {
  handleExecution,
  type ExecutionContext,
} from "../../../../src/runtime/execution-handler.js";
import { AgentRegistry } from "../../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../../../src/runtime/agent-router.js";
import type { AgentExecutionContext } from "../../../../src/agents/execution-context.js";
import type { ToolDefinition } from "../../../../src/tools/types.js";

// Two distinct, hard-coded UUIDs for the sequential A/B case. Schema at
// execution-handler.ts ~634 enforces `z.string().uuid()`, so synthetic
// strings like "exec-A-uuid" would be rejected by the payload validator.
const EXEC_A = "22222222-2222-4222-8222-222222222222";
const EXEC_B = "33333333-3333-4333-8333-333333333333";
const EXEC_C1 = "44444444-4444-4444-8444-444444444444";
const EXEC_C2 = "55555555-5555-4555-8555-555555555555";

// Synthetic mutation tool. Same shape as EM-03's `waitlist-add` stub. The
// returned `params` echo the inbound params VERBATIM, so the caller can
// embed an execution_id sentinel into `params.__execution_id` and observe
// it in the captured /complete payload.
function makeWaitlistAddProposalStub(): ToolDefinition {
  return {
    name: "waitlist-add",
    description: "stub waitlist add — draft mode (returns proposal, no effect)",
    category: "calendar",
    agentType: "surface",
    parameters: { type: "object", properties: {} },
    async execute(params) {
      return {
        success: true as const,
        data: {
          proposal: {
            action: "waitlist-add",
            params,
          },
        },
      };
    },
  };
}

// Read-only stub for the "B emits zero proposals" arm of the sequential
// case. Name is intentionally NOT in MUTATION_TOOL_NAMES, so the extractor
// gate at handler ~1876 skips it even if the result accidentally carried a
// `data.proposal` shape.
function makeReadOnlyStub(): ToolDefinition {
  return {
    name: "fetch-context",
    description: "stub read-only fetch",
    category: "knowledge",
    agentType: "surface",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { success: true as const, data: { items: [] } };
    },
  };
}

describe("proposals accumulator — isolation between executions", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;
  let gateway: FakeLLMGateway;
  // Per-execution_id directive for how many `waitlist-add` invocations the
  // mocked engine should drive in a single step. The router's `step()` reads
  // the AgentExecutionContext's `executionId` to find its directive — this is
  // the mechanism that lets concurrent executions emit different proposal
  // counts via the SAME router mock instance (router is module-singleton-ish,
  // mocked once per `beforeEach`).
  const proposalsPerExec: Map<string, number> = new Map();

  beforeEach(async () => {
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    gatewayMock.createLLMGateway.mockReset();
    proposalsPerExec.clear();

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

    // Mock engine. Each call to `build()` returns a FRESH engine closure (the
    // real strategyRouter does the same — one engine per surface invocation),
    // so the `stepped` latch is per-execution. Inside `step()` we look up the
    // directive by `context.executionId`, then invoke `waitlist-add` N times.
    // Each invocation embeds `__execution_id` into params so the accumulated
    // proposal carries forensic provenance.
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
          executeTool: (
            name: string,
            params: unknown,
            ctx: AgentExecutionContext,
          ) => Promise<unknown>,
        ) {
          stepped = true;
          const execId = context.executionId;
          const count = proposalsPerExec.get(execId) ?? 0;
          for (let i = 0; i < count; i++) {
            await executeTool(
              "waitlist-add",
              {
                calendar_id: `cal-${i}`,
                customer_name: `Alice-${i}`,
                __execution_id: execId,
              },
              context,
            );
          }
          // If count is 0 and a read-only tool is desired, drive that
          // instead. Detected by sentinel value -1 (B in the sequential
          // case sets -1 to mean "run fetch-context once").
          if (count === -1) {
            await executeTool(
              "fetch-context",
              { __execution_id: execId },
              context,
            );
          }
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
    agentRegistry.register(new StubSurfaceAgent(["waitlist-add", "fetch-context"]));
    toolRegistry.registerToolDefinition(makeWaitlistAddProposalStub());
    toolRegistry.registerToolDefinition(makeReadOnlyStub());
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

  it("sequential: execution A with 2 proposals + execution B with 0 → B.proposals omitted", async () => {
    // A emits 2 proposals; B drives the read-only tool (sentinel -1).
    proposalsPerExec.set(EXEC_A, 2);
    proposalsPerExec.set(EXEC_B, -1);

    await handleExecution(basePayload({ execution_id: EXEC_A }), ctx());
    await handleExecution(basePayload({ execution_id: EXEC_B }), ctx());

    // Sentinel guard: BOTH executions reached sendComplete exactly once.
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(2);

    // Pick out each call by its first arg (executionId). signature:
    // sendComplete(executionId, token, payload, idempotencyKey).
    const callA = callbackMock.sendComplete.mock.calls.find(
      (c) => c[0] === EXEC_A,
    );
    const callB = callbackMock.sendComplete.mock.calls.find(
      (c) => c[0] === EXEC_B,
    );
    expect(callA, "sendComplete for A must be present").toBeDefined();
    expect(callB, "sendComplete for B must be present").toBeDefined();

    const payloadA = callA?.[2] as {
      proposals?: Array<{ action: string; params: { __execution_id?: string } }>;
    };
    const payloadB = callB?.[2] as { proposals?: unknown[] };

    // A: exactly 2 proposals, both stamped with A's execution_id.
    expect(payloadA.proposals).toBeDefined();
    expect(payloadA.proposals).toHaveLength(2);
    expect(payloadA.proposals?.[0]?.params.__execution_id).toBe(EXEC_A);
    expect(payloadA.proposals?.[1]?.params.__execution_id).toBe(EXEC_A);

    // B: no proposals. `buildCompletePayload` omits the field when empty
    // (bevox-callback.ts ~94). If the accumulator leaked from A into B,
    // this assertion would catch the cross-bleed.
    expect(payloadB.proposals).toBeUndefined();
  });

  it("concurrent: two Promise.all executions keep their proposals strictly separated", async () => {
    // Distinct proposal counts per execution. Concurrent dispatch via
    // Promise.all interleaves the two surface loops; if any shared mutable
    // state (e.g. accumulator hoisted into ExecutionContext during a bad
    // Phase-3 refactor) lived above `handleExecution`'s closure, one
    // execution's proposals would surface in the other's payload.
    proposalsPerExec.set(EXEC_C1, 1);
    proposalsPerExec.set(EXEC_C2, 3);

    await Promise.all([
      handleExecution(basePayload({ execution_id: EXEC_C1 }), ctx()),
      handleExecution(basePayload({ execution_id: EXEC_C2 }), ctx()),
    ]);

    // Sentinel guard: both reached sendComplete.
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(2);

    const callC1 = callbackMock.sendComplete.mock.calls.find(
      (c) => c[0] === EXEC_C1,
    );
    const callC2 = callbackMock.sendComplete.mock.calls.find(
      (c) => c[0] === EXEC_C2,
    );
    expect(callC1, "sendComplete for C1 must be present").toBeDefined();
    expect(callC2, "sendComplete for C2 must be present").toBeDefined();

    const payloadC1 = callC1?.[2] as {
      proposals?: Array<{ action: string; params: { __execution_id?: string } }>;
    };
    const payloadC2 = callC2?.[2] as {
      proposals?: Array<{ action: string; params: { __execution_id?: string } }>;
    };

    // Exact counts.
    expect(payloadC1.proposals).toHaveLength(1);
    expect(payloadC2.proposals).toHaveLength(3);

    // Forensic provenance: every proposal in C1's payload was stamped by
    // C1; every proposal in C2's payload was stamped by C2. A count-only
    // assertion would miss a swap (C1 sees 1 of C2's, C2 sees one of C1's
    // plus its own 2) — the provenance check catches that.
    for (const p of payloadC1.proposals ?? []) {
      expect(p.params.__execution_id).toBe(EXEC_C1);
    }
    for (const p of payloadC2.proposals ?? []) {
      expect(p.params.__execution_id).toBe(EXEC_C2);
    }
  });
});
