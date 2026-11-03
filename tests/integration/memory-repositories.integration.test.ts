import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setupInfra, applyMigrations } from "../helpers/integration-setup.js";
import { ContactProfileRepository } from "../../src/memory/contact-profile.repository.js";
import { ContactFactsRepository } from "../../src/memory/contact-facts.repository.js";

const RUN = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!RUN)('memory repositories (integration)', () => {
  let teardown: () => Promise<void>;
  let pool: Pool;

  beforeAll(async () => {
    // setupInfra applies real migrations which reference accounts(id).
    // Use an empty migrations dir to skip the auto-apply, then seed accounts
    // manually before running migrations ourselves.
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

  it('ContactProfileRepository.findOrCreate + update roundtrip', async () => {
    const repo = new ContactProfileRepository(pool);
    const profile = await repo.findOrCreate(1, 1001n);
    expect(profile.organizationId).toBe(1);
    expect(profile.contactId).toBe(1001n);
    expect(profile.totalInteractions).toBe(1);

    await repo.update(1, 1001n, { fullName: 'Ada Lovelace', email: 'ada@example.com' });
    const updated = await repo.findByContact(1, 1001n);
    expect(updated?.fullName).toBe('Ada Lovelace');
    expect(updated?.email).toBe('ada@example.com');
  });

  it('findOrCreate increments total_interactions on conflict', async () => {
    const repo = new ContactProfileRepository(pool);
    await repo.findOrCreate(1, 1002n);
    const p2 = await repo.findOrCreate(1, 1002n);
    expect(p2.totalInteractions).toBe(2);
  });

  it('ContactFactsRepository insert + listActive + upsert supersede', async () => {
    const profileRepo = new ContactProfileRepository(pool);
    await profileRepo.findOrCreate(1, 1003n);

    const factsRepo = new ContactFactsRepository(pool);
    const inserted = await factsRepo.insert({
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 1003n,
      factKey: 'favourite_color',
      factValue: 'blue',
      confidence: 0.9
    });
    expect(inserted.confirmed).toBe(true);

    let active = await factsRepo.listActive(1, 1003n);
    expect(active).toHaveLength(1);
    expect(active[0]!.factValue).toBe('blue');

    // Upsert a new value — should supersede the old
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await factsRepo.upsertFact(
        {
          organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          contactId: 1003n,
          factKey: 'favourite_color',
          factValue: 'red',
          confidence: 0.95
        },
        client
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    active = await factsRepo.listActive(1, 1003n);
    expect(active).toHaveLength(1);
    expect(active[0]!.factValue).toBe('red');
  });
});