/**
 * J8 backend-coupling — optional absolute `deadline_ms` read-side.
 *
 * Canon: APPROVED (bevox-knowledge #62 harness-proposal + #63 backend-edits).
 *
 * `deadline_ms` is an OPTIONAL absolute wall-clock deadline (epoch ms),
 * anchored to the BACKEND DB clock. When present and a valid positive number,
 * the harness PREFERS it over the locally-derived deadline
 * (`devStartTs + maxExecutionTimeMs`); when absent/invalid, behavior is
 * byte-identical to before (fallback).
 *
 * This suite pins both halves:
 *  - schema: the field parses/typing (present-future, present-past, invalid, absent);
 *  - behavior: a future deadline drives agentContext.deadlineMs; a PAST deadline
 *    fires the existing J8 deadline/abort path immediately → terminal
 *    aborted_timeout (ACK, exactly one /complete); absent → fallback unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import { createFakeRedis } from "../../fakes/redis.fake.js";
import { FakeLLMGateway } from "../../fakes/llm-gateway.fake.js";
import {
  executionPayloadSchema,
  parseExecutionPayload,
} from "../../../src/runtime/execution-handler.js";

// ---------------------------------------------------------------------------
// Part 1 — schema-level (no handler wiring needed)
// ---------------------------------------------------------------------------

const VALID_ORG_ID = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";

function base() {
  return {
    execution_id: "11111111-1111-4111-8111-111111111111",
    execution_token: "a-very-long-token-string-1234567890",
    organization_id: VALID_ORG_ID,
    messages: [{ role: "user" as const, content: "hi" }],
  };
}

describe("deadline_ms (J8 backend-coupling optional absolute deadline) — schema", () => {
  it("accepts a future absolute deadline_ms and carries it on the parsed payload", () => {
    const future = Date.now() + 60_000;
    const parsed = parseExecutionPayload({ ...base(), deadline_ms: future });
    expect(parsed.deadline_ms).toBe(future);
  });

  it("accepts a PAST absolute deadline_ms (already-past must not crash the schema)", () => {
    const past = Date.now() - 60_000;
    const parsed = parseExecutionPayload({ ...base(), deadline_ms: past });
    expect(parsed.deadline_ms).toBe(past);
  });

  it("absent → undefined (fallback to devStartTs + maxExecutionTimeMs)", () => {
    const parsed = parseExecutionPayload(base());
    expect(parsed.deadline_ms).toBeUndefined();
  });

  it("rejects a non-integer deadline_ms (epoch ms must be an int)", () => {
    expect(() => executionPayloadSchema.parse({ ...base(), deadline_ms: 1.5 })).toThrow();
  });

  it("rejects a zero/negative deadline_ms (must be positive)", () => {
    expect(() => executionPayloadSchema.parse({ ...base(), deadline_ms: 0 })).toThrow();
    expect(() => executionPayloadSchema.parse({ ...base(), deadline_ms: -1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — behavior (full handler wiring, mirrors execution-handler.flow.test)
// ---------------------------------------------------------------------------

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

const gatewayMock = vi.hoisted(() => ({ createLLMGateway: vi.fn() }));
const routerMock = vi.hoisted(() => ({ strategyRouter: { build: vi.fn() } }));
const configMock = vi.hoisted(() => ({ maxExecutionTimeMs: 120000, maxCostUsd: 0 }));

vi.mock("../../../src/integration/bevox-callback", () => callbackMock);
vi.mock("../../../src/integration/llm-gateway", async () => {
  const actual = await vi.importActual<typeof import("../../../src/integration/llm-gateway")>(
    "../../../src/integration/llm-gateway",
  );
  return { ...actual, createLLMGateway: gatewayMock.createLLMGateway };
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

class StubMessageAnalyzer extends BaseAgent {
  constructor() {
    super({
      name: "message-analyzer",
      type: "pipeline",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    } as AgentDefinition);
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
    } as AgentDefinition);
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return { success: true, output: "ok" };
  }
}

function freshRegistries() {
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
    organization_id: VALID_ORG_ID,
    messages: [{ role: "user", content: "Quero agendar um exame" }],
    ...over,
  };
}

describe("deadline_ms (J8 backend-coupling) — behavior", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;
  let gateway: FakeLLMGateway;
  // Captures the agentContext the surface engine is built with, so the test
  // can assert which deadlineMs was threaded.
  let observedDeadlineMs: number | undefined;

  beforeEach(async () => {
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    gatewayMock.createLLMGateway.mockReset();
    observedDeadlineMs = undefined;

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
    // Default: completes one quick step then synthesizes. Captures deadlineMs.
    routerMock.strategyRouter.build.mockImplementation(
      (_agent: unknown, agentContext: AgentExecutionContext) => {
        observedDeadlineMs = agentContext.deadlineMs;
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
      },
    );
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
    opts: { maxExecutionTimeMs?: number; maxCostUsd?: number } = {},
  ): Promise<{ handle: typeof handleExecution; run: Promise<void> }> {
    configMock.maxExecutionTimeMs = opts.maxExecutionTimeMs ?? 120000;
    configMock.maxCostUsd = opts.maxCostUsd ?? 0;
    vi.resetModules();
    const mod = await import("../../../src/runtime/execution-handler.js");
    return { handle: mod.handleExecution, run: mod.handleExecution(payload, ctx()) };
  }

  it("deadline_ms present + FUTURE → agentContext.deadlineMs uses the payload value (not the local derivation)", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    // A future deadline that is NOT what the local derivation would produce:
    // local would be ~now+120000; pick a far-future absolute value instead.
    const future = Date.now() + 5_000_000;
    const { run } = await handleWithBudget(basePayload({ deadline_ms: future }), {
      maxExecutionTimeMs: 120000,
    });
    await run;
    // Success path (deadline is far in the future → no abort).
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).not.toBe("aborted_timeout");
    // The exact absolute payload value was threaded (proves preference over fallback).
    expect(observedDeadlineMs).toBe(future);
  });

  it("deadline_ms present + PAST → existing J8 deadline/abort path fires immediately → terminal aborted_timeout (ACK + one /complete, dedup RETAINED)", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const dedupKey = `harness:dedup:${VALID_UUID}`;
    const past = Date.now() - 60_000;
    // Generous local budget so the ONLY thing that can abort is the absolute
    // past deadline (proves the past deadline — not the phase wrapper — fired).
    const { run } = await handleWithBudget(basePayload({ deadline_ms: past }), {
      maxExecutionTimeMs: 120000,
    });
    // Abort is TERMINAL: handler ACKs (resolves WITHOUT rethrowing) → no retry.
    await expect(run).resolves.toBeUndefined();
    // Exactly ONE terminal /complete with aborted_timeout.
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).toBe("aborted_timeout");
    // The PAST absolute deadline was the one threaded.
    expect(observedDeadlineMs).toBe(past);
    // Terminal abort RETAINS the dedup key (re-deliver absorbed by SET NX).
    expect(await redis.get(dedupKey)).not.toBeNull();
  });

  it("deadline_ms present + PAST does NOT spend a surface LLM step (immediate gate)", async () => {
    let steps = 0;
    routerMock.strategyRouter.build.mockImplementation(
      (_agent: unknown, agentContext: AgentExecutionContext) => {
        observedDeadlineMs = agentContext.deadlineMs;
        return {
          strategy: "direct" as const,
          async plan() {
            return { goal: "g", steps: [], estimatedComplexity: "low" as const };
          },
          async step() {
            steps += 1;
            return { stepIndex: 0, success: true, durationMs: 1 };
          },
          async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
            return { stepIndex: 0, summary: "x", success: true, raw: sr };
          },
          async shouldContinue() {
            return true; // would loop forever if the gate did not trip
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
        };
      },
    );
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const past = Date.now() - 60_000;
    const { run } = await handleWithBudget(basePayload({ deadline_ms: past }), {
      maxExecutionTimeMs: 120000,
    });
    await expect(run).resolves.toBeUndefined();
    // Gate trips at the TOP of the loop, before the first step → zero steps run.
    expect(steps).toBe(0);
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).toBe("aborted_timeout");
  });

  it("deadline_ms ABSENT → fallback unchanged: deadlineMs ≈ now + maxExecutionTimeMs, success path", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const before = Date.now();
    const { run } = await handleWithBudget(basePayload(), { maxExecutionTimeMs: 120000 });
    await run;
    const after = Date.now();
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).not.toBe("aborted_timeout");
    // Fallback = devStartTs + maxExecutionTimeMs; devStartTs is within [before, after].
    expect(observedDeadlineMs).toBeGreaterThanOrEqual(before + 120000);
    expect(observedDeadlineMs).toBeLessThanOrEqual(after + 120000);
  });

  it("deadline_ms ABSENT + tiny budget → unchanged phase_timeout path (aborted_timeout via wrapper)", async () => {
    // Never-stopping engine + tiny budget: the phase wrapper fires (NOT the
    // absolute gate, which is unreachable in the fallback path). Proves the
    // fallback behavior is byte-identical regardless of the new gate.
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
    const { run } = await handleWithBudget(basePayload(), { maxExecutionTimeMs: 20 });
    await expect(run).resolves.toBeUndefined();
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).toBe("aborted_timeout");
  });

  it("deadline_ms invalid (zero) is rejected by the schema → poison rethrow pre-dispatch, no callbacks (no work)", async () => {
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    // 0 fails the positive() guard → payload rejected pre-dispatch → no work.
    // J3 dead-letter contract: an unprocessable payload RETHROWS
    // `UnprocessablePayloadError` (the failed listener owns the dead-letter
    // signal); the handler itself emits NO callback. Intent preserved: the
    // zero deadline is schema-rejected before any work or callback.
    await expect(
      handleExecution(basePayload({ deadline_ms: 0 }), ctx()),
    ).rejects.toBeInstanceOf(UnprocessablePayloadError);
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
    expect(callbackMock.sendComplete).not.toHaveBeenCalled();
  });
});
