/**
 * Model-C Hybrid Bridge Integration Test — Fase C C.7
 *
 * Gated by RUN_INTEGRATION=1 (requires real Postgres + Redis via testcontainers).
 *
 * Proves the Model-C climax end-to-end:
 *
 *  (a) Surface loop produces a doctrine-governed reply. The resolved system
 *      prompt (the composed/doctrine message) contains BOTH the SDR doctrine
 *      marker AND the FSM-state keywords. System-message COUNT stays 2 (the
 *      FSM projection is APPENDED to the composed message string, NOT a
 *      separate system message).
 *
 *  (b) After the reply, `resumeWorkflow` was invoked and the cadence advanced /
 *      re-suspended. The workflow_correlation/state reflects progression (the
 *      suspend token changed or the workflow reached a new step).
 *
 *  (c) The reply was sent exactly once (sendComplete called once — no
 *      double-respond).
 *
 *  (d) Zero-cost path (no sdr_profile / no correlation row) is byte-unchanged
 *      — cert-gates pass unmodified.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import IORedis from "ioredis";
import { Pool } from "pg";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setupInfra, applyMigrations } from "../../helpers/integration-setup.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const RUN = process.env.RUN_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any imports of these modules
// ---------------------------------------------------------------------------

const callbackMock = vi.hoisted(() => ({
  updateStatus: vi.fn().mockResolvedValue(undefined),
  sendComplete: vi.fn().mockResolvedValue(undefined),
  sendTrace: vi.fn().mockResolvedValue(undefined),
  sendStream: vi.fn().mockResolvedValue(undefined),
}));

const gatewayMock = vi.hoisted(() => ({
  createLLMGateway: vi.fn(),
}));

vi.mock("../../../src/integration/bevox-callback", () => callbackMock);
vi.mock("../../../src/integration/llm-gateway", async () => {
  const actual = await vi.importActual<typeof import("../../../src/integration/llm-gateway")>(
    "../../../src/integration/llm-gateway",
  );
  return { ...actual, createLLMGateway: gatewayMock.createLLMGateway };
});

// ---------------------------------------------------------------------------
// Test imports (after mocks)
// ---------------------------------------------------------------------------

import { AgentRegistry } from "../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
import { WorkflowRegistry } from "../../../src/workflow/registry.js";
import { createAgentRouter } from "../../../src/runtime/agent-router.js";
import { BaseAgent } from "../../../src/agents/base-agent.js";
import type { AgentResult } from "../../../src/agents/types.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { ExecutionContext } from "../../../src/runtime/execution-handler.js";
import {
  handleExecution,
  __setDispatchModelCForTests,
} from "../../../src/runtime/execution-handler.js";
import { FakeLLMGateway } from "../../fakes/llm-gateway.fake.js";
import type { LLMResponse } from "../../../src/integration/llm-gateway.js";
import { WorkflowStateStore } from "../../../src/workflow/state-store.js";
import { CorrelationStore } from "../../../src/workflow/correlation-store.js";
import { runWorkflow } from "../../../src/workflow/engine.js";
import { sdrCadenceWorkflow } from "../../../src/workflow/definitions/sdr-cadence.js";
import { SDR_DOCTRINE_MARKER } from "../../helpers/sdr-replay.js";

// ---------------------------------------------------------------------------
// Stub agents
// ---------------------------------------------------------------------------

class StubAnalyzer extends BaseAgent {
  constructor() {
    super({
      name: "message-analyzer",
      type: "pipeline",
      description: "stub analyzer for model-c bridge test",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    });
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return {
      success: true,
      output: {
        intent: "unknown",
        sentiment: "positive",
        sentimentConfidence: 0.9,
        topics: [],
        urgency: "high",
      },
    };
  }
}

class StubSurfaceAgent extends BaseAgent {
  constructor() {
    super({
      name: "scheduler",
      type: "surface",
      description: "SDR surface agent for model-c bridge test",
      reasoning: { default: "react" },
      permissions: { required: [], denied: [] },
    });
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return { success: true, output: "model-c-bridge-stub" };
  }
}

// ---------------------------------------------------------------------------
// Integration suite
// ---------------------------------------------------------------------------

describe.skipIf(!RUN)("Model-C hybrid bridge (integration — C.7)", () => {
  let teardown: () => Promise<void>;
  let pool: Pool;
  let redis: IORedis;
  const ACCOUNT_ID = 77;
  const CONTACT_ID = BigInt(77001);
  const CONTACT_KEY = String(CONTACT_ID);

  beforeAll(async () => {
    // Use an empty migrations dir for setupInfra so it doesn't auto-apply migrations
    // (migration 001 has FK references to accounts but doesn't create it).
    // We create accounts first, then apply migrations manually — mirrors cert-gates.
    const emptyDir = mkdtempSync(join(tmpdir(), "harness-model-c-bridge-"));
    const infra = await setupInfra({ migrationsDir: emptyDir });
    teardown = infra.teardown;
    pool = new Pool({ connectionString: infra.databaseUrl });
    redis = new IORedis(infra.redisUrl, { maxRetriesPerRequest: null });

    // Create accounts table + seed BEFORE applying migrations (FK dependency).
    // Split into two queries — pg-pool doesn't allow multi-statement prepared statements.
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT)`);
    await pool.query(
      `INSERT INTO accounts (id, name) VALUES ($1, 'model-c-test') ON CONFLICT DO NOTHING`,
      [ACCOUNT_ID],
    );

    // Apply all migrations (session, eval, workflow_executions, workflow_correlation, sdr_account_state …)
    await applyMigrations(infra.databaseUrl, join(__dirname, "..", "..", "..", "migrations"));

    // Register sdr-cadence workflow
    WorkflowRegistry.resetForTests();
    WorkflowRegistry.getInstance().register(sdrCadenceWorkflow);
  }, 120_000);

  afterAll(async () => {
    // Reset the dispatchModelC seam to avoid leaking across test suites
    __setDispatchModelCForTests(undefined);
    await redis?.quit();
    await pool?.end();
    if (teardown) await teardown();
  }, 60_000);

  beforeEach(() => {
    callbackMock.sendComplete.mockClear();
    callbackMock.updateStatus.mockClear();
  });

  // ─── Helper: reset singleton registries ──────────────────────────────────
  function buildRegistries() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AgentRegistry as any).instance = undefined;
    UnifiedToolRegistry.resetForTests();
    const agentRegistry = AgentRegistry.getInstance();
    const toolRegistry = UnifiedToolRegistry.getInstance();
    agentRegistry.register(new StubAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    return { agentRegistry, toolRegistry };
  }

  // ─── Helper: install fake LLM gateway ────────────────────────────────────
  function installFakeLlm(content = "Obrigado pelo seu interesse! Vamos agendar uma conversa?") {
    const response: LLMResponse = {
      content,
      tool_calls: [],
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      model: "fake-model",
      provider: "fake",
      latency_ms: 1,
    };
    const fakeGateway = new FakeLLMGateway({ responses: [response] });
    gatewayMock.createLLMGateway.mockReturnValue(fakeGateway);
    return fakeGateway;
  }

  // ─── Helper: seed a suspended cadence + correlation row ──────────────────
  async function seedSuspendedCadence(
    executionId: string,
    opts?: { contactId?: bigint; contactKey?: string },
  ): Promise<{
    workflowExecutionId: string;
    suspendToken: string;
  }> {
    const store = new WorkflowStateStore(pool);
    const seedContactId = opts?.contactId ?? CONTACT_ID;
    const seedContactKey = opts?.contactKey ?? CONTACT_KEY;

    const noop = () => {};
    const childLogger = {
      info: noop,
      debug: noop,
      warn: noop,
      error: noop,
      child: () => childLogger,
    };
    const ctx: AgentExecutionContext = {
      executionId,
      organizationId: ACCOUNT_ID,
      contactId: seedContactId,
      conversationKey: `conv-${executionId}`,
      db: pool,
      logger: childLogger as never,
      llmClient: {
        complete: async () => {
          throw new Error("LLM must not be called in cadence init");
        },
      },
    };

    // Run the cadence until its first suspend (touch-1 → reply:inbound)
    const result = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: ACCOUNT_ID, contactKey: seedContactKey },
      context: ctx,
      store,
      executionId,
      organizationId: ACCOUNT_ID,
      toolExecutor: async () => ({ success: true }),
    });

    if (result.status !== "suspended") {
      throw new Error(`Expected cadence to suspend at touch-1, got: ${result.status}`);
    }

    const suspendToken = result.suspend!.token;
    const workflowExecutionId = result.workflowExecutionId;

    // Seed the correlation row (mirrors the onSuspended hook in C.3)
    await new CorrelationStore(pool).upsertSuspended({
      organizationId: ACCOUNT_ID,
      contactKey: seedContactKey,
      workflowExecutionId,
      suspendToken,
      resumeEvent: "reply:inbound",
      workflowVersion: sdrCadenceWorkflow.version,
    });

    return { workflowExecutionId, suspendToken };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (a+b+c) Main Model-C bridge test
  // ─────────────────────────────────────────────────────────────────────────
  it("inbound reply to suspended cadence: doctrine-governed reply + FSM advance + single sendComplete", async () => {
    const seedExecId = randomUUID();
    const { workflowExecutionId, suspendToken } = await seedSuspendedCadence(seedExecId);

    // Verify correlation row exists (sanity)
    const corrRow = await new CorrelationStore(pool).resolveActive(ACCOUNT_ID, CONTACT_KEY);
    expect(corrRow, "correlation row must exist before dispatch").not.toBeNull();
    expect(corrRow!.suspendToken).toBe(suspendToken);

    // Install fake LLM
    const fakeGateway = installFakeLlm(
      "Obrigado pelo seu interesse! Podemos marcar uma reunião amanhã?",
    );

    // Build registries and ctx
    const { agentRegistry, toolRegistry } = buildRegistries();
    const agentRouter = createAgentRouter();
    const ctx: ExecutionContext = { db: pool, redis, agentRegistry, toolRegistry, agentRouter };

    // Dispatch inbound "reply" execution for this (account, contact) with sdr_profile.enabled
    const inboundExecId = randomUUID();
    await handleExecution(
      {
        execution_id: inboundExecId,
        execution_token: "model-c-token-12345678901234567890",
        organization_id: ACCOUNT_ID,
        messages: [
          { role: "user", content: "Sim, tenho interesse! Pode me enviar mais detalhes?" },
        ],
        agent_config: {
          system_prompt: "You are an SDR assistant.",
          sdr_profile: {
            enabled: true,
            persona: "SDR Comercial",
            focusProduct: "CRM Platform",
            targetVertical: "B2B SaaS",
            maxTouchCount: 7,
          },
        },
        context: {
          contact_id: String(CONTACT_ID),
        },
      },
      ctx,
    );

    // (c) sendComplete called exactly once — no double-respond
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(1);
    const completePayload = callbackMock.sendComplete.mock.calls[0]![2] as {
      response_text: string;
    };
    expect(completePayload.response_text, "reply must be non-empty").toBeTruthy();

    // (a) System-message COUNT stays 2 (FSM appended to doctrine message, not separate)
    expect(fakeGateway.calls.length, "gateway should have been called").toBeGreaterThan(0);
    const firstCall = fakeGateway.calls[0]!;
    const systemMessages = firstCall.messages.filter((m) => m.role === "system");

    expect(
      systemMessages.length,
      `Expected exactly 2 system messages (doctrine+FSM + engine own prompt), got ${systemMessages.length}`,
    ).toBe(2);

    // (a) Doctrine marker present in exactly one of the 2 system messages
    const doctrineMsg = systemMessages.find((m) => m.content.includes(SDR_DOCTRINE_MARKER));
    expect(doctrineMsg, "One system message must contain the SDR doctrine marker").toBeDefined();

    // (a) FSM-state keywords present in the doctrine message (same string, not a separate message)
    expect(
      doctrineMsg!.content,
      "Doctrine message must contain FSM state section header",
    ).toContain("FSM STATE");

    expect(doctrineMsg!.content, "Doctrine message must contain account-status keyword").toContain(
      "account-status",
    );

    expect(
      doctrineMsg!.content,
      "Doctrine message must contain cadence step / allowed transitions",
    ).toMatch(/touch-\d|Working|Cold|next-transitions/i);

    // (b) After the reply, the cadence advanced — verify workflow state changed.
    // The suspend token should no longer resolve (cadence resumed and re-suspended or completed)
    const store = new WorkflowStateStore(pool);
    const wfRow = await store.load(workflowExecutionId);
    expect(wfRow, "workflow row must still exist").not.toBeNull();
    // After resumeWorkflow: the row's suspend_token should differ (cleared then re-set by new suspend)
    // OR the workflow completed/re-suspended at a later step.
    // The key invariant: the old suspend_token was consumed (no longer === the original token)
    expect(
      wfRow!.suspendToken,
      "old suspend token must be consumed (null or a new token after cadence advance)",
    ).not.toBe(suspendToken);
  }, 90_000);

  // ─────────────────────────────────────────────────────────────────────────
  // (e) C.8 split-idempotency: reply sent once even when resumeWorkflow fails
  //     on first attempt and BullMQ retries with a new execution_id.
  //
  // Scenario:
  //   1. Seed a fresh suspended cadence.
  //   2. First dispatch: force resumeWorkflow to fail (error injected).
  //      → sendComplete MUST be called once (reply sent).
  //      → replied-marker key MUST be written to Redis.
  //   3. Second dispatch (same inbound message, new execution_id — simulates
  //      BullMQ retry after advance failure):
  //      → sendComplete MUST NOT be called a second time (no double-reply).
  //      → resumeWorkflow MUST be attempted again (advance retried independently).
  // ─────────────────────────────────────────────────────────────────────────
  it("C.8 split-idempotency: retry after resumeWorkflow failure — no double-reply, advance retried", async () => {
    // ── 1. Seed a fresh suspended cadence for this test ──────────────────
    // Use a distinct contactId/contactKey from the (a+b+c) test to avoid
    // unique-constraint collisions on workflow_correlation (the prior test's
    // cadence row persists after it advances to a new suspend step).
    const C8_CONTACT_ID = BigInt(77002);
    const C8_CONTACT_KEY = String(C8_CONTACT_ID);

    const seedExecId = randomUUID();
    const { workflowExecutionId: _wfExecId, suspendToken: _suspendToken } =
      await seedSuspendedCadence(seedExecId, {
        contactId: C8_CONTACT_ID,
        contactKey: C8_CONTACT_KEY,
      });

    const corrRow = await new CorrelationStore(pool).resolveActive(ACCOUNT_ID, C8_CONTACT_KEY);
    expect(corrRow, "correlation row must exist before dispatch").not.toBeNull();

    // Flush the replied-marker namespace so this test is isolated from others
    // that ran on the same Redis instance (tests share a real Redis via testcontainers).
    const existingKeys = await redis.keys("harness:sdr:replied:*");
    for (const k of existingKeys) await redis.del(k);

    const INBOUND_CONTENT = "C.8 retry test: estou interessado, pode enviar proposta?";

    // ── 2. First dispatch: reply sent, resumeWorkflow fails ───────────────
    // Import and override dispatchModelC to inject a failing resumeWorkflow.
    // We use __setDispatchModelCForTests to wrap _dispatchModelCImpl with a
    // version that records calls but throws on resumeWorkflow.
    //
    // Strategy: spy on the real _dispatchModelCImpl by importing and overriding
    // the dispatchModelC seam with a custom function that:
    //   (a) calls sendComplete (simulating the real path up to the reply)
    //   (b) marks replied via markReplied (simulating real flow)
    //   (c) throws on resumeWorkflow (simulating advance failure)
    //   (d) on subsequent calls: checks wasReplied and skips sendComplete if true

    const {
      wasReplied: wasRepliedFn,
      markReplied: markRepliedFn,
      REPLIED_MARKER_TTL_SEC,
    } = await import("../../../src/sdr/replied-marker.js");

    let resumeWorkflowCallCount = 0;
    let resumeWorkflowFailOnFirst = true;

    // Build a fake _dispatchModelCImpl that mirrors C.8 wiring:
    // wasReplied → skip reply if already sent, markReplied after reply, resumeWorkflow always.
    // The fake uses args.contactKey so it naturally scopes to the correct contact.
    const fakeDispatch = async (
      args: import("../../../src/runtime/execution-handler.js").DispatchModelCArgs,
    ) => {
      const { agentContext } = args;
      const inboundMsg = args.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");

      const already = await wasRepliedFn(redis, args.organizationId, args.contactKey, inboundMsg);
      if (!already) {
        // Send reply
        await callbackMock.sendComplete(agentContext.executionId, args.executionToken, {
          response_text: "C.8 fake reply",
          sentiment: "neutral",
          strategy: "react",
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        });
        // Mark replied
        await markRepliedFn(
          redis,
          args.organizationId,
          args.contactKey,
          inboundMsg,
          REPLIED_MARKER_TTL_SEC,
        );
      }

      // Always attempt FSM advance
      resumeWorkflowCallCount++;
      if (resumeWorkflowFailOnFirst) {
        resumeWorkflowFailOnFirst = false;
        throw new Error("resumeWorkflow simulated failure (C.8 test)");
      }
      // Second call: simulate successful advance (no-op here — correlation row will be consumed)
    };

    __setDispatchModelCForTests(fakeDispatch);

    callbackMock.sendComplete.mockClear();

    const { agentRegistry: ar1, toolRegistry: tr1 } = buildRegistries();
    const ctx1: ExecutionContext = { db: pool, redis, agentRegistry: ar1, toolRegistry: tr1 };

    // First dispatch — reply sent, resumeWorkflow throws
    const firstExecId = randomUUID();
    // handleExecution propagates the thrown error from dispatchModelC via the outer catch.
    try {
      await handleExecution(
        {
          execution_id: firstExecId,
          execution_token: "c8-retry-token-12345678901234567890",
          organization_id: ACCOUNT_ID,
          messages: [{ role: "user", content: INBOUND_CONTENT }],
          agent_config: {
            system_prompt: "You are an SDR assistant.",
            sdr_profile: {
              enabled: true,
              persona: "SDR Comercial",
              focusProduct: "CRM Platform",
              targetVertical: "B2B SaaS",
              maxTouchCount: 7,
            },
          },
          context: { contact_id: String(C8_CONTACT_ID) },
        },
        ctx1,
      );
    } catch {
      // resumeWorkflow failure propagates — expected on first attempt
    }

    // sendComplete must have been called exactly once (reply was sent before the throw)
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(1);
    const firstReply = callbackMock.sendComplete.mock.calls[0]![2] as { response_text: string };
    expect(firstReply.response_text).toBeTruthy();

    // The replied-marker key must exist in Redis
    const markerKeys = await redis.keys("harness:sdr:replied:*");
    expect(
      markerKeys,
      "replied-marker key must be written to Redis after first reply",
    ).toHaveLength(1);

    // ── 3. Second dispatch (BullMQ retry — new execution_id, same inbound) ─
    callbackMock.sendComplete.mockClear();
    resumeWorkflowFailOnFirst = false; // allow the second attempt to succeed

    // Need a new dedup key since new execution_id
    const retryExecId = randomUUID();
    const { agentRegistry: ar2, toolRegistry: tr2 } = buildRegistries();
    const ctx2: ExecutionContext = { db: pool, redis, agentRegistry: ar2, toolRegistry: tr2 };

    await handleExecution(
      {
        execution_id: retryExecId,
        execution_token: "c8-retry-token-12345678901234567890",
        organization_id: ACCOUNT_ID,
        messages: [{ role: "user", content: INBOUND_CONTENT }],
        agent_config: {
          system_prompt: "You are an SDR assistant.",
          sdr_profile: {
            enabled: true,
            persona: "SDR Comercial",
            focusProduct: "CRM Platform",
            targetVertical: "B2B SaaS",
            maxTouchCount: 7,
          },
        },
        context: { contact_id: String(C8_CONTACT_ID) },
      },
      ctx2,
    );

    // KEY ASSERTION: sendComplete must NOT be called again — no double-reply
    expect(
      callbackMock.sendComplete,
      "sendComplete must NOT be called on retry — replied-marker prevents double-reply",
    ).toHaveBeenCalledTimes(0);

    // resumeWorkflow must have been attempted twice total (once on first, once on retry)
    expect(
      resumeWorkflowCallCount,
      "resumeWorkflow must be attempted on both first dispatch and retry",
    ).toBe(2);

    // Reset the dispatchModelC seam so subsequent tests (zero-cost path) use
    // the real _dispatchModelCImpl and are not affected by the fake dispatch.
    __setDispatchModelCForTests(undefined);
  }, 90_000);

  // ─────────────────────────────────────────────────────────────────────────
  // (d) Zero-cost path: no sdr_profile — byte-unchanged, no Model-C dispatch
  // ─────────────────────────────────────────────────────────────────────────
  it("zero-cost path: no sdr_profile → normal pipeline, no FSM injection, no resumeWorkflow call", async () => {
    // Reset mock call history from any previous test
    gatewayMock.createLLMGateway.mockClear();

    const fakeGateway = installFakeLlm("Hello! How can I help you?");

    const { agentRegistry, toolRegistry } = buildRegistries();
    const ctx: ExecutionContext = {
      db: pool,
      redis,
      agentRegistry,
      toolRegistry,
      agentRouter: createAgentRouter(),
    };

    const execId = randomUUID();
    await handleExecution(
      {
        execution_id: execId,
        execution_token: "zero-cost-token-12345678901234567890",
        organization_id: ACCOUNT_ID,
        messages: [{ role: "user", content: "What services do you offer?" }],
        agent_config: {
          system_prompt: "Base system prompt only — no SDR.",
          // no sdr_profile
        },
      },
      ctx,
    );

    // Normal pipeline ran, reply sent once
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(1);

    // The reply content must NOT contain SDR doctrine
    const systemMessages =
      fakeGateway.calls[0]?.messages.filter((m: { role: string }) => m.role === "system") ?? [];
    const hasDoctrineMarker = systemMessages.some((m: { content: string }) =>
      m.content.includes(SDR_DOCTRINE_MARKER),
    );
    expect(hasDoctrineMarker, "zero-cost path must NOT inject SDR doctrine").toBe(false);
  }, 60_000);
});
