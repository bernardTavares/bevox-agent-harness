import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import { createFakeRedis } from "../../fakes/redis.fake.js";
import { FakeLLMGateway } from "../../fakes/llm-gateway.fake.js";

// Hoisted mocks for bevox-callback and llm-gateway factory
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

const routerMock = vi.hoisted(() => ({
  strategyRouter: { build: vi.fn() },
}));
const configMock = vi.hoisted(() => ({
  maxExecutionTimeMs: 120000,
  maxCostUsd: 0,
}));

vi.mock("../../../src/integration/bevox-callback", () => callbackMock);
vi.mock("../../../src/integration/llm-gateway", async () => {
  const actual = await vi.importActual<typeof import("../../../src/integration/llm-gateway")>(
    "../../../src/integration/llm-gateway",
  );
  return {
    ...actual,
    createLLMGateway: gatewayMock.createLLMGateway,
  };
});
vi.mock("../../../src/reasoning/strategy-router", () => ({
  strategyRouter: routerMock.strategyRouter,
}));
vi.mock("../../../src/config/harness-config", async () => {
  const actual = await vi.importActual<typeof import("../../../src/config/harness-config")>(
    "../../../src/config/harness-config",
  );
  return {
    ...actual,
    getHarnessConfig: () => ({
      ...actual.getHarnessConfig(),
      harness: {
        ...actual.getHarnessConfig().harness,
        maxExecutionTimeMs: configMock.maxExecutionTimeMs,
        maxCostUsd: configMock.maxCostUsd,
      },
    }),
  };
});

import {
  handleExecution,
  UnprocessablePayloadError,
  type ExecutionContext,
} from "../../../src/runtime/execution-handler.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../../src/runtime/agent-router.js";
import { BaseAgent } from "../../../src/agents/base-agent.js";
import type { AgentDefinition, AgentResult } from "../../../src/agents/types.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";

// ---------------------------------------------------------------------------
// Test agent implementations — simple stubs registered into fresh registries
// ---------------------------------------------------------------------------

class StubMessageAnalyzer extends BaseAgent {
  constructor() {
    super({
      name: "message-analyzer",
      type: "pipeline",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    });
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return {
      success: true,
      output: {
        intent: "scheduling",
        sentiment: "positive",
        sentimentConfidence: 0.9,
        topics: ["appointment"],
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
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    });
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return { success: true, output: "ok" };
  }
}

function freshRegistries() {
  // Reset singletons via private map mutation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (AgentRegistry as any).instance = undefined;
  UnifiedToolRegistry.resetForTests();
  return {
    agentRegistry: AgentRegistry.getInstance(),
    toolRegistry: UnifiedToolRegistry.getInstance(),
  };
}

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const VALID_TOKEN = "a-very-long-token-value-1234567890";

function basePayload(over: Record<string, unknown> = {}) {
  return {
    execution_id: VALID_UUID,
    execution_token: VALID_TOKEN,
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    messages: [{ role: "user", content: "Quero agendar um exame" }],
    ...over,
  };
}

