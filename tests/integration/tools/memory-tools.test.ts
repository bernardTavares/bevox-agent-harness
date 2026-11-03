import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, Client } from 'pg';
// SKILLS-05 Phase 3: legacy per-tool wrappers deleted; logic lives in the skill impls.
import { execute as readProfile } from "../../../src/skills-builtin/memory/read-profile/read-profile.impl.js";
import { execute as writeProfile } from "../../../src/skills-builtin/memory/write-profile/write-profile.impl.js";
import { execute as writeFact } from "../../../src/skills-builtin/memory/write-fact/write-fact.impl.js";
import { applyMigrations } from "../../helpers/integration-setup.js";
import { makeToolContext } from "../../helpers/tool-context.js";
import { join } from 'node:path';

/**
 * Integration tests for memory tools running against a real Postgres
 * via testcontainers. Skipped when Docker is not available.
 *
 * Run explicitly with:
 *   RUN_INTEGRATION=1 npm run test:integration
 */
const runIntegration = process.env.RUN_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration('memory tools (integration)', () => {
  let pool: Pool;
  let teardown: () => Promise<void>;
  const ACCOUNT_ID = 1;
  const CONTACT_ID = 100n;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    const url = pg.getConnectionUri();

    // Migration references accounts(id) — create a minimal stub first.
    const seed = new Client({ connectionString: url });
    await seed.connect();
    try {
      await seed.query(`CREATE TABLE accounts (id SERIAL PRIMARY KEY, name TEXT)`);
      await seed.query(`INSERT INTO accounts (id, name) VALUES (1, 'test-acc')`);
    } finally {
      await seed.end();
    }

    await applyMigrations(url, join(__dirname, '..', '..', '..', 'migrations'));

    pool = new Pool({ connectionString: url });
    teardown = async () => {
      await pool.end();
      await pg.stop();
    };
  }, 120_000);

  afterAll(async () => {
    if (teardown) await teardown();
  });

  it('write-profile then read-profile round-trip', async () => {
    // Seed contact profile row (write-profile uses UPDATE, not INSERT)
    await pool.query(
      `INSERT INTO contact_profiles (organization_id, contact_id, first_seen_at, total_interactions)
       VALUES ($1, $2, now(), 1)`,
      [ACCOUNT_ID, CONTACT_ID.toString()]
    );

    const ctx = makeToolContext({ organizationId: ACCOUNT_ID });
    ctx.db = pool as never;

    const writeResult = await writeProfile(
      { contact_id: Number(CONTACT_ID), fields: { fullName: 'Alice', email: 'alice@test.com' } },
      ctx
    );
    expect(writeResult.success).toBe(true);

    const readResult = await readProfile(
      { contact_id: Number(CONTACT_ID) },
      ctx
    );
    expect(readResult.success).toBe(true);
    const data = readResult.data as {profile: {fullName: string;email: string;} | null;};
    expect(data.profile?.fullName).toBe('Alice');
    expect(data.profile?.email).toBe('alice@test.com');
  });

  it('write-fact persists a fact with confirmed flag for high confidence', async () => {
    const ctx = makeToolContext({ organizationId: ACCOUNT_ID, conversationKey: 'conv-int' });
    ctx.db = pool as never;

    const result = await writeFact(
      {
        contact_id: Number(CONTACT_ID),
        fact_key: 'favorite_color',
        fact_value: 'blue',
        confidence: 0.9
      },
      ctx
    );
    expect(result.success).toBe(true);
    expect((result.data as {confirmed: boolean;}).confirmed).toBe(true);

    const facts = await pool.query(
      `SELECT fact_key, fact_value, confirmed FROM contact_facts
       WHERE organization_id = $1 AND contact_id = $2 AND superseded_by IS NULL`,
      [ACCOUNT_ID, CONTACT_ID.toString()]
    );
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0].fact_key).toBe('favorite_color');
    expect(facts.rows[0].confirmed).toBe(true);
  });

  it('write-fact supersedes prior fact for same key', async () => {
    const ctx = makeToolContext({ organizationId: ACCOUNT_ID, conversationKey: 'conv-int' });
    ctx.db = pool as never;

    await writeFact(
      {
        contact_id: Number(CONTACT_ID),
        fact_key: 'favorite_color',
        fact_value: 'red',
        confidence: 0.85
      },
      ctx
    );

    const activeFacts = await pool.query(
      `SELECT fact_value FROM contact_facts
       WHERE organization_id = $1 AND contact_id = $2 AND fact_key = 'favorite_color'
         AND superseded_by IS NULL`,
      [ACCOUNT_ID, CONTACT_ID.toString()]
    );
    expect(activeFacts.rows).toHaveLength(1);
    expect(activeFacts.rows[0].fact_value).toBe('red');
  });
});