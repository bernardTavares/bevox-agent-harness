/**
 * Correlation projection E2E integration test — Fase C C.4
 *
 * Verifies that the `register-workflows` bootstrap stage registers the
 * correlation projection handler on the hook bus so that workflow lifecycle
 * events automatically populate the `workflow_correlation` table.
 *
 * RED: before C.4 — the stage does NOT call getHookBus().register(...), so
 *   no row is written and the assertion fails.
 * GREEN: after C.4 — the stage registers the handler; the row appears.
 *
 * Flow:
 *   1. Spin up a pgvector container, seed `accounts`, apply migrations.
 *   2. Call the `register-workflows` stage execute() with a real DB pool
 *      (this is the production registration path, not a manual register call).
 *   3. Run a tiny workflow that suspends with resumeOn:"reply:inbound",
 *      carrying organizationId + contactId (→ contactKey).
 *   4. Assert a `workflow_correlation` row exists with status='suspended'.
 *   5. Resume the workflow and assert the row transitions to non-suspended.
 *
 * Gated by RUN_INTEGRATION=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { join } from "node:path";
import { applyMigrations } from "../../helpers/integration-setup.js";
import { CorrelationStore } from "../../../src/workflow/correlation-store.js";
import { resetHookBusForTests } from "../../../src/runtime/hooks/index.js";
import { WorkflowStateStore } from "../../../src/workflow/state-store.js";
import { createStep, createWorkflow } from "../../../src/workflow/builder.js";
import { runWorkflow, resumeWorkflow } from "../../../src/workflow/engine.js";
import { setBootstrapContext, buildStages } from "../../../src/bootstrap/stages.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";

const RUN = process.env.RUN_INTEGRATION === "1";

const ACCOUNT_ID = 1;

function makeCtx(contactId?: bigint): AgentExecutionContext {
  const noop = () => {};
  const childLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    child: () => childLogger,
  };
  return {
    executionId: "exec-e2e-corr",
    organizationId: ACCOUNT_ID,
    conversationKey: "conv-e2e-corr",
    contactId,
    db: {} as never,
    logger: childLogger as never,
    llmClient: { complete: async () => ({ content: "", model: "fake" }) },
  };
}

const noopTool = async () => ({ success: true });

describe.skipIf(!RUN)(
  "correlation projection E2E — hook registered via register-workflows bootstrap stage (C.4)",
  () => {
    let pool: Pool;
    let stateStore: WorkflowStateStore;
    let correlationStore: CorrelationStore;
    let teardown: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      // Fake Redis client — the register-workflows stage does not use Redis.
      const fakeRedis = { ping: async () => "PONG" } as never;

      const pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();

      teardown = async () => {
        await pool?.end();
        await pg.stop();
      };

      pool = new Pool({ connectionString: pg.getConnectionUri() });

      // Seed external `accounts` table (Bevox shared DB — mirrors correlation-store.integration.test.ts).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT);
        INSERT INTO accounts (id, name) VALUES (${ACCOUNT_ID}, 'e2e-corr-test') ON CONFLICT DO NOTHING;
      `);

      // Apply all migrations (001 → 010, including 009_workflow_correlation.sql).
      await applyMigrations(
        pg.getConnectionUri(),
        join(__dirname, "..", "..", "..", "migrations"),
      );

      stateStore = new WorkflowStateStore(pool);
      correlationStore = new CorrelationStore(pool);

      // ── C.4 RED/GREEN gate ─────────────────────────────────────────────────
      // Reset hook bus so prior test state doesn't leak, then invoke the
      // `register-workflows` bootstrap stage directly (the same code path
      // production runs). After C.4 this stage calls
      //   getHookBus().register(makeCorrelationProjectionHandler(store))
      // Before C.4 it does not, so lifecycle events produce no rows.
      resetHookBusForTests();

      setBootstrapContext({ db: pool, redis: fakeRedis });
      const stages = buildStages({ db: pool, redis: fakeRedis });
      const registerWorkflowsStage = stages.find((s) => s.name === "register-workflows");
      if (!registerWorkflowsStage) throw new Error("register-workflows stage not found");
      await registerWorkflowsStage.execute();
    }, 120_000);

    afterAll(async () => {
      // Clean up hook bus so other tests are not affected.
      resetHookBusForTests();
      if (teardown) await teardown();
    }, 60_000);

    it("suspending a workflow with organizationId+contactId creates a workflow_correlation row (status=suspended)", async () => {
      const wf = createWorkflow("corr-probe-wf", 1)
        .step(
          createStep("wait-reply", async (_input, ctx) => {
            ctx.suspend({ resumeOn: "reply:inbound", timeoutMs: 60_000 });
          }),
        )
        .build("desc");

      const contactId = BigInt(42);
      const result = await runWorkflow({
        definition: wf,
        input: {},
        context: makeCtx(contactId),
        store: stateStore,
        executionId: randomUUID(),
        organizationId: ACCOUNT_ID,
        toolExecutor: noopTool,
      });

      expect(result.status).toBe("suspended");
      expect(result.suspend?.token).toBeTruthy();

      // The hook should have fired onSuspended → upsertSuspended.
      // contactKey = String(contactId) = "42"
      const row = await correlationStore.resolveActive(ACCOUNT_ID, "42");

      expect(row).not.toBeNull();
      expect(row!.organizationId).toBe(ACCOUNT_ID);
      expect(row!.contactKey).toBe("42");
      expect(row!.status).toBe("suspended");
      expect(row!.resumeEvent).toBe("reply:inbound");
      expect(row!.workflowExecutionId).toBe(result.workflowExecutionId);
    });

    it("resuming the workflow transitions correlation row to non-suspended", async () => {
      // Run a fresh workflow to get an independent suspended row.
      const wf = createWorkflow("corr-probe-wf", 1)
        .step(
          createStep("wait-reply", async (_input, ctx) => {
            ctx.suspend({ resumeOn: "reply:inbound", timeoutMs: 60_000 });
          }),
        )
        .step(
          createStep("done", async () => ({ ok: true })),
        )
        .build("desc");

      const contactId = BigInt(99);
      const runResult = await runWorkflow({
        definition: wf,
        input: {},
        context: makeCtx(contactId),
        store: stateStore,
        executionId: randomUUID(),
        organizationId: ACCOUNT_ID,
        toolExecutor: noopTool,
      });
      expect(runResult.status).toBe("suspended");

      // Verify row is suspended before resume.
      const before = await correlationStore.resolveActive(ACCOUNT_ID, "99");
      expect(before).not.toBeNull();
      expect(before!.status).toBe("suspended");

      // Resume — onResumed → markRunning; onWorkflowTerminal → markTerminal.
      const resumed = await resumeWorkflow(
        stateStore,
        runResult.suspend!.token,
        ACCOUNT_ID,
        { reply: "hi" },
        {
          definition: wf,
          context: makeCtx(contactId),
          toolExecutor: noopTool,
        },
      );
      expect(resumed.status).toBe("completed");

      // Row should no longer be suspended (partial-unique index only covers
      // status='suspended'; terminal row still exists but resolveActive returns null).
      const after = await correlationStore.resolveActive(ACCOUNT_ID, "99");
      expect(after).toBeNull();

      // Confirm the row was written and is in a terminal/non-suspended state.
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM workflow_correlation WHERE workflow_execution_id = $1`,
        [runResult.workflowExecutionId],
      );
      expect(rows[0]?.status).toMatch(/^(running|completed)$/);
    });
  },
);
