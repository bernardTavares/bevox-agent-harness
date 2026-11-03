/**
 * X-Execution-Token header invariant (PRD §12.2).
 *
 * The runtime invariant under test: every HTTP call made by the runtime to a
 * bevox-backend callback (`updateStatus`, `sendComplete`, `sendTrace`,
 * `sendStream`) MUST be authenticated with the `X-Execution-Token` header
 * carrying the `execution_token` from the inbound BullMQ payload. The token
 * threads as the SECOND positional argument through every outbound callback
 * function in `src/integration/bevox-callback.ts`
 * (signatures: `(executionId, token, payload, idempotencyKey?)`), and the
 * shared `post()` helper at L22-25 of that file sets the header verbatim from
 * that argument. If the runtime ever drops/replaces/mutates the token between
 * payload ingress and callback invocation, the backend rejects the request
 * (HTTP 401) and the execution is silently orphaned from the client's POV.
 *
 * This is the canonical authentication seam between harness and backend
 * (PRD §12.2 + ADR-005). The token MUST flow unchanged — it identifies which
 * execution the callback belongs to and is verified by the backend against
 * the row keyed by `execution_id`.
 *
 * Test strategy (em-03-style, shallower than mocking the global `fetch`):
 *   - Inject a distinctive sentinel `execution_token` via `basePayload({
 *     execution_token: SENTINEL })` so the assertion can prove the value
 *     observed at the callback boundary IS the value from the payload (not a
 *     constant accidentally hardcoded somewhere in the chain).
 *   - Drive a nominal success-path execution.
 *   - Assert each callback function that fires received the sentinel at
 *     position [1] of its call args.
 *
 * The deeper alternative — mocking `globalThis.fetch` and asserting the
 * `X-Execution-Token` header on the outgoing request — exercises one
 * additional hop (the `post()` helper). It can be added later if there's a
 * regression class that mutates the token between the callback wrapper and
 * `fetch`. Today the wrapper layer is a one-line passthrough, so this
 * em-03-style test catches the realistic regressions (runtime forgets to
 * pass the token / passes a stale token from a previous execution / hardcodes
 * a debug value) with less mock surface.
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

// Distinctive sentinel — long enough to clear any min-length token validation
// the payload schema enforces, and unique enough that grep-ing the test for
// the literal proves the assertion is reading from THIS payload (not e.g. a
// constant in the helper). Avoid generic strings like "test" or
// VALID_TOKEN (used as the default in basePayload) — using a distinct
// sentinel here catches "runtime ignores the payload token and falls back to
// a default" as a real regression class.
const SENTINEL_TOKEN = "TOKEN_SENTINEL_T5_at_least_twenty_chars";

describe("X-Execution-Token header invariant — token threads through every outbound callback", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;
  let gateway: FakeLLMGateway;

  beforeEach(async () => {
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    callbackMock.sendTrace.mockClear();
    callbackMock.sendStream.mockClear();
    gatewayMock.createLLMGateway.mockReset();

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

    // Mock engine: minimal one-step success path. We're not exercising
    // reasoning/tool semantics here — just driving the runtime far enough to
    // make it issue the nominal callbacks (`updateStatus("running")`,
    // `sendComplete(...)` at minimum).
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
          _context: AgentExecutionContext,
        ) {
          stepped = true;
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

  it("X-Execution-Token threads through every outbound callback", async () => {
    await handleExecution(basePayload({ execution_token: SENTINEL_TOKEN }), ctx());

    // sendComplete fires exactly once on a nominal success path; assert the
    // sentinel landed in arg[1] (the canonical token slot per
    // bevox-callback.ts:149-157).
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(1);
    const sendCompleteCall = callbackMock.sendComplete.mock.calls[0];
    expect(sendCompleteCall?.[1]).toBe(SENTINEL_TOKEN);

    // updateStatus fires at least once (status="running" handoff + likely a
    // terminal status). EVERY call must carry the sentinel in arg[1] — a
    // mid-execution call that drops or mutates the token would still leak
    // through if we only checked the first invocation, hence the loop.
    expect(callbackMock.updateStatus).toHaveBeenCalled();
    for (const call of callbackMock.updateStatus.mock.calls) {
      expect(call?.[1]).toBe(SENTINEL_TOKEN);
    }

    // sendTrace / sendStream may or may not fire on this nominal path
    // (depends on observability/streaming wiring). If they DID fire, the
    // sentinel must still appear in arg[1] for the same reason as above.
    // Conditional assertion keeps the test resilient to wiring changes that
    // don't affect the invariant.
    for (const call of callbackMock.sendTrace.mock.calls) {
      expect(call?.[1]).toBe(SENTINEL_TOKEN);
    }
    for (const call of callbackMock.sendStream.mock.calls) {
      expect(call?.[1]).toBe(SENTINEL_TOKEN);
    }
  });
});
