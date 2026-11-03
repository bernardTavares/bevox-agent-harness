/**
 * C.5 — Correlation probe (step 2.5) unit tests
 *
 * Verifies the three paths through the correlation probe inserted AFTER
 * contactId resolution and BEFORE the execution.pipeline span:
 *
 * 1. No sdr_profile → probe SKIPPED entirely (resolveActive never called).
 * 2. sdr_profile enabled + contactId + NO suspended cadence (resolveActive → null)
 *    → fall-through: MessageAnalyzer IS reached.
 * 3. sdr_profile enabled + contactId + HIT (resolveActive → CorrelationRow)
 *    → dispatchModelC invoked + handleExecution returns BEFORE pipeline.
 * 4. resolveActive rejects → degrade to fall-through (MessageAnalyzer reached).
 *
 * All cases: CorrelationStore is constructed via the test-injected mock pool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import { createFakeRedis } from "../../fakes/redis.fake.js";
import { FakeLLMGateway } from "../../fakes/llm-gateway.fake.js";

// ---------------------------------------------------------------------------
// Tracking state
// ---------------------------------------------------------------------------
let analyzerReached = false;

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports from execution-handler
// ---------------------------------------------------------------------------
const callbackMock = vi.hoisted(() => ({
  updateStatus: vi.fn().mockResolvedValue(undefined),
  sendComplete: vi.fn().mockResolvedValue(undefined),
  sendTrace: vi.fn().mockResolvedValue(undefined),
  sendStream: vi.fn().mockResolvedValue(undefined),
  // Real impl pass-through (helper é pure, post-2026-06-02 C2/C3 fix).
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

const strategyRouterMock = vi.hoisted(() => ({
  strategyRouter: {
    build: vi.fn(),
  },
}));

// CorrelationStore mock — we control resolveActive per test
const correlationStoreMock = vi.hoisted(() => ({
  resolveActive: vi.fn<
    [number, string],
    Promise<import("../../../src/workflow/correlation-store.js").CorrelationRow | null>
  >(),
}));

vi.mock("../../../src/integration/bevox-callback", () => callbackMock);
vi.mock("../../../src/integration/llm-gateway", async () => {
  const actual = await vi.importActual<typeof import("../../../src/integration/llm-gateway")>(
    "../../../src/integration/llm-gateway",
  );
  return { ...actual, createLLMGateway: gatewayMock.createLLMGateway };
});
vi.mock("../../../src/reasoning/strategy-router", () => strategyRouterMock);

// Mock CorrelationStore — must use function (not arrow) so `new` works
vi.mock("../../../src/workflow/correlation-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/workflow/correlation-store.js")>(
    "../../../src/workflow/correlation-store.js",
  );
  return {
    ...actual,
    CorrelationStore: vi.fn().mockImplementation(function () {
      return correlationStoreMock;
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports after vi.mock()
// ---------------------------------------------------------------------------
import {
  handleExecution,
  __setDispatchModelCForTests,
  type ExecutionContext,
} from "../../../src/runtime/execution-handler.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../../src/runtime/agent-router.js";
import { BaseAgent } from "../../../src/agents/base-agent.js";
import type { AgentDefinition, AgentResult } from "../../../src/agents/types.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type {
  AgentResponse,
  Observation,
  Plan,
  ReasoningEngine,
  StepResult,
  ToolExecutor,
  TraceCallback,
} from "../../../src/reasoning/engine.js";

// ---------------------------------------------------------------------------
// Fake reasoning engine — stops immediately after plan
// ---------------------------------------------------------------------------
class StopEngine implements ReasoningEngine {
  readonly strategy = "direct" as const;
  async plan(_input: string, _context: AgentExecutionContext): Promise<Plan> {
    return { goal: _input, steps: [], estimatedComplexity: "low" };
  }
  async step(
    _plan: Plan,
    stepIndex: number,
    _tools: unknown[],
    _context: AgentExecutionContext,
    _executeTool: ToolExecutor,
    _traceCallback?: TraceCallback,
  ): Promise<StepResult> {
    return { stepIndex, success: true, durationMs: 0 };
  }
  async observe(_stepResult: StepResult, _context: AgentExecutionContext): Promise<Observation> {
    return { stepIndex: 0, summary: "ok", success: true, raw: _stepResult, stopSignal: true };
  }
  async shouldContinue(
    observations: Observation[],
    _plan: Plan,
    _context: AgentExecutionContext,
  ): Promise<boolean> {
    return observations.length === 0;
  }
  async synthesize(
    _observations: Observation[],
    _plan: Plan,
    _context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    return {
      answer: "stub",
      observations: _observations,
      totalSteps: 1,
      strategy: "direct",
      escalated: false,
      retriesUsed: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Stub agents
// ---------------------------------------------------------------------------
class StubMessageAnalyzer extends BaseAgent {
  constructor() {
    super({
      name: "message-analyzer",
      type: "pipeline",
      description: "stub",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    } as AgentDefinition);
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    analyzerReached = true;
    return {
      success: true,
      output: {
        intent: "unknown",
        sentiment: "neutral",
        sentimentConfidence: 0.5,
        topics: [],
        urgency: "medium",
      },
    };
  }
}

class StubSurfaceAgent extends BaseAgent {
  constructor() {
    super({
      name: "scheduler",
      type: "surface",
      description: "stub",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    } as AgentDefinition);
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return { success: true, output: "ok" };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function freshRegistries() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (AgentRegistry as any).instance = undefined;
  UnifiedToolRegistry.resetForTests();
  return { agentRegistry: AgentRegistry.getInstance(), toolRegistry: UnifiedToolRegistry.getInstance() };
}

const VALID_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccc05";
const VALID_TOKEN = "b-correlation-probe-token-00000001";

function basePayload(over: Record<string, unknown> = {}) {
  return {
    execution_id: VALID_UUID,
    execution_token: VALID_TOKEN,
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    messages: [{ role: "user", content: "hello" }],
    ...over,
  };
}

const SAMPLE_CORR_ROW = {
  workflowExecutionId: "wf-exec-001",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactKey: "12345",
  suspendToken: "tok-abc",
  resumeEvent: "reply:inbound" as const,
  status: "suspended",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  workflowVersion: 1,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("C.5 — correlation probe (step 2.5)", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;

  beforeEach(async () => {
    analyzerReached = false;
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    correlationStoreMock.resolveActive.mockReset();
    gatewayMock.createLLMGateway.mockReset();

    strategyRouterMock.strategyRouter.build.mockReturnValue(new StopEngine());

    const gateway = new FakeLLMGateway({
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

    redis = createFakeRedis();
    await redis.flushall();
    db = { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn() } as unknown as Pool;

    const r = freshRegistries();
    agentRegistry = r.agentRegistry;
    toolRegistry = r.toolRegistry;

    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());

    // Default: reset dispatchModelC to undefined
    __setDispatchModelCForTests(undefined);
  });

  afterEach(() => {
    __setDispatchModelCForTests(undefined);
  });

  function ctx(): ExecutionContext {
    return { db, redis, agentRegistry, toolRegistry, agentRouter: createAgentRouter() };
  }

  // -------------------------------------------------------------------------
  // Case 1: No sdr_profile → probe SKIPPED
  // -------------------------------------------------------------------------
  it("skips probe entirely when no sdr_profile (resolveActive never called)", async () => {
    const payload = basePayload({
      conversation: { id: "conv-1", contact_id: 12345 },
      // no agent_config.sdr_profile
    });

    await handleExecution(payload, ctx());

    expect(correlationStoreMock.resolveActive).not.toHaveBeenCalled();
    // Pipeline should run normally
    expect(analyzerReached).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 2: sdr_profile enabled + contactId + NO hit → fall-through
  // -------------------------------------------------------------------------
  it("falls through to pipeline when resolveActive returns null (no suspended cadence)", async () => {
    correlationStoreMock.resolveActive.mockResolvedValue(null);

    const payload = basePayload({
      conversation: { id: "conv-2", contact_id: 12345 },
      agent_config: {
        sdr_profile: { enabled: true },
      },
    });

    await handleExecution(payload, ctx());

    expect(correlationStoreMock.resolveActive).toHaveBeenCalledOnce();
    expect(correlationStoreMock.resolveActive).toHaveBeenCalledWith(
      "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      "12345",
    );
    // Pipeline must have been reached
    expect(analyzerReached).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 3: sdr_profile enabled + contactId + HIT → dispatchModelC invoked,
  //         pipeline NOT reached
  // -------------------------------------------------------------------------
  it("invokes dispatchModelC and returns before pipeline when correlation row is found", async () => {
    correlationStoreMock.resolveActive.mockResolvedValue(SAMPLE_CORR_ROW);

    let dispatchCalled = false;
    let dispatchArgs: unknown;

    __setDispatchModelCForTests(async (args) => {
      dispatchCalled = true;
      dispatchArgs = args;
      // Return void — handleExecution returns Promise<void>
    });

    const payload = basePayload({
      conversation: { id: "conv-3", contact_id: 12345 },
      agent_config: {
        sdr_profile: { enabled: true },
      },
    });

    await handleExecution(payload, ctx());

    expect(correlationStoreMock.resolveActive).toHaveBeenCalledOnce();
    expect(correlationStoreMock.resolveActive).toHaveBeenCalledWith(
      "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      "12345",
    );
    expect(dispatchCalled).toBe(true);

    // dispatchModelC must have received the correlation row + context
    const args = dispatchArgs as Record<string, unknown>;
    expect(args["corr"]).toEqual(SAMPLE_CORR_ROW);
    expect(args["organizationId"]).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
    expect(args["contactKey"]).toBe("12345");

    // Pipeline (MessageAnalyzer) must NOT have been reached
    expect(analyzerReached).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Case 4: resolveActive rejects → degrade to fall-through (never throws)
  // -------------------------------------------------------------------------
  it("degrades to fall-through when resolveActive rejects (never throws, pipeline runs)", async () => {
    correlationStoreMock.resolveActive.mockRejectedValue(new Error("DB connection lost"));

    const payload = basePayload({
      conversation: { id: "conv-4", contact_id: 12345 },
      agent_config: {
        sdr_profile: { enabled: true },
      },
    });

    // Must not throw
    await expect(handleExecution(payload, ctx())).resolves.toBeUndefined();

    expect(correlationStoreMock.resolveActive).toHaveBeenCalledOnce();
    // Pipeline must still be reached (fall-through)
    expect(analyzerReached).toBe(true);
  });
});
