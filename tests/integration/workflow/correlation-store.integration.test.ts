/**
 * CorrelationStore integration test — Fase C C.3 review (Bug 1 + Bug 2 regression guard)
 *
 * Verifies against a REAL Postgres container (NOT a mock) that:
 *   1. upsertSuspended idempotency — same workflow_execution_id can be upserted
 *      twice with no ON CONFLICT error (proves Bug 1 fixed: unique constraint present).
 *   2. resolveActive returns the row, including workflow_version column
 *      (proves Bug 2 fixed: column exists in CREATE TABLE).
 *   3. markRunning transitions the row → resolveActive returns null (no longer
 *      suspended).
 *   4. upsertSuspended two DIFFERENT execution rows, same (account,contact),
 *      both suspended+reply:inbound → partial unique index uq_wf_corr_active
 *      rejects the 2nd insert (partial-index integrity enforced).
 *   5. markTerminal → resolveActive null.
 *
 * Gated by RUN_INTEGRATION=1.
 * Mirror: tests/integration/sdr/sdr-account-state-migration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { applyMigrations } from "../../helpers/integration-setup.js";
import { CorrelationStore } from "../../../src/workflow/correlation-store.js";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("CorrelationStore — real-DB integration (Bug 1 + Bug 2 regression guard)", () => {
  let pool: Pool;
  let store: CorrelationStore;
  let teardown: (() => Promise<void>) | undefined;

  // Parent execution IDs created in beforeAll — shared across test cases.
  let execId1: string; // used for upsert idempotency + markRunning + markTerminal
  let execId2: string; // used for partial-unique collision test (second insert)

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    // pgvector image — migration 006 requires the vector extension.
    const pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();

    teardown = async () => {
      await pool?.end();
      await pg.stop();
    };

    pool = new Pool({ connectionString: pg.getConnectionUri() });
    store = new CorrelationStore(pool);

    // External `accounts` table (Bevox shared DB — not in migrations).
    // Mirror sdr-account-state-migration.test.ts:39-42.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT);
      INSERT INTO accounts (id, name) VALUES (1, 'corr-store-test') ON CONFLICT DO NOTHING;
    `);

    // Apply all migrations 001 → 010 against this fresh DB.
    await applyMigrations(
      pg.getConnectionUri(),
      join(__dirname, "..", "..", "..", "migrations"),
    );

    // Insert parent workflow_executions rows.
    // Migration 005 columns: execution_id (UUID NOT NULL), workflow_id (TEXT NOT NULL),
    // organization_id (BIGINT NOT NULL), status (TEXT NOT NULL CHECK), state (JSONB NOT NULL).
    const res1 = await pool.query<{ id: string }>(`
      INSERT INTO workflow_executions
        (execution_id, workflow_id, organization_id, status, state)
      VALUES
        (gen_random_uuid(), 'cadence-v1', 1, 'suspended', '{}')
      RETURNING id
    `);
    execId1 = res1.rows[0]!.id;

    const res2 = await pool.query<{ id: string }>(`
      INSERT INTO workflow_executions
        (execution_id, workflow_id, organization_id, status, state)
      VALUES
        (gen_random_uuid(), 'cadence-v1', 1, 'suspended', '{}')
      RETURNING id
    `);
    execId2 = res2.rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    if (teardown) await teardown();
  }, 60_000);

  // ── Bug 1: ON CONFLICT (workflow_execution_id) must not throw ──────────────

  it("upsertSuspended twice on same workflow_execution_id — second call updates (no ON CONFLICT error)", async () => {
    // First insert.
    await expect(
      store.upsertSuspended({
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        contactKey: "contact:bug1",
        workflowExecutionId: execId1,
        suspendToken: "tok-v1",
        resumeEvent: "reply:inbound",
        workflowVersion: 1,
      }),
    ).resolves.not.toThrow();

    // Second upsert — same workflow_execution_id, different suspendToken + version.
    // Without the unique constraint on workflow_execution_id, Postgres throws
    // "no unique or exclusion constraint matching the ON CONFLICT specification".
    await expect(
      store.upsertSuspended({
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        contactKey: "contact:bug1",
        workflowExecutionId: execId1,
        suspendToken: "tok-v2",
        resumeEvent: "reply:inbound",
        workflowVersion: 2,
      }),
    ).resolves.not.toThrow();
  });

  // ── Bug 2: workflow_version column must exist ──────────────────────────────

  it("resolveActive returns the row including workflow_version (column exists proof)", async () => {
    // execId1 was upserted above with workflowVersion=2 (second upsert).
    const row = await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", "contact:bug1");

    expect(row).not.toBeNull();
    expect(row!.workflowExecutionId).toBe(execId1);
    // workflow_version was last set to 2 by the second upsert.
    expect(row!.workflowVersion).toBe(2);
    // Proves Bug 2: SELECT + ORDER BY workflow_version executes without "column does not exist".
    expect(row!.organizationId).toBe(1);
    expect(row!.contactKey).toBe("contact:bug1");
    expect(row!.status).toBe("suspended");
  });

  // ── markRunning → resolveActive null ──────────────────────────────────────

  it("markRunning transitions status → resolveActive returns null (no longer suspended)", async () => {
    await store.markRunning(execId1);

    const row = await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", "contact:bug1");
    expect(row).toBeNull();
  });

  // ── Partial unique index uq_wf_corr_active enforced ───────────────────────

  it("upsertSuspended two DIFFERENT executions same (account,contact)+suspended+reply:inbound → partial unique rejects 2nd", async () => {
    // Insert first row via execId2 (execId1 is now 'running', so it won't conflict).
    // Use a fresh contact key to avoid any cross-test contamination.
    await store.upsertSuspended({
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactKey: "contact:collision",
      workflowExecutionId: execId2,
      suspendToken: "tok-a",
      resumeEvent: "reply:inbound",
      workflowVersion: 1,
    });

    // Need a third execution row to trigger the collision (execId2 is already in the
    // table; a new execution_id will attempt to insert a second suspended+reply:inbound
    // row for the same (organization_id=1, contact_key='contact:collision')).
    const res3 = await pool.query<{ id: string }>(`
      INSERT INTO workflow_executions
        (execution_id, workflow_id, organization_id, status, state)
      VALUES
        (gen_random_uuid(), 'cadence-v1', 1, 'suspended', '{}')
      RETURNING id
    `);
    const execId3 = res3.rows[0]!.id;

    // Direct pool INSERT (bypassing upsertSuspended's ON CONFLICT — we want a raw
    // INSERT to trigger the partial-unique violation, not the upsert update path).
    await expect(
      pool.query(
        `INSERT INTO workflow_correlation
           (organization_id, contact_key, workflow_execution_id, suspend_token, resume_event, status, workflow_version, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'suspended', 1, NOW())`,
        [1, "contact:collision", execId3, "tok-b", "reply:inbound"],
      ),
    ).rejects.toThrow(/unique/i);
  });

  // ── markTerminal → resolveActive null ─────────────────────────────────────

  it("markTerminal(completed) → resolveActive null", async () => {
    // Use execId2, which is still 'suspended' from the previous test.
    await store.markTerminal(execId2, "completed");

    const row = await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", "contact:collision");
    expect(row).toBeNull();
  });
});