describe("handleExecution", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;
  let gateway: FakeLLMGateway;

  beforeEach(async () => {
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    gatewayMock.createLLMGateway.mockReset();

    gateway = new FakeLLMGateway({
      defaultResponse: {
        content: "Final answer",
        tool_calls: [],
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        model: "fake-model",
        provider: "fake",
        latency_ms: 1,
      },
    });
    gatewayMock.createLLMGateway.mockReturnValue(gateway);

    routerMock.strategyRouter.build.mockReset();
    routerMock.strategyRouter.build.mockImplementation(() => {
      let stepped = false;
      return {
        strategy: "direct" as const,
        async plan() {
          return { goal: "g", steps: [], estimatedComplexity: "low" as const };
        },
        async step() {
          stepped = true;
          return { stepIndex: 0, success: true, durationMs: 1 };
        },
        async observe(stepResult: { stepIndex: number; success: boolean; durationMs: number }) {
          return { stepIndex: 0, summary: "ok", success: true, raw: stepResult, stopSignal: true };
        },
        async shouldContinue() {
          return !stepped; // run exactly one step then stop
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
    configMock.maxExecutionTimeMs = 120000;
    configMock.maxCostUsd = 0;

    redis = createFakeRedis();
    await redis.flushall();
    db = { query: vi.fn(), connect: vi.fn() } as unknown as Pool;

    const r = freshRegistries();
    agentRegistry = r.agentRegistry;
    toolRegistry = r.toolRegistry;
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

  async function handleWithBudget(
    payload: Record<string, unknown>,
    opts: { maxExecutionTimeMs?: number; maxCostUsd?: number },
  ): Promise<{ handle: typeof handleExecution; run: Promise<void> }> {
    configMock.maxExecutionTimeMs = opts.maxExecutionTimeMs ?? 120000;
    configMock.maxCostUsd = opts.maxCostUsd ?? 0;
    vi.resetModules();
    const mod = await import("../../../src/runtime/execution-handler.js");
    return { handle: mod.handleExecution, run: mod.handleExecution(payload, ctx()) };
  }

  it("rethrows on invalid payload (no callbacks from the handler — failed listener owns the signal)", async () => {
    await expect(handleExecution({ bad: "payload" }, ctx())).rejects.toBeInstanceOf(
      UnprocessablePayloadError,
    );
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
    expect(callbackMock.sendComplete).not.toHaveBeenCalled();
  });

  it("deduplicates: second call with same execution_id is skipped", async () => {
    // Pre-occupy dedup key
    await redis.set(`harness:dedup:${VALID_UUID}`, "1");
    await handleExecution(basePayload(), ctx());
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
    expect(callbackMock.sendComplete).not.toHaveBeenCalled();
  });

  it("falls back to request-human when no surface agent is registered", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    await handleExecution(basePayload(), ctx());
    expect(callbackMock.updateStatus).toHaveBeenCalledWith(VALID_UUID, VALID_TOKEN, "running");
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const completePayload = callbackMock.sendComplete.mock.calls[0]?.[2] as {
      strategy: string;
    };
    expect(completePayload.strategy).toBe("request-human");
  });

  it("runs full pipeline → router → surface → complete callback", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    await handleExecution(basePayload(), ctx());

    expect(callbackMock.updateStatus).toHaveBeenCalledWith(VALID_UUID, VALID_TOKEN, "running");
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();

    const completePayload = callbackMock.sendComplete.mock.calls[0]?.[2] as {
      response_text: string;
      sentiment: string;
      strategy?: string;
    };
    expect(completePayload.sentiment).toBe("positive");
    expect(completePayload.response_text).toBeDefined();
  });

  it("sends a failure complete callback when updateStatus throws (error boundary)", async () => {
    callbackMock.updateStatus.mockRejectedValueOnce(new Error("bevox unreachable"));
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    await expect(handleExecution(basePayload(), ctx())).rejects.toThrow(/bevox unreachable/);
    // sendComplete called with failed strategy (error boundary)
    expect(callbackMock.sendComplete).toHaveBeenCalled();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).toBe("failed");
  });

  // C12 (auditoria 2026-06-02): retry após falha
  it("clears dedup key in error path so BullMQ retry can re-execute (C12)", async () => {
    callbackMock.updateStatus.mockRejectedValueOnce(new Error("bevox unreachable"));
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const dedupKey = `harness:dedup:${VALID_UUID}`;
    await expect(handleExecution(basePayload(), ctx())).rejects.toThrow(/bevox unreachable/);
    // Dedup key gone → retry com mesmo execution_id pode re-acquire NX.
    expect(await redis.get(dedupKey)).toBeNull();
    // Confirma que um SET NX subsequente (retry) sucede:
    const reacquired = await redis.set(dedupKey, "1", "EX", 3600, "NX");
    expect(reacquired).toBe("OK");
  });

  it("preserves dedup key on successful execution (no early TTL break)", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const dedupKey = `harness:dedup:${VALID_UUID}`;
    await handleExecution(basePayload(), ctx());
    // Success → dedup permanece (TTL natural; bloqueia entrega duplicada legítima).
    expect(await redis.get(dedupKey)).not.toBeNull();
  });

  it("writes a session record under harness:session:<id>", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    await handleExecution(basePayload(), ctx());
    const raw = await redis.get(`harness:session:${VALID_UUID}`);
    expect(raw).not.toBeNull();
    const session = JSON.parse(raw as string);
    expect(session.state.status).toBe("completed");
  });

  it("rejects a payload missing organization_id (ADR-019: sole tenant id, no account fallback)", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const payload = basePayload({ organization_id: undefined });
    // Poison payload → rethrow (failed set + dead_letter signal), no silent return.
    await expect(handleExecution(payload, ctx())).rejects.toBeInstanceOf(
      UnprocessablePayloadError,
    );
    // Rethrow happens before session creation → no session written.
    const raw = await redis.get(`harness:session:${VALID_UUID}`);
    expect(raw).toBeNull();
  });

  it("uses scheduler fallback when no router injected", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const baseCtx = ctx();
    baseCtx.agentRouter = undefined;
    await handleExecution(basePayload(), baseCtx);
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
  });

  it("continues even if MemoryExtractor fails (non-fatal)", async () => {
    class FailingExtractor extends BaseAgent {
      constructor() {
        super({
          name: "memory-extractor",
          type: "pipeline",
          description: "t",
          reasoning: { default: "direct" },
          permissions: { required: [], denied: [] },
        });
      }
      async execute(): Promise<AgentResult> {
        throw new Error("extract boom");
      }
    }
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new FailingExtractor());
    agentRegistry.register(new StubSurfaceAgent());
    await handleExecution(basePayload(), ctx());
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy?: string };
    // surface agent ran, not request-human
    expect(last.strategy).not.toBe("request-human");
  });

  it("aborts on wall-clock budget (J8) → phase_timeout wrapper → terminal aborted_timeout, handler ACKs", async () => {
    // Engine that never stops and sleeps past the tiny budget each step. The
    // REAL wall-clock guarantee is the runWithTimeout(surfaceLoop,
    // maxExecutionTimeMs/2) wrapper: it fires first and rejects with
    // ExecutionAbortError("phase_timeout") → terminal outcome aborted_timeout.
    // (The old cooperative deadlineMs gate is gone; no wall_clock_timeout
    // reason is produced anymore.)
    routerMock.strategyRouter.build.mockImplementation(() => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        await new Promise((r) => setTimeout(r, 30));
        return { stepIndex: 0, success: true, durationMs: 30 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: 0, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true; // never voluntarily stops → the phase wrapper must abort
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: 0,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));

    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const dedupKey = `harness:dedup:${VALID_UUID}`;
    const { run } = await handleWithBudget(basePayload(), { maxExecutionTimeMs: 20 });
    // Abort is TERMINAL: the handler ACKs (resolves WITHOUT rethrowing) so
    // BullMQ marks the job a success → ZERO retries of a doomed execution.
    await expect(run).resolves.toBeUndefined();

    // Exactly ONE terminal /complete emitted (backend does not see a stall).
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).toBe("aborted_timeout");
    // Abort RETAINS the dedup key (terminal; any same-id re-deliver hits SET NX).
    expect(await redis.get(dedupKey)).not.toBeNull();
  });

  it("aborts on cost ceiling (J9) AFTER the offending step, no extra step, dedup RETAINED", async () => {
    let steps = 0;
    routerMock.strategyRouter.build.mockImplementation((_agent, agentContext) => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        steps += 1;
        // Drive the running cost past the ceiling on the FIRST step.
        if (agentContext.costAccumulator) agentContext.costAccumulator.costCents += 200;
        return { stepIndex: steps - 1, success: true, durationMs: 1 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: sr.stepIndex, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true;
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: steps,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));

    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const dedupKey = `harness:dedup:${VALID_UUID}`;
    // ceiling 1 USD = 100 cents; the first step pushes cost to 200c.
    const { run } = await handleWithBudget(basePayload({ max_cost_usd: 1 }), {
      maxExecutionTimeMs: 120000,
    });
    // Abort is TERMINAL: the handler ACKs (resolves WITHOUT rethrowing) → no
    // BullMQ retry of an execution that would deterministically re-abort.
    await expect(run).resolves.toBeUndefined();

    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).toBe("aborted_cost");
    // The gate runs at the TOP of the loop: step 1 runs (pushes cost), the loop
    // re-enters, the gate trips, no step 2. So exactly 1 step executed.
    expect(steps).toBe(1);
    // cost_ceiling is terminal → dedup key RETAINED (re-deliver absorbed by SET NX).
    expect(await redis.get(dedupKey)).not.toBeNull();
  });

  it("synthesize timeout (J8-b) → phase_timeout → terminal aborted_timeout, handler ACKs", async () => {
    routerMock.strategyRouter.build.mockImplementation(() => {
      let stepped = false;
      return {
        strategy: "direct" as const,
        async plan() {
          return { goal: "g", steps: [], estimatedComplexity: "low" as const };
        },
        async step() {
          stepped = true;
          return { stepIndex: 0, success: true, durationMs: 1 };
        },
        async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
          return { stepIndex: 0, summary: "ok", success: true, raw: sr, stopSignal: true };
        },
        async shouldContinue() {
          return !stepped; // one quick step, then exit loop → reach synthesize
        },
        async synthesize() {
          await new Promise((r) => setTimeout(r, 50)); // hang past the remaining budget
          return {
            answer: "late",
            observations: [],
            totalSteps: 1,
            strategy: "direct" as const,
            escalated: false,
            retriesUsed: 0,
          };
        },
      };
    });

    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const { run } = await handleWithBudget(basePayload(), { maxExecutionTimeMs: 30 });
    // phase_timeout from the synthesize wrapper is a TERMINAL abort → the
    // handler ACKs (resolves WITHOUT rethrowing), emitting one /complete.
    await expect(run).resolves.toBeUndefined();
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    // phase_timeout from the synthesize wrapper → aborted_timeout.
    expect(last.strategy).toBe("aborted_timeout");
  });

  it("emits exactly ONE /complete on a cost-ceiling abort (no double-complete)", async () => {
    routerMock.strategyRouter.build.mockImplementation((_agent, agentContext) => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        if (agentContext.costAccumulator) agentContext.costAccumulator.costCents += 500;
        return { stepIndex: 0, success: true, durationMs: 1 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: 0, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true;
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: 1,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const { run } = await handleWithBudget(basePayload({ max_cost_usd: 1 }), {
      maxExecutionTimeMs: 120000,
    });
    // Terminal abort → handler ACKs (resolves), exactly ONE /complete.
    await expect(run).resolves.toBeUndefined();
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(1);
  });

  it("cost_ceiling re-deliver is absorbed by SET NX (silent return, no second /complete)", async () => {
    routerMock.strategyRouter.build.mockImplementation((_agent, agentContext) => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        if (agentContext.costAccumulator) agentContext.costAccumulator.costCents += 500;
        return { stepIndex: 0, success: true, durationMs: 1 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: 0, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true;
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: 1,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const { handle, run } = await handleWithBudget(basePayload({ max_cost_usd: 1 }), {
      maxExecutionTimeMs: 120000,
    });
    // first delivery (the run handleWithBudget already launched): terminal
    // abort → handler ACKs (resolves), RETAINS the dedup key.
    await expect(run).resolves.toBeUndefined();
    callbackMock.sendComplete.mockClear();
    // re-delivery of the SAME execution_id: SET NX returns null → silent return
    await handle(basePayload({ max_cost_usd: 1 }), ctx());
    expect(callbackMock.sendComplete).not.toHaveBeenCalled();
  });

  it("Redis-down in the abort boundary still emits the terminal /complete (no stall)", async () => {
    routerMock.strategyRouter.build.mockImplementation(() => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        await new Promise((r) => setTimeout(r, 30));
        return { stepIndex: 0, success: true, durationMs: 30 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: 0, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true;
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: 0,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    // Simulate Redis-down DURING the abort boundary cleanup: the boundary
    // persists the failed session state via sessionStore.update({status:
    // "failed"}) → redis.set(...). Reject only that write (delegate every
    // other set, e.g. the dedup acquire + session create, to the real fake).
    // The boundary wraps the update in .catch(() => {}), so the terminal
    // /complete must still go out and the handler must still ACK (no stall).
    const realSet = redis.set.bind(redis);
    const setSpy = vi
      .spyOn(redis, "set")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((...args: any[]) => {
        const value = args[1];
        if (typeof value === "string" && value.includes('"status":"failed"')) {
          return Promise.reject(new Error("redis down")) as never;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realSet as any)(...args);
      });
    const { run } = await handleWithBudget(basePayload(), { maxExecutionTimeMs: 20 });
    // The Redis-down write is swallowed (.catch) and the abort stays terminal:
    // the handler ACKs (resolves WITHOUT rethrowing).
    await expect(run).resolves.toBeUndefined();
    // Terminal /complete still went out (backend sees no stall).
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    setSpy.mockRestore();
  });
});
