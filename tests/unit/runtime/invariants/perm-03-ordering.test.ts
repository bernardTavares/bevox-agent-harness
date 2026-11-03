/**
 * PERM-03 — Ordering invariant: audit-before-callback.
 *
 * The runtime invariant under test (audit ref: runtime-gap-audit-2026-06-02
 * §PERM-03): when the surface-agent executor invokes a mutation tool, the
 * `permission_audit` row MUST be emitted BEFORE the terminal `/complete`
 * callback. If `sendComplete` throws, the audit row must already be
 * persisted — otherwise post-mortem forensics on a half-applied mutation
 * has no trail of what was attempted.
 *
 * Regression guard, not bug-discovery: behavior is currently correct (the
 * executor at execution-handler.ts:~1851 emits the audit synchronously
 * after `tool.execute(...)` returns, BEFORE the surface loop returns its
 * observations and well before the post-loop `sendComplete` at ~1965).
 * This test pins the ordering so a future refactor that defers audit
 * emission (e.g. batching at end of execution) trips the build.
 *
 * Mechanism: use `vi.fn().mock.invocationCallOrder` — vitest's global
 * monotonic counter assigned to every mock invocation across the test —
 * to assert the audit's first invocation has a lower order number than
 * sendComplete's first invocation.
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

// Hoisted mocks — same conventions as execution-handler.flow.test.ts.
// NOTE on extraction: vitest forbids exporting `vi.hoisted` values from a
// helper module AND hoists `vi.hoisted` blocks above top-level imports, so
// these three mocks cannot live in `invariant-harness.ts`. The stub agents,
// fresh-registries, and basePayload helpers ARE extracted there.
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

// PERM-03: hoisted audit mock. `emitExecutionAudit` is the call we time
// against `sendComplete` using `mock.invocationCallOrder`. `sanitizeAuditDetails`
// is pass-through (the handler calls it on tool params before emitting).
const auditMock = vi.hoisted(() => ({
  emitExecutionAudit: vi.fn(),
  sanitizeAuditDetails: (x: Record<string, unknown>) => x,
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
vi.mock("../../../../src/security/execution-audit", () => auditMock);

import {
  handleExecution,
  type ExecutionContext,
} from "../../../../src/runtime/execution-handler.js";
import { AgentRegistry } from "../../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../../../src/runtime/agent-router.js";
import type { AgentExecutionContext } from "../../../../src/agents/execution-context.js";
import type { ToolDefinition } from "../../../../src/tools/types.js";

// Minimal stub of the `waitlist-add` mutation tool. The runtime treats any
// tool whose name is in MUTATION_TOOL_NAMES (closed set in execution-handler.ts
// ~85) as a mutation; the actual side-effect is irrelevant for ordering.
function makeWaitlistAddStub(): ToolDefinition {
  return {
    name: "waitlist-add",
    description: "stub waitlist add",
    category: "calendar",
    agentType: "surface",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { success: true as const, data: { ok: true } };
    },
  };
}

describe("PERM-03 ordering invariant — audit before /complete callback", () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let db: Pool;
  let agentRegistry: AgentRegistry;
  let toolRegistry: UnifiedToolRegistry;
  let gateway: FakeLLMGateway;

  beforeEach(async () => {
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    auditMock.emitExecutionAudit.mockClear();
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

    // Mock engine: step() calls executeTool("waitlist-add", ...) so the
    // mutation-tool audit path at execution-handler.ts:~1841 fires.
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
          // Trigger the audit path: a mutation tool must be invoked through the
          // surface-loop executor (NOT directly), so the runtime emits the
          // PERM-03 audit row.
          await executeTool(
            "waitlist-add",
            { calendar_id: "cal-1", customer_name: "Alice" },
            context,
          );
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
    // Surface agent NEEDS the mutation tool in its `permissions.required` list
    // so the runtime permission gate (filterPermittedTools) allows it through;
    // otherwise the executor returns PERMISSION_DENIED and the tool never runs,
    // and emitExecutionAudit is never called.
    agentRegistry.register(new StubSurfaceAgent(["waitlist-add"]));
    toolRegistry.registerToolDefinition(makeWaitlistAddStub());
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

  it("audit is written even when sendComplete throws", async () => {
    // Make the terminal /complete reject. The mutation tool ran BEFORE this
    // point, so emitExecutionAudit must already have fired. If a future
    // refactor defers audit emission to after sendComplete, the invocation
    // order assertion below trips.
    callbackMock.sendComplete.mockRejectedValue(new Error("backend down"));

    await expect(
      handleExecution(
        basePayload({ messages: [{ role: "user", content: "Coloque-me na lista de espera" }] }),
        ctx(),
      ),
    ).rejects.toThrow(/backend down/);

    // The mutation tool fired → audit emitted at least once.
    expect(auditMock.emitExecutionAudit).toHaveBeenCalled();
    expect(callbackMock.sendComplete).toHaveBeenCalled();

    // Pin the ordering invariant: the FIRST audit emission must happen
    // BEFORE the FIRST sendComplete invocation. `invocationCallOrder` is
    // vitest's global monotonic counter — same scale across all mocks.
    const firstAudit = auditMock.emitExecutionAudit.mock.invocationCallOrder[0];
    const firstSendComplete = callbackMock.sendComplete.mock.invocationCallOrder[0];
    expect(firstAudit).toBeDefined();
    expect(firstSendComplete).toBeDefined();
    expect(firstAudit).toBeLessThan(firstSendComplete as number);

    // Double-check we audited the mutation tool specifically (not some
    // unrelated escalation audit firing first).
    const auditCalls = auditMock.emitExecutionAudit.mock.calls;
    const mutationAudit = auditCalls.find(
      (call) =>
        (call[0] as { toolName?: string })?.toolName === "waitlist-add" &&
        (call[0] as { actionType?: string })?.actionType === "mutation_execution",
    );
    expect(mutationAudit).toBeDefined();
  });
});
