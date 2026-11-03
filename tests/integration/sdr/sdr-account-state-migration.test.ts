/**
 * Migration 008 → 011 — sdr_account_state integration test
 * Fase B §5.4, re-pointed to the POST-011 tenancy end-state (SP-3 Task 6).
 *
 * Migration 011 (ADR-019 / _shared/ADR-021 / _shared/ADR-016) DROP-and-RECREATEs
 * sdr_account_state with the tenant column re-typed `account_id INTEGER` →
 * `organization_id UUID NOT NULL` and the legacy `REFERENCES accounts(id)`
 * FK retired. `applyMigrations()` globs the whole migrations/ dir, so 011 is
 * always the canonical end-state for this schema.
 *
 * This suite verifies the CONVERGED post-011 schema, not the retired
 * pre-011 (account_id integer / FK→accounts) one:
 *   - sdr_account_state.organization_id is uuid, NOT NULL, no account_id column.
 *   - UNIQUE(organization_id, contact_id) enforced.
 *   - CHECK constraint on status still enforced.
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

describe.skipIf(!RUN)("Migration 008 → 011 — sdr_account_state (post-011 tenancy)", () => {
  let pool: Pool;
  let teardown: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    // Use pgvector-enabled image — migration 006 requires the vector extension
    // (mirrors setupInfra in integration-setup.ts and rag integration tests).
    const pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();

    teardown = async () => {
      await pool?.end();
      await pg.stop();
    };

    pool = new Pool({ connectionString: pg.getConnectionUri() });

    // Legacy migration 001 still has REFERENCES accounts(id); the accounts
    // shim lets 001 apply. Migration 011 DROPs sdr_account_state & recreates
    // it without the accounts FK, so this shim is irrelevant by the end-state.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT);
      INSERT INTO accounts (id, name) VALUES (1, 'sdr-test') ON CONFLICT DO NOTHING;
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

  it("sdr_account_state has organization_id (uuid, NOT NULL) and NO legacy account_id", async () => {
    const res = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'sdr_account_state'
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

    expect(cols["contact_id"]).toBeDefined();
    expect(cols["status"]).toBeDefined();
    expect(cols["status"].type).toBe("text");
  });

  it("creates sdr_account_state table and round-trips an INSERT/SELECT", async () => {
    const res = await pool.query(`
      INSERT INTO sdr_account_state (organization_id, contact_id, status)
      VALUES ($1, 42, 'cold')
      RETURNING id, organization_id, contact_id, status, created_at, updated_at
    `, [ORG_ID]);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.organization_id).toBe(ORG_ID);
    expect(Number(row.contact_id)).toBe(42);
    expect(row.status).toBe("cold");
    expect(row.id).toBeDefined();
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it("rejects a duplicate (organization_id, contact_id) — UNIQUE enforced", async () => {
    // First insert; use a fresh contact_id to isolate this assertion.
    await pool.query(`
      INSERT INTO sdr_account_state (organization_id, contact_id, status)
      VALUES ($1, 99, 'working')
    `, [ORG_ID]);

    await expect(
      pool.query(`
        INSERT INTO sdr_account_state (organization_id, contact_id, status)
        VALUES ($1, 99, 'nurture')
      `, [ORG_ID]),
    ).rejects.toThrow(/unique/i);
  });

  it("rejects an invalid status value — CHECK enforced", async () => {
    await expect(
      pool.query(`
        INSERT INTO sdr_account_state (organization_id, contact_id, status)
        VALUES ($1, 200, 'invalid_status')
      `, [ORG_ID]),
    ).rejects.toThrow(/check/i);
  });
});
