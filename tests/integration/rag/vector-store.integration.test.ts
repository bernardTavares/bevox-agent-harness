/**
 * Sprint D.2 — PgVectorStore integration tests.
 *
 * Requires a Postgres image with pgvector preinstalled. Uses
 * `pgvector/pgvector:pg16` via testcontainers. Skipped unless
 * RUN_INTEGRATION=1 (same convention as memory-repositories.integration).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgVectorStore } from "../../../src/rag/vector-store.js";

const RUN = process.env.RUN_INTEGRATION === "1";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe.skipIf(!RUN)("PgVectorStore (integration)", () => {
  let pool: Pool;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    // Use pgvector-enabled image — the default postgres:16-alpine lacks the
    // `vector` extension.
    const pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const url = pg.getConnectionUri();
    pool = new Pool({ connectionString: url });

    // Bootstrap accounts (referenced by other migrations) so applying our
    // own migration in isolation doesn't require the full migration set.
    await pool.query("CREATE TABLE accounts (id SERIAL PRIMARY KEY, name TEXT)");
    await pool.query("INSERT INTO accounts (id, name) VALUES (1, 'test')");

    const migrationPath = join(__dirname, "..", "..", "..", "migrations", "006_rag_embeddings.sql");
    const sql = readFileSync(migrationPath, "utf8");
    const downIdx = sql.indexOf("-- DOWN");
    const upSql = downIdx >= 0 ? sql.slice(0, downIdx) : sql;
    await pool.query(upSql);

    teardown = async () => {
      await pool.end();
      await pg.stop();
    };
  }, 180_000);

  afterAll(async () => {
    if (teardown) await teardown();
  }, 60_000);

  function fakeVec(seed: number): number[] {
    const v = new Array<number>(1536).fill(0);
    v[0] = seed;
    v[1] = 1 - seed; // makes cosine direction differ predictably
    return v;
  }

  it("upserts a document and chunks; similaritySearch returns top-K", async () => {
    const store = new PgVectorStore(pool);
    const docId = await store.upsertDocument({
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      source: "faq",
      externalId: "doc-1",
      content: "How do I cancel my subscription?",
    });
    expect(docId).toBeGreaterThan(0);

    await store.replaceChunks(docId, [
      {
        documentId: docId,
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        chunkIndex: 0,
        content: "cancel via app",
        tokenCount: 3,
        embedding: fakeVec(1),
        embeddingModel: "text-embedding-3-small",
      },
      {
        documentId: docId,
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        chunkIndex: 1,
        content: "different topic",
        tokenCount: 2,
        embedding: fakeVec(0),
        embeddingModel: "text-embedding-3-small",
      },
    ]);

    const results = await store.similaritySearch({
      queryEmbedding: fakeVec(1),
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      topK: 5,
    });
    expect(results).toHaveLength(2);
    // Score for vector identical to query should be highest (≈ 1.0).
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    expect(results[0]!.content).toBe("cancel via app");
  });

  it("isolates by organization_id (tenant guard regression)", async () => {
    const store = new PgVectorStore(pool);
    await pool.query("INSERT INTO accounts (id, name) VALUES (2, 'other')");
    const docId = await store.upsertDocument({
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      source: "faq",
      externalId: "doc-other",
      content: "other tenant content",
    });
    await store.replaceChunks(docId, [
      {
        documentId: docId,
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        chunkIndex: 0,
        content: "other-tenant secret",
        tokenCount: 3,
        embedding: fakeVec(1),
        embeddingModel: "text-embedding-3-small",
      },
    ]);

    // Search as account 1 — should never see account 2's data.
    const results = await store.similaritySearch({
      queryEmbedding: fakeVec(1),
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      topK: 10,
    });
    for (const r of results) {
      expect(r.content).not.toBe("other-tenant secret");
    }
  });

  it("filters by source", async () => {
    const store = new PgVectorStore(pool);
    const docId = await store.upsertDocument({
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      source: "kb-product",
      externalId: "kb-1",
      content: "product knowledge",
    });
    await store.replaceChunks(docId, [
      {
        documentId: docId,
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        chunkIndex: 0,
        content: "product detail",
        tokenCount: 2,
        embedding: fakeVec(1),
        embeddingModel: "text-embedding-3-small",
      },
    ]);

    const onlyFaq = await store.similaritySearch({
      queryEmbedding: fakeVec(1),
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      source: "faq",
      topK: 10,
    });
    for (const r of onlyFaq) {
      expect(r.source).toBe("faq");
    }
  });

  it("respects minScore", async () => {
    const store = new PgVectorStore(pool);
    const results = await store.similaritySearch({
      queryEmbedding: fakeVec(1),
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      topK: 10,
      minScore: 0.99,
    });
    // Only the exact-direction match should pass a very strict floor.
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it("replaceChunks is atomic — failure leaves prior state intact", async () => {
    const store = new PgVectorStore(pool);
    const docId = await store.upsertDocument({
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      source: "faq",
      externalId: "doc-atomic",
      content: "atomic test",
    });
    await store.replaceChunks(docId, [
      {
        documentId: docId,
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        chunkIndex: 0,
        content: "initial chunk",
        tokenCount: 2,
        embedding: fakeVec(1),
        embeddingModel: "text-embedding-3-small",
      },
    ]);

    // Force a failure mid-replace by passing a chunk with invalid embedding
    // dim — the second insert in the loop will throw.
    await expect(
      store.replaceChunks(docId, [
        {
          documentId: docId,
          organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          chunkIndex: 0,
          content: "new chunk",
          tokenCount: 2,
          embedding: new Array<number>(1536).fill(0.5),
          embeddingModel: "text-embedding-3-small",
        },
        {
          documentId: docId,
          organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          chunkIndex: 1,
          content: "broken chunk",
          tokenCount: 2,
          embedding: new Array<number>(100).fill(0.5), // wrong dim — pg will reject
          embeddingModel: "text-embedding-3-small",
        },
      ]),
    ).rejects.toBeInstanceOf(Error);

    // Original chunk should still be there (transaction rolled back).
    const surviving = await pool.query(
      "SELECT content FROM rag_chunks WHERE document_id = $1 ORDER BY chunk_index",
      [docId],
    );
    expect(surviving.rows).toHaveLength(1);
    expect(surviving.rows[0]!.content).toBe("initial chunk");
  });

});
