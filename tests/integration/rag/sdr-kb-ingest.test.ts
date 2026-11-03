/**
 * Task A.4 — SDR L1 KB ingestion integration test.
 *
 * Verifies that SDR knowledge-base fixture documents can be ingested into the
 * existing account-scoped RAG pipeline and subsequently retrieved by source
 * tag, and that account isolation is enforced (a different organizationId cannot
 * retrieve the ingested docs).
 *
 * Gated by RUN_INTEGRATION=1 (requires Docker/testcontainers).
 *
 * Design notes:
 * - Uses PgVectorStore + RecursiveChunker directly (same path the ingest CLI
 *   uses) with deterministic fake embeddings — no LLM call required.
 * - A fake Embedder with stable constant vectors satisfies the RagRetriever
 *   contract: query embedding = chunk embedding = score 1.0 (perfect match).
 * - No src/ modifications: PgVectorStore, RecursiveChunker, RagRetriever are
 *   imported as-is; this is a data-only exercise.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RecursiveChunker } from "../../../src/rag/chunker.js";
import { RagRetriever } from "../../../src/rag/retriever.js";
import type { Embedder } from "../../../src/rag/types.js";
import { PgVectorStore } from "../../../src/rag/vector-store.js";

const RUN = process.env.RUN_INTEGRATION === "1";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ---------------------------------------------------------------------------
// Fake embedder — returns a stable 1536-dim constant vector for every input.
// Since all chunks and the query share the same direction, cosine similarity
// is 1.0, making the test independent of embedding quality while exercising
// the full storage/retrieval path.
// ---------------------------------------------------------------------------
const EMBEDDING_DIM = 1536;

function constantVector(seed: number): number[] {
  // All components equal to seed / sqrt(dim) → unit vector in constant direction.
  const val = seed / Math.sqrt(EMBEDDING_DIM);
  return new Array<number>(EMBEDDING_DIM).fill(val);
}

class FakeEmbedder implements Embedder {
  readonly model = "fake-embedder-v1";
  readonly dim = EMBEDDING_DIM;

  async embed(texts: string[]): Promise<number[][]> {
    // All texts get the same unit vector so retrieval always succeeds.
    return texts.map(() => constantVector(1));
  }
}

// ---------------------------------------------------------------------------
// Account constants
// ---------------------------------------------------------------------------
const TEST_ACCOUNT_ID = 900; // SDR test account
const OTHER_ACCOUNT_ID = 901; // different account — must not see TEST_ACCOUNT_ID docs

const SDR_KB_SOURCE = "sdr-icp";

const KB_DIR = join(__dirname, "..", "..", "fixtures", "sdr", "kb");

describe.skipIf(!RUN)("SDR KB ingestion (integration)", () => {
  let pool: Pool;
  let store: PgVectorStore;
  let retriever: RagRetriever;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const url = pg.getConnectionUri();
    pool = new Pool({ connectionString: url });

    // Bootstrap accounts table (required by migration FK) and insert test accounts.
    await pool.query("CREATE TABLE accounts (id SERIAL PRIMARY KEY, name TEXT)");
    await pool.query(
      "INSERT INTO accounts (id, name) VALUES ($1, $2), ($3, $4)",
      [TEST_ACCOUNT_ID, "sdr-test-account", OTHER_ACCOUNT_ID, "other-account"],
    );

    // Apply only the RAG migration — no full migration set needed.
    const migrationSql = await readFile(
      join(__dirname, "..", "..", "..", "migrations", "006_rag_embeddings.sql"),
      "utf8",
    );
    const downIdx = migrationSql.indexOf("-- DOWN");
    const upSql = downIdx >= 0 ? migrationSql.slice(0, downIdx) : migrationSql;
    await pool.query(upSql);

    store = new PgVectorStore(pool);
    retriever = new RagRetriever(new FakeEmbedder(), store);

    teardown = async () => {
      await pool.end();
      await pg.stop();
    };
  }, 180_000);

  afterAll(async () => {
    if (teardown) await teardown();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Helper: ingest a single fixture file into the test account using the
  // same pipeline as the ingest CLI (PgVectorStore.upsertDocument +
  // RecursiveChunker + replaceChunks) but with fake embeddings.
  // -------------------------------------------------------------------------
  async function ingestFixture(
    filename: string,
    organizationId: number,
    source: string,
  ): Promise<number> {
    const content = await readFile(join(KB_DIR, filename), "utf8");
    const externalId = filename;
    const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
    const title = firstLine.replace(/^#+\s*/, "") || externalId;

    const docId = await store.upsertDocument({
      organizationId,
      source,
      externalId,
      title,
      content,
    });

    const chunker = new RecursiveChunker();
    const chunks = chunker.chunk(content);
    const embedder = new FakeEmbedder();
    const embeddings = await embedder.embed(chunks.map((c) => c.content));

    await store.replaceChunks(
      docId,
      chunks.map((c, i) => ({
        documentId: docId,
        organizationId,
        chunkIndex: i,
        content: c.content,
        tokenCount: c.tokenCount,
        embedding: embeddings[i],
        embeddingModel: embedder.model,
      })),
    );

    return docId;
  }

  // -------------------------------------------------------------------------
  // Test 1: ingest icp-personas.md and retrieve it.
  // -------------------------------------------------------------------------
  it(
    "ingests icp-personas.md and retrieves at least one hit for sdr-icp source",
    async () => {
      await ingestFixture("icp-personas.md", TEST_ACCOUNT_ID, SDR_KB_SOURCE);

      const hits = await retriever.retrieve({
        query: "ICP persona 8-field schema target title objective",
        organizationId: TEST_ACCOUNT_ID,
        source: SDR_KB_SOURCE,
        topK: 5,
        minScore: 0,
      });

      // (a) At least one hit.
      expect(hits.length).toBeGreaterThan(0);

      // (b) Hit content matches the ingested ICP doc — look for a distinctive
      //     term that only appears in icp-personas.md.
      const allContent = hits.map((h) => h.content).join("\n");
      expect(allContent).toMatch(/persona|ICP|8.field|Target Title/i);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Test 2: ingest all SDR KB docs and verify multi-doc retrieval.
  // -------------------------------------------------------------------------
  it(
    "ingests all SDR KB fixture docs and retrieves relevant hits per query",
    async () => {
      // Ingest the remaining docs (icp-personas already ingested in test 1
      // — upsert is idempotent, so re-ingesting is safe).
      for (const filename of [
        "icp-personas.md",
        "pact-rubric.md",
        "lead-taxonomy.md",
        "red-flags.md",
        "exemplars.md",
      ]) {
        await ingestFixture(filename, TEST_ACCOUNT_ID, SDR_KB_SOURCE);
      }

      // Verify PACT-related query hits pact-rubric content.
      const pactHits = await retriever.retrieve({
        query: "PACT qualification Pain Authority Consequence Target profile",
        organizationId: TEST_ACCOUNT_ID,
        source: SDR_KB_SOURCE,
        topK: 5,
        minScore: 0,
      });
      expect(pactHits.length).toBeGreaterThan(0);
      const pactContent = pactHits.map((h) => h.content).join("\n");
      expect(pactContent).toMatch(/PACT|Pain|Authority|Consequence/i);

      // Verify lead-type query hits lead-taxonomy content.
      const leadHits = await retriever.retrieve({
        query: "Seeds Nets Spears lead taxonomy ABCD segmentation",
        organizationId: TEST_ACCOUNT_ID,
        source: SDR_KB_SOURCE,
        topK: 5,
        minScore: 0,
      });
      expect(leadHits.length).toBeGreaterThan(0);
      const leadContent = leadHits.map((h) => h.content).join("\n");
      expect(leadContent).toMatch(/Seeds|Nets|Spears|ABCD/i);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Test 3: account isolation — OTHER_ACCOUNT_ID must not see TEST_ACCOUNT_ID docs.
  // -------------------------------------------------------------------------
  it(
    "enforces account scoping — different organizationId returns no hits for sdr-icp",
    async () => {
      // Ensure test account has data (may already exist from test 2).
      await ingestFixture("icp-personas.md", TEST_ACCOUNT_ID, SDR_KB_SOURCE);

      // Retrieve as OTHER_ACCOUNT_ID — should return nothing.
      const isolated = await retriever.retrieve({
        query: "ICP persona 8-field schema target title objective",
        organizationId: OTHER_ACCOUNT_ID,
        source: SDR_KB_SOURCE,
        topK: 10,
        minScore: 0,
      });

      expect(isolated).toHaveLength(0);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Test 4: source isolation — docs ingested under sdr-icp must not appear
  // when querying a different source tag.
  // -------------------------------------------------------------------------
  it(
    "enforces source scoping — sdr-icp docs do not appear under a different source tag",
    async () => {
      const wrongSourceHits = await retriever.retrieve({
        query: "ICP persona 8-field schema",
        organizationId: TEST_ACCOUNT_ID,
        source: "faq", // different source tag
        topK: 10,
        minScore: 0,
      });

      // None of these hits should have source "sdr-icp".
      for (const h of wrongSourceHits) {
        expect(h.source).not.toBe(SDR_KB_SOURCE);
      }
    },
    60_000,
  );
});
