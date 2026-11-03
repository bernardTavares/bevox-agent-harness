/**
 * OTel root span hierarchy invariant (PRD §12.14).
 *
 * The runtime invariant under test: a single execution produces exactly ONE
 * root OTel span — the one opened by `handleExecution` via
 * `withSpan("execution.handle", { "execution.id": ... }, ...)` at
 * execution-handler.ts:1117 — and every other span emitted during that
 * execution (`execution.dedup`, `execution.session.create`,
 * `execution.message-analyzer`, `execution.surface`, tool calls, llm calls,
 * `execution.callback.complete`, etc.) MUST be a descendant of that root,
 * sharing its `traceId`. This is the spine that lets ops correlate a single
 * execution end-to-end in an OTLP backend: search by `execution.id` finds
 * the root, expanding the trace shows the full pipeline.
 *
 * Concretely the contract is:
 *   1. Exactly one span in the exported set has no `parentSpanContext` (or a
 *      parent that is not also in the set) — the root.
 *   2. The root span is named `execution.handle` and has an `execution.id`
 *      attribute matching the payload's `execution_id`.
 *   3. At least one child span exists whose parent links back to the root
 *      (via `parentSpanContext.spanId === root.spanContext().spanId`).
 *   4. All emitted spans share the root's `traceId` — i.e. no orphan trace
 *      gets opened mid-execution under a fresh root (a regression class
 *      where someone calls `tracer.startSpan` without an active context).
 *
 * The PRD-canonical span family includes `pipeline` / `routing` /
 * `surface_loop` / `step` / `tool` / `llm`, but the handler's actual names
 * differ (`execution.message-analyzer` for pipeline, `execution.router` for
 * routing, etc.). We deliberately do NOT lock the assertion to specific
 * child names — those are handler internals that may legitimately rename
 * without breaking the observability contract. The invariant is the
 * *shape* (one root + descendants under one traceId), not the labels.
 *
 * Test strategy:
 *   - Register a `BasicTracerProvider` + `InMemorySpanExporter` as the
 *     global tracer provider via `trace.setGlobalTracerProvider(...)`
 *     BEFORE `handleExecution` runs. The global OTel API uses a
 *     `ProxyTracerProvider` that resolves its delegate at span-start time
 *     (not at `trace.getTracer()` time), so registration inside `beforeAll`
 *     is sufficient — the handler's pre-existing `getTracer()` calls bind
 *     to the new delegate on the next `startActiveSpan`.
 *   - Use `SimpleSpanProcessor` (sync) so ended spans land in the exporter
 *     immediately, no flush dance needed.
 *   - Drive a nominal success-path execution (same stubs as the sibling
 *     invariant tests: callback mock, gateway mock, router mock).
 *   - Assert hierarchy via `spanContext().traceId` equality + parent chain.
 *
 * Why not deeper:
 *   - Asserting every canonical span name (`execution.dedup`,
 *     `execution.session.create`, `execution.router`, ...) would lock the
 *     test to the current handler decomposition. A future refactor that
 *     legitimately renames `execution.router` → `execution.routing` would
 *     break this test for no observability-contract reason.
 *   - Asserting span timings / orderings would couple the test to the
 *     handler's control flow. The PRD §12.14 contract is correlation, not
 *     ordering.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { createFakeRedis } from "../../../fakes/redis.fake.js";
import { FakeLLMGateway } from "../../../fakes/llm-gateway.fake.js";
import {
  StubMessageAnalyzer,
  StubSurfaceAgent,
  freshRegistries,
  basePayload,
  VALID_UUID,
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

describe("OTel root span hierarchy invariant — single rooted trace correlated by execution.id", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;
  let gateway: FakeLLMGateway;
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeAll(() => {
    // Register a real in-memory tracer provider as the global. The global
    // OTel API uses a ProxyTracerProvider whose delegate resolves at
    // span-start time, so this affects all subsequent `withSpan(...)` calls
    // — including those made by the handler module that was already
    // imported above.
    //
    // We MUST also register an `AsyncLocalStorageContextManager` —
    // otherwise the default `NoopContextManager` discards the active-span
    // context across every `await` boundary, every span looks like a root,
    // and the parent/child invariant becomes untestable. The production
    // tracer (`src/observability/tracer.ts`) gets this for free via
    // `NodeSDK` which auto-registers the context manager; here we wire it
    // by hand because we're using the lighter `BasicTracerProvider`.
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    contextManager.disable();
    // Best-effort: restore proxy provider + noop context manager so tests
    // in the same vitest worker that may run after us don't inherit our
    // global tracing wiring.
    context.disable();
    trace.disable();
  });

  beforeEach(async () => {
    exporter.reset();
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

  it("emits one root span (execution.handle) carrying execution.id, with all other spans descended under the same traceId", async () => {
    await handleExecution(basePayload(), ctx());

    const spans = exporter.getFinishedSpans();

    // Sanity: the execution actually opened spans. An empty exporter would
    // silently pass every hierarchical assertion below, so guard explicitly.
    expect(spans.length).toBeGreaterThan(1);

    // ── Root identification ──────────────────────────────────────────────
    // The root is the span whose parent is either absent OR points outside
    // the exported set. In a self-contained execution test there's no
    // outside parent, so "absent" is the realistic case — but we accept
    // both shapes to stay robust to a future wrapper span.
    const spanIds = new Set(spans.map((s) => s.spanContext().spanId));
    const roots = spans.filter((s) => {
      const parentId = s.parentSpanContext?.spanId;
      return !parentId || !spanIds.has(parentId);
    });

    expect(roots).toHaveLength(1);
    const root = roots[0]!;

    // The root must be the handler's `execution.handle` span (the
    // canonical entrypoint at execution-handler.ts:1117). If a future
    // refactor wraps it in a higher-level span, this assertion would
    // catch the loss of the `execution.id` attribute on the new root.
    expect(root.name).toBe("execution.handle");
    expect(root.attributes["execution.id"]).toBe(VALID_UUID);

    // ── Single trace correlation ─────────────────────────────────────────
    // Every span emitted during the execution must live under the root's
    // traceId. A span with a different traceId means someone called
    // `tracer.startSpan` outside the active context — a regression class
    // that breaks end-to-end trace correlation in the OTLP backend.
    const rootTraceId = root.spanContext().traceId;
    for (const s of spans) {
      expect(s.spanContext().traceId).toBe(rootTraceId);
    }

    // ── Parent chain (at least one direct child) ─────────────────────────
    // Beyond shared traceId, prove that ≥1 child span actually points to
    // the root via parentSpanContext.spanId. This rules out the
    // pathological case where every span shares a traceId but they're all
    // unrelated siblings (which can't happen with `startActiveSpan`, but
    // the assertion documents the contract).
    const directChildren = spans.filter(
      (s) => s.parentSpanContext?.spanId === root.spanContext().spanId,
    );
    expect(directChildren.length).toBeGreaterThan(0);
  });
});
