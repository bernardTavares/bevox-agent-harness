/**
 * Sprint D.3 — semantic recall + indexer integration.
 *
 * Boots a postgres container (via testcontainers), applies migrations
 * 001-007, seeds an account, indexes a small set of canned messages with
 * a stub embedder, then exercises RagSemanticRecall and verifies that
 * superseded messages are excluded.
 *
 * Gated by RUN_INTEGRATION=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { setupInfra, applyMigrations } from "../../helpers/integration-setup.js";
import { MessageEmbeddingIndexer } from "../../../src/memory/message-embedding-indexer.js";
import { RagSemanticRecall } from "../../../src/memory/semantic-recall.js";
import type { Embedder } from "../../../src/rag/types.js";

const RUN = process.env.RUN_INTEGRATION === "1";

/**
 * Deterministic stub embedder — produces a vector that points in a direction
 * derived from a keyword in the content. Lets the test assert which messages
 * rank higher for a given query without needing a real provider.
 */
function makeStubEmbedder(): Embedder {
  // Two orthogonal directions in 1536-D; map keywords to one of them.
  const dirA = new Array(1536).fill(0);
  dirA[0] = 1; // "agendamento"
  const dirB = new Array(1536).fill(0);
  dirB[1] = 1; // "endereco"
  return {
    model: "stub-embed",
    dim: 1536,
    embed: async (texts: string[]) =>
      texts.map((t) => {
        const lower = t.toLowerCase();
        if (lower.includes("agendamento") || lower.includes("remarcar") || lower.includes("horario")) {
          return dirA.slice();
        }
        if (lower.includes("endereco") || lower.includes("cep")) {
          return dirB.slice();
        }
        // mid-vector — low similarity to both
        const mid = new Array(1536).fill(0);
        mid[2] = 1;
        return mid;
      }),
  };
}

describe.skipIf(!RUN)("D.3 semantic recall (integration)", () => {
  let teardown: () => Promise<void>;
  let pool: Pool;

  beforeAll(async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "harness-d3-empty-mig-"));
    const infra = await setupInfra({ migrationsDir: emptyDir });
    teardown = infra.teardown;
    pool = new Pool({ connectionString: infra.databaseUrl });
    await pool.query(`
      CREATE TABLE accounts (id SERIAL PRIMARY KEY, name TEXT);
      INSERT INTO accounts (id, name) VALUES (1, 'test');
    `);
    // pgvector must exist before migration 006/007 apply.
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await applyMigrations(
      infra.databaseUrl,
      join(__dirname, "..", "..", "..", "migrations"),
    );
  }, 180_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (teardown) await teardown();
  }, 60_000);

  it("indexes messages and retrieves semantically similar ones, skipping recents and supersededs", async () => {
    const embedder = makeStubEmbedder();
    const indexer = new MessageEmbeddingIndexer(pool, embedder);

    // Seed 12 historical messages alternating topics.
    const baseDate = new Date("2024-01-01T00:00:00Z");
    const messages = [];
    for (let i = 0; i < 12; i++) {
      const topic = i % 2 === 0 ? "agendamento sexta" : "endereco do consultorio";
      messages.push({
        messageId: `m${i}`,
        role: "user" as const,
        content: `historico ${i}: ${topic}`,
        messageAt: new Date(baseDate.getTime() + i * 60_000),
      });
    }
    const r = await indexer.index(1, 99n, messages);
    expect(r.indexed).toBe(12);

    const recall = new RagSemanticRecall(pool, embedder, {
      topK: 5,
      minScore: 0.5,
      excludeRecent: 4,
    });
    const out = await recall.recall({
      query: "preciso remarcar o horario",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 99n,
    });

    // All matches must come from the "agendamento" topic and be NOT among the
    // 4 most-recent messages (which were "endereco" because i=11 is odd).
    expect(out.length).toBeGreaterThan(0);
    for (const m of out) {
      expect(m.content.toLowerCase()).toContain("agendamento");
    }

    // Now supersede one of those messages; it must disappear from recall.
    const toSupersede = out[0]!.messageId;
    await pool.query("INSERT INTO contact_facts (organization_id, contact_id, fact_key, fact_value, category, confidence, confirmed) VALUES (1, 99, 'summary:test', 'covered', 'summary', 0.7, false) RETURNING id");
    const fact = await pool.query<{ id: string }>(
      "SELECT id FROM contact_facts WHERE organization_id=1 AND contact_id=99 AND category='summary' ORDER BY id DESC LIMIT 1",
    );
    await pool.query(
      "UPDATE message_embeddings SET superseded_by_summary_fact_id=$1 WHERE message_id=$2",
      [fact.rows[0]!.id, toSupersede],
    );

    const out2 = await recall.recall({
      query: "preciso remarcar o horario",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 99n,
    });
    expect(out2.find((m) => m.messageId === toSupersede)).toBeUndefined();
  }, 120_000);
});
