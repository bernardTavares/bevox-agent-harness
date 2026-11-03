import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setupInfra, applyMigrations } from "../helpers/integration-setup.js";
import { UsageTracker } from "../../src/observability/usage-tracker.js";

const RUN = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!RUN)('UsageTracker (integration)', () => {
  let teardown: () => Promise<void>;
  let pool: Pool;

  beforeAll(async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'harness-empty-migrations-'));
    const infra = await setupInfra({ migrationsDir: emptyDir });
    teardown = infra.teardown;
    pool = new Pool({ connectionString: infra.databaseUrl });
    await pool.query(`
      CREATE TABLE accounts (id SERIAL PRIMARY KEY, name TEXT);
      INSERT INTO accounts (id, name) VALUES (1, 'test');
    `);
    await applyMigrations(infra.databaseUrl, join(__dirname, '..', '..', 'migrations'));
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (teardown) await teardown();
  }, 60_000);

  it('records a usage row with computed cost', async () => {
    const tracker = new UsageTracker(pool);
    await tracker.record({
      executionId: '33333333-3333-4333-8333-333333333333',
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      provider: 'openai',
      model: 'gpt-4o-mini',
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 250,
      purpose: 'test'
    });
    const result = await pool.query(
      `SELECT * FROM execution_usage WHERE execution_id = '33333333-3333-4333-8333-333333333333'`
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.total_tokens).toBe(150);
    expect(row.call_purpose).toBe('test');
    expect(row.provider).toBe('openai');
    expect(row.cost_usd_cents).toBeGreaterThanOrEqual(0);
  });
});