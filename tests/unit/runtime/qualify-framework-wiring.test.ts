/**
 * C.9 — resolveQualificationFramework wired into qualify path (CF2)
 *
 * Verifies that when executeTool dispatches "qualify-opportunity", the
 * `params.framework` field is deterministically overridden by the result of
 * resolveQualificationFramework(sdrProfile.qualification_framework, configDefault)
 * rather than whatever the LLM put in the JSON.
 *
 * Cases:
 * 1. sdr_profile.enabled + qualification_framework: "PACT2", LLM passes "PACT"
 *    → tool receives framework "PACT2" (profile wins).
 * 2. No sdr_profile → tool receives framework = config default ("PACT" by default).
 * 3. Profile "PACT2" vs config default "PACT" → tool gets "PACT2" (profile-over-config).
 * 4. Override only applies to qualify-opportunity + sdrProfile.enabled.
 *    Other tools' params are untouched.
 * 5. Non-SDR (no sdr_profile) executions: other tools untouched (zero-cost path).
 *
 * Strategy: fake reasoning engine whose step() calls executeTool("qualify-opportunity")
 * with LLM-supplied params; a fake qualify-opportunity tool captures the params it
 * receives so the test can assert on the overridden framework value.
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
import type { ToolDefinition, ToolResult } from "../../../src/tools/types.js";

// ---------------------------------------------------------------------------
// Capture slot — filled by the fake qualify-opportunity tool when called
// ---------------------------------------------------------------------------
let capturedQualifyParams: unknown = undefined;
let capturedOtherParams: unknown = undefined;

// LLM-supplied framework value injected per test
let llmFrameworkValue: string | undefined = undefined;
// Other-tool name injected per test
let otherToolNameToCall: string | undefined = undefined;

// ---------------------------------------------------------------------------
// Fake reasoning engine — calls executeTool("qualify-opportunity") in step()
// so the test can observe what params the tool receives after the wrap.
// ---------------------------------------------------------------------------
class QualifyCallingEngine implements ReasoningEngine {
  readonly strategy = "direct" as const;

  async plan(_input: string, _context: AgentExecutionContext): Promise<Plan> {
    return { goal: _input, steps: [], estimatedComplexity: "low" };
  }

  async step(
    _plan: Plan,
    stepIndex: number,
    _tools: unknown[],
    _context: AgentExecutionContext,
    executeTool: ToolExecutor,
    _traceCallback?: TraceCallback,
  ): Promise<StepResult> {
    // Simulate LLM calling qualify-opportunity with whatever framework it guessed
    const llmParams: Record<string, unknown> = {
      pain: { evidence: "budget confirmed" },
      authority: { evidence: "CTO present" },
    };
    if (llmFrameworkValue !== undefined) {
      llmParams.framework = llmFrameworkValue;
    }
    await executeTool("qualify-opportunity", llmParams, _context);

    // Also call another tool if configured (to test non-qualify tools are untouched)
    if (otherToolNameToCall) {
      await executeTool(otherToolNameToCall, { someField: "value" }, _context);
    }

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
// Imports after vi.mock()
// ---------------------------------------------------------------------------
import { handleExecution, type ExecutionContext } from "../../../src/runtime/execution-handler.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../../src/runtime/agent-router.js";
import { BaseAgent } from "../../../src/agents/base-agent.js";
import type { AgentDefinition, AgentResult } from "../../../src/agents/types.js";

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
// Fake tool: qualify-opportunity — captures params it receives
// ---------------------------------------------------------------------------
const fakeQualifyTool: ToolDefinition = {
  name: "qualify-opportunity",
  description: "fake qualify tool",
  category: "sales",
  agentType: "surface",
  parameters: {},
  async execute(params: unknown, _context: AgentExecutionContext): Promise<ToolResult> {
    capturedQualifyParams = params;
    return { success: true, data: { qualified: true } };
  },
};

// Fake "other" tool — captures params to assert they are NOT mutated
const fakeOtherTool: ToolDefinition = {
  name: "send-message",
  description: "fake other tool",
  category: "messaging",
  agentType: "surface",
  parameters: {},
  async execute(params: unknown, _context: AgentExecutionContext): Promise<ToolResult> {
    capturedOtherParams = params;
    return { success: true, data: {} };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function freshRegistries() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (AgentRegistry as any).instance = undefined;
  UnifiedToolRegistry.resetForTests();
  const agentRegistry = AgentRegistry.getInstance();
  const toolRegistry = UnifiedToolRegistry.getInstance();
  return { agentRegistry, toolRegistry };
}

const VALID_UUID = "c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c909";
const VALID_TOKEN = "b-qualify-framework-wiring-token-c9";

function basePayload(over: Record<string, unknown> = {}) {
  return {
    execution_id: VALID_UUID,
    execution_token: VALID_TOKEN,
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    messages: [{ role: "user", content: "qualify this lead" }],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("C.9 — resolveQualificationFramework wired into qualify path", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;

  beforeEach(async () => {
    capturedQualifyParams = undefined;
    capturedOtherParams = undefined;
    llmFrameworkValue = undefined;
    otherToolNameToCall = undefined;
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    gatewayMock.createLLMGateway.mockReset();

    strategyRouterMock.strategyRouter.build.mockReturnValue(new QualifyCallingEngine());

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
    toolRegistry.registerToolDefinition(fakeQualifyTool);
    toolRegistry.registerToolDefinition(fakeOtherTool);
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

  it("profile PACT2 wins over LLM-supplied PACT (profile-over-LLM, deterministic)", async () => {
    // LLM guesses "PACT"; profile says "PACT2" → tool must see "PACT2"
    llmFrameworkValue = "PACT";

    const payload = basePayload({
      agent_config: {
        system_prompt: "you are a sales agent",
        sdr_profile: {
          enabled: true,
          qualification_framework: "PACT2",
        },
      },
    });

    await handleExecution(payload, ctx());

    expect(capturedQualifyParams, "qualify tool must have been called").not.toBeUndefined();
    const p = capturedQualifyParams as Record<string, unknown>;
    expect(p.framework).toBe("PACT2");
  });

  it("profile PACT2 wins even when LLM passes no framework field", async () => {
    // LLM omits framework entirely; profile says "PACT2" → tool must see "PACT2"
    llmFrameworkValue = undefined;

    const payload = basePayload({
      agent_config: {
        system_prompt: "you are a sales agent",
        sdr_profile: {
          enabled: true,
          qualification_framework: "PACT2",
        },
      },
    });

    await handleExecution(payload, ctx());

    expect(capturedQualifyParams).not.toBeUndefined();
    const p = capturedQualifyParams as Record<string, unknown>;
    expect(p.framework).toBe("PACT2");
  });

  it("no sdr_profile → tool receives config default (PACT from env/config)", async () => {
    // With no sdr_profile, resolveQualificationFramework falls back to
    // getHarnessConfig().sdr.qualificationFramework (defaults to "PACT" in test env).
    llmFrameworkValue = "PACT2"; // LLM guesses PACT2, but no sdr_profile → config default wins

    const payload = basePayload({
      agent_config: {
        system_prompt: "you are a sales agent",
        // no sdr_profile key
      },
    });

    await handleExecution(payload, ctx());

    expect(capturedQualifyParams).not.toBeUndefined();
    const p = capturedQualifyParams as Record<string, unknown>;
    // Config default in test env is "PACT" (SDR_QUALIFICATION_FRAMEWORK not set → env default)
    expect(p.framework).toBe("PACT");
  });

  it("profile PACT2 beats config PACT (profile-over-config invariant)", async () => {
    // Explicitly: profile="PACT2", config default="PACT" → "PACT2"
    // (this is the same as case 1 but naming makes it explicit for the §7 spec)
    llmFrameworkValue = "PACT"; // LLM agrees with config default, but profile overrides

    const payload = basePayload({
      agent_config: {
        system_prompt: "you are a sales agent",
        sdr_profile: {
          enabled: true,
          qualification_framework: "PACT2",
        },
      },
    });

    await handleExecution(payload, ctx());

    expect(capturedQualifyParams).not.toBeUndefined();
    const p = capturedQualifyParams as Record<string, unknown>;
    expect(p.framework).toBe("PACT2");
  });

  it("override does NOT apply to other tools — other tools' params are untouched", async () => {
    // Even with sdr_profile.enabled + PACT2, the framework injection is
    // limited to qualify-opportunity only.
    llmFrameworkValue = "PACT";
    otherToolNameToCall = "send-message";

    const payload = basePayload({
      agent_config: {
        system_prompt: "you are a sales agent",
        sdr_profile: {
          enabled: true,
          qualification_framework: "PACT2",
        },
      },
    });

    await handleExecution(payload, ctx());

    // qualify-opportunity is overridden
    expect(capturedQualifyParams).not.toBeUndefined();
    const qp = capturedQualifyParams as Record<string, unknown>;
    expect(qp.framework).toBe("PACT2");

    // send-message is NOT mutated — it has no framework field, and none was injected
    expect(capturedOtherParams).not.toBeUndefined();
    const op = capturedOtherParams as Record<string, unknown>;
    expect(op).not.toHaveProperty("framework");
    expect(op.someField).toBe("value");
  });

  it("override does NOT apply when sdrProfile is undefined (non-SDR path — zero behavior change)", async () => {
    // No sdr_profile → no override, even for qualify-opportunity.
    // The tool sees the LLM-supplied params as-is (well, config default kicks in per case 3).
    // Key assertion: the non-SDR path does not throw, and capturedOtherParams not mutated.
    llmFrameworkValue = undefined;
    otherToolNameToCall = "send-message";

    const payload = basePayload({
      agent_config: {
        system_prompt: "you are a sales agent",
        // no sdr_profile
      },
    });

    await handleExecution(payload, ctx());

    // send-message params untouched on non-SDR path
    expect(capturedOtherParams).not.toBeUndefined();
    const op = capturedOtherParams as Record<string, unknown>;
    expect(op).not.toHaveProperty("framework");
    expect(op.someField).toBe("value");
  });
});
