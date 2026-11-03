/**
 * B.7 — surface agentContext.contactId gap fix
 *
 * Verifies that when a payload carries a contact identifier in
 * `payload.conversation.contact_id` or `payload.context.contact_id`, the
 * surface agentContext receives `contactId` as a bigint.  When the field is
 * absent, `contactId` stays `undefined` and execution succeeds normally.
 *
 * Strategy: mock the strategy-router so the fake engine's plan() captures
 * the agentContext passed through runSurfaceAgentLoop — this is the same
 * agentContext constructed at ~lines 497-514 of execution-handler.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import { createFakeRedis } from "../../fakes/redis.fake.js";
import { FakeLLMGateway } from "../../fakes/llm-gateway.fake.js";
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
// Capture slot — filled when engine.plan() is first called with the context
// ---------------------------------------------------------------------------
let capturedContext: AgentExecutionContext | undefined;

// ---------------------------------------------------------------------------
// Fake engine — satisfies ReasoningEngine; captures agentContext from plan()
// ---------------------------------------------------------------------------
class CaptureEngine implements ReasoningEngine {
  readonly strategy = "direct" as const;

  async plan(_input: string, context: AgentExecutionContext): Promise<Plan> {
    capturedContext = context;
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
    return {
      stepIndex,
      success: true,
      durationMs: 0,
    };
  }

  async observe(_stepResult: StepResult, _context: AgentExecutionContext): Promise<Observation> {
    return {
      stepIndex: 0,
      summary: "ok",
      success: true,
      raw: _stepResult,
      stopSignal: true, // signal stop so loop exits immediately
    };
  }

  async shouldContinue(
    observations: Observation[],
    _plan: Plan,
    _context: AgentExecutionContext,
  ): Promise<boolean> {
    // Stop after first observation
    return observations.length === 0;
  }

  async synthesize(
    _observations: Observation[],
    _plan: Plan,
    _context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    return {
      answer: "stub-answer",
      observations: _observations,
      totalSteps: 1,
      strategy: "direct",
      escalated: false,
      retriesUsed: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Hoisted mocks
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

vi.mock("../../../src/integration/bevox-callback", () => callbackMock);
vi.mock("../../../src/integration/llm-gateway", async () => {
  const actual = await vi.importActual<typeof import("../../../src/integration/llm-gateway")>(
    "../../../src/integration/llm-gateway",
  );
  return { ...actual, createLLMGateway: gatewayMock.createLLMGateway };
});
vi.mock("../../../src/reasoning/strategy-router", () => strategyRouterMock);

// ---------------------------------------------------------------------------
// Imports that must come AFTER vi.mock()
// ---------------------------------------------------------------------------
import { handleExecution, type ExecutionContext } from "../../../src/runtime/execution-handler.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../../src/runtime/agent-router.js";
import { BaseAgent } from "../../../src/agents/base-agent.js";
import type { AgentDefinition, AgentResult } from "../../../src/agents/types.js";

// ---------------------------------------------------------------------------
// Stub surface agent (just needs to be registered so routing picks it up)
// ---------------------------------------------------------------------------
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
    return {
      success: true,
      output: {
        intent: "scheduling",
        sentiment: "neutral",
        sentimentConfidence: 0.5,
        topics: [],
        urgency: "medium",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function freshRegistries() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (AgentRegistry as any).instance = undefined;
  UnifiedToolRegistry.resetForTests();
  return {
    agentRegistry: AgentRegistry.getInstance(),
    toolRegistry: UnifiedToolRegistry.getInstance(),
  };
}

const VALID_UUID = "22222222-2222-4222-8222-222222222222";
const VALID_TOKEN = "b-very-long-token-value-9876543210";

function basePayload(over: Record<string, unknown> = {}) {
  return {
    execution_id: VALID_UUID,
    execution_token: VALID_TOKEN,
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    messages: [{ role: "user", content: "hello" }],
    ...over,
  };
}

describe("surface agentContext.contactId (B.7 gap fix)", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;

  beforeEach(async () => {
    capturedContext = undefined;
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    gatewayMock.createLLMGateway.mockReset();

    // strategyRouter.build() returns our capture engine
    strategyRouterMock.strategyRouter.build.mockReturnValue(new CaptureEngine());

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

  it("sets contactId on surface agentContext when payload.conversation.contact_id is present", async () => {
    const payload = basePayload({
      conversation: { id: "conv-1", contact_id: 12345 },
    });
    await handleExecution(payload, ctx());
    expect(
      capturedContext,
      "engine.plan() should have been called with agentContext",
    ).toBeDefined();
    expect(capturedContext!.contactId).toBe(BigInt(12345));
  });

  it("sets contactId on surface agentContext when payload.context.contact_id is present (fallback field)", async () => {
    const payload = basePayload({
      context: { contact_id: "67890" },
    });
    await handleExecution(payload, ctx());
    expect(
      capturedContext,
      "engine.plan() should have been called with agentContext",
    ).toBeDefined();
    expect(capturedContext!.contactId).toBe(BigInt(67890));
  });

  it("leaves contactId undefined when no contact_id in payload (no throw, no behavior change)", async () => {
    const payload = basePayload();
    await handleExecution(payload, ctx());
    expect(
      capturedContext,
      "engine.plan() should have been called with agentContext",
    ).toBeDefined();
    expect(capturedContext!.contactId).toBeUndefined();
  });

  it("leaves contactId undefined when contact_id is not parseable as bigint (graceful guard)", async () => {
    const payload = basePayload({
      conversation: { id: "conv-bad", contact_id: "not-a-number" },
    });
    await handleExecution(payload, ctx());
    expect(
      capturedContext,
      "engine.plan() should have been called with agentContext",
    ).toBeDefined();
    expect(capturedContext!.contactId).toBeUndefined();
  });
});
