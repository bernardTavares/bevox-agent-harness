/**
 * Migration 009 + 010 → 011 — workflow_correlation + lock_version integration test
 * Fase C §C.0, re-pointed to the POST-011 tenancy end-state (SP-3 Task 6).
 *
 * Migration 011 (ADR-019 / _shared/ADR-021 / _shared/ADR-016) DROP-and-RECREATEs
 * workflow_correlation + workflow_executions with the tenant column re-typed
 * `account_id BIGINT` → `organization_id UUID NOT NULL` and the legacy
 * `REFERENCES accounts(id)` FK retired. `applyMigrations()` globs the whole
 * migrations/ dir, so 011 is always the canonical end-state for this schema.
 *
 * This suite verifies the CONVERGED post-011 schema, not the retired
 * pre-011 (account_id bigint) one:
 *   1. workflow_correlation has organization_id (uuid, NOT NULL) and NO
 *      account_id column.
 *   2. The partial unique index rejects a second suspended+reply:inbound row
 *      for the same (organization_id, contact_key).
 *   3. workflow_executions.lock_version INT DEFAULT 0 (010, folded into 011).
 *
 * Gated by RUN_INTEGRATION=1 (requires real Postgres via testcontainers).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { applyMigrations } from "../../helpers/integration-setup.js";

const RUN = process.env.RUN_INTEGRATION === "1";

// Canonical UUIDv7 tenant fixture (_shared/ADR-016).
const ORG_ID = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";

describe.skipIf(!RUN)("Migrations 009 + 010 → 011 — workflow_correlation + lock_version (post-011 tenancy)", () => {
  let pool: Pool;
  let teardown: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    // Use pgvector-enabled image — migration 006 requires the vector extension.
    const pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();

    teardown = async () => {
      await pool?.end();
      await pg.stop();
    };

    pool = new Pool({ connectionString: pg.getConnectionUri() });

    // Legacy migration 001 still has REFERENCES accounts(id); the accounts
    // shim lets 001 apply. Migration 011 DROPs these tables & recreates them
    // without the accounts FK, so this shim is irrelevant by the end-state.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT);
      INSERT INTO accounts (id, name) VALUES (1, 'corr-test') ON CONFLICT DO NOTHING;
    `);

    // Apply all migrations (001 → 011) against this fresh DB.
    await applyMigrations(
      pg.getConnectionUri(),
      join(__dirname, "..", "..", "..", "migrations"),
    );
  }, 120_000);

  afterAll(async () => {
    if (teardown) await teardown();
  }, 60_000);

  // ── post-011: workflow_correlation tenancy convergence ──────────────────────

  it("workflow_correlation has organization_id (uuid, NOT NULL) and NO legacy account_id", async () => {
    const res = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_correlation'
      ORDER BY ordinal_position
    `);

    const cols = Object.fromEntries(
      res.rows.map((r) => [r.column_name, { type: r.data_type, nullable: r.is_nullable }]),
    );

    // Tenant column converged: organization_id UUID NOT NULL.
    expect(cols["organization_id"]).toBeDefined();
    expect(cols["organization_id"].type).toBe("uuid");
    expect(cols["organization_id"].nullable).toBe("NO");

    // Legacy tenant column eliminated by migration 011.
    expect(cols["account_id"]).toBeUndefined();

    expect(cols["contact_key"]).toBeDefined();
    expect(cols["contact_key"].type).toBe("text");

    expect(cols["workflow_execution_id"]).toBeDefined();
    expect(cols["workflow_execution_id"].type).toBe("uuid");

    expect(cols["suspend_token"]).toBeDefined();
    expect(cols["suspend_token"].nullable).toBe("YES");

    expect(cols["resume_event"]).toBeDefined();
    expect(cols["resume_event"].type).toBe("text");

    expect(cols["status"]).toBeDefined();
    expect(cols["status"].type).toBe("text");

    expect(cols["updated_at"]).toBeDefined();
    expect(cols["updated_at"].type).toBe("timestamp with time zone");
  });

  it("partial unique index rejects a second suspended+reply:inbound row for the same (organization_id, contact_key)", async () => {
    // Insert a parent workflow_executions row for the FK (post-011: organization_id UUID).
    const execRes = await pool.query(`
      INSERT INTO workflow_executions
        (execution_id, workflow_id, organization_id, status, state)
      VALUES
        (gen_random_uuid(), 'cadence-v1', $1, 'suspended', '{}')
      RETURNING id
    `, [ORG_ID]);
    const execId: string = execRes.rows[0].id;

    // First correlation row — must succeed.
    await pool.query(`
      INSERT INTO workflow_correlation
        (organization_id, contact_key, workflow_execution_id, resume_event, status)
      VALUES
        ($1, 'contact:abc', $2, 'reply:inbound', 'suspended')
    `, [ORG_ID, execId]);

    // Second correlation row with same (organization_id, contact_key) + same
    // partial index predicate → must throw a unique-violation error.
    // Needs a distinct workflow_execution_id because uq_wf_corr_exec_id is
    // UNIQUE(workflow_execution_id); the assertion under test is uq_wf_corr_active.
    const execRes2 = await pool.query(`
      INSERT INTO workflow_executions
        (execution_id, workflow_id, organization_id, status, state)
      VALUES
        (gen_random_uuid(), 'cadence-v1', $1, 'suspended', '{}')
      RETURNING id
    `, [ORG_ID]);
    const execId2: string = execRes2.rows[0].id;

    await expect(
      pool.query(`
        INSERT INTO workflow_correlation
          (organization_id, contact_key, workflow_execution_id, resume_event, status)
        VALUES
          ($1, 'contact:abc', $2, 'reply:inbound', 'suspended')
      `, [ORG_ID, execId2]),
    ).rejects.toThrow(/unique/i);
  });

  it("allows a second row for the same (organization_id, contact_key) when status != suspended", async () => {
    // Insert a second parent execution row.
    const execRes = await pool.query(`
      INSERT INTO workflow_executions
        (execution_id, workflow_id, organization_id, status, state)
      VALUES
        (gen_random_uuid(), 'cadence-v1', $1, 'completed', '{}')
      RETURNING id
    `, [ORG_ID]);
    const execId: string = execRes.rows[0].id;

    // A completed row for the same contact key does NOT hit the partial index.
    await expect(
      pool.query(`
        INSERT INTO workflow_correlation
          (organization_id, contact_key, workflow_execution_id, resume_event, status)
        VALUES
          ($1, 'contact:abc', $2, 'reply:inbound', 'completed')
      `, [ORG_ID, execId]),
    ).resolves.not.toThrow();
  });

  // ── 010 (folded into 011): lock_version column ──────────────────────────────

  it("workflow_executions.lock_version column exists with default 0", async () => {
    const res = await pool.query(`
      INSERT INTO workflow_executions
        (execution_id, workflow_id, organization_id, status, state)
      VALUES
        (gen_random_uuid(), 'cadence-v1', $1, 'running', '{}')
      RETURNING lock_version
    `, [ORG_ID]);
    expect(res.rows).toHaveLength(1);
    expect(Number(res.rows[0].lock_version)).toBe(0);
  });
});
