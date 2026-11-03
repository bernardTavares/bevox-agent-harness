/**
 * EM-03 — Proposals end-to-end invariant: tool propose → /complete.proposals[].
 *
 * The runtime invariant under test (audit ref: runtime-gap-audit-2026-06-02
 * §EM-03 + issue #44): when a mutation tool returns `{ success: true,
 * data: { proposal: { action, params } } }` (the canonical draft-mode shape
 * emitted by `wrapMutationTool` in `manual_assisted` / `copilot` modes,
 * ADR-006/ADR-007), the runtime MUST:
 *   1. Detect the proposal via `extractProposal()` after the tool returns.
 *   2. Push it into the per-execution `proposalsAccumulator` (handler ~1765).
 *   3. Pass the accumulator into `buildCompletePayload({ proposals })` at the
 *      terminal `sendComplete` call (~1973).
 *   4. Have `buildCompletePayload` include `proposals` in the outgoing
 *      `/complete` payload when the array is non-empty (consumed by the
 *      bevox-backend `executeProposals()` seam, ADR-007).
 *
 * Regression guard. Behavior is currently correct end-to-end (the leak that
 * issue #44 originally documented — proposals captured but not threaded into
 * `buildCompletePayload` — was fixed by adding `proposals:
 * proposalsAccumulator` to the call site at ~1973). This test pins the full
 * round-trip so a future refactor that drops the field, or breaks the
 * extractor's mutation-tool gate, trips the build.
 *
 * Mechanism: register a synthetic `waitlist-add` tool (one of the closed
 * MUTATION_TOOL_NAMES at handler ~85) that returns the canonical proposal
 * shape, drive the surface loop to invoke it once, and assert the proposal
 * lands in the `proposals[]` field of the payload that `sendComplete`
 * receives. The negative case registers a non-mutation tool to confirm the
 * field is omitted (per `buildCompletePayload`'s spread-only-if-non-empty
 * convention) when nothing proposes.
 *
 * NOTE: execution_mode (ADR-006) influences whether a *real* MutationTool
 * returns an effect vs a proposal — but at the runtime layer the hoist code
 * keys off `extractProposal()`'s detection of `data.proposal`, NOT off
 * execution_mode. The synthetic tool here hardcodes the proposal shape, which
 * is what a `wrapMutationTool`-wrapped tool would emit in copilot mode. No
 * payload-level execution_mode is required to exercise the hoist path.
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

// Hoisted mocks: see tests/helpers/invariant-harness.ts header for why these
// can't be extracted.
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

// Synthetic mutation tool. The runtime treats any tool whose name is in
// MUTATION_TOOL_NAMES (handler ~85) as a mutation; the proposal-extractor
// (`extractProposal` in src/tools/_shared/mutation-tool.ts) only fires for
// those. Returns the canonical draft-mode shape that `wrapMutationTool`
// emits in `manual_assisted` / `copilot` (ADR-006).
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

// Read-only stub used by the negative case. The name is INTENTIONALLY not in
// MUTATION_TOOL_NAMES, so even if it returned a `data.proposal` shape the
// extractor's gate at handler ~1876 would skip it. We don't return a proposal
// here either — belt and suspenders.
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

describe("EM-03 proposals end-to-end invariant — tool propose reaches /complete.proposals[]", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;
  let gateway: FakeLLMGateway;
  // Which tool name the mocked engine should invoke during the surface step.
  // Switched per `it` block so the negative case can skip tool invocation
  // entirely (no proposal accumulator activity).
  let toolToInvoke: string | null;

  beforeEach(async () => {
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    gatewayMock.createLLMGateway.mockReset();
    toolToInvoke = null;

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

    // Mock engine: step() invokes the per-test tool through executeTool, so
    // the runtime's mutation-detection + proposal-hoist code path
    // (execution-handler.ts ~1841-1883) fires. If toolToInvoke is null, the
    // step is a no-op (negative case: no tool executes).
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
          if (toolToInvoke !== null) {
            await executeTool(
              toolToInvoke,
              { calendar_id: "cal-1", customer_name: "Alice" },
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
    // Surface agent declares BOTH tools as required so the runtime permission
    // gate (`filterPermittedTools`) allows whichever the test invokes.
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

  it("tool returning proposal puts it into /complete.proposals[]", async () => {
    toolToInvoke = "waitlist-add";

    await handleExecution(basePayload(), ctx());

    // sendComplete fired exactly once on the success path.
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(1);

    // Inspect the payload threaded through sendComplete. Signature:
    // sendComplete(executionId, token, payload, idempotencyKey).
    const sendCompleteCall = callbackMock.sendComplete.mock.calls[0];
    expect(sendCompleteCall).toBeDefined();
    const payload = sendCompleteCall?.[2] as {
      proposals?: Array<{ action: string; params: unknown }>;
    };

    // Load-bearing assertion: the proposal made it ALL the way to the
    // outgoing /complete payload. If the accumulator stops being threaded
    // into buildCompletePayload (the issue #44 leak), `proposals` is
    // undefined here and this trips.
    expect(payload.proposals).toBeDefined();
    expect(payload.proposals).toHaveLength(1);
    expect(payload.proposals?.[0]).toEqual({
      action: "waitlist-add",
      params: { calendar_id: "cal-1", customer_name: "Alice" },
    });
  });

  it("no proposals when only read-only tool runs", async () => {
    toolToInvoke = "fetch-context";

    await handleExecution(basePayload(), ctx());

    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(1);
    const sendCompleteCall = callbackMock.sendComplete.mock.calls[0];
    const payload = sendCompleteCall?.[2] as {
      proposals?: unknown[];
    };

    // `buildCompletePayload` spreads `proposals` ONLY when the array is
    // non-empty (bevox-callback.ts ~94). A read-only tool path → no
    // accumulator pushes → field omitted from the payload entirely.
    expect(payload.proposals).toBeUndefined();
  });
});
