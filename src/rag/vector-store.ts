/**
 * Sprint D.2 — PgVectorStore.
 *
 * CRUD over rag_documents/rag_chunks plus cosine-similarity top-K.
 *
 * Tenant isolation: `organizationId` is mandatory in similaritySearch and runtime-
 * checked (NOT NULL + typeof === 'string'). Cross-organization leakage is enforced
 * here; regression test `searches without account → throws` exists in unit
 * suite (vector-store.test.ts).
 */

import crypto from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { parseVectorLiteral, toVectorLiteral } from "./embedder.js";
import type {
  RagChunk,
  RagDocument,
  RetrievedChunk,
  SimilaritySearchOptions,
  VectorStore,
} from "./types.js";

interface DocumentRow {
  id: number;
}

interface SimilarityRow {
  chunk_id: number;
  document_id: number;
  content: string;
  metadata: Record<string, unknown>;
  source: string;
  title: string | null;
  score: number;
}

export class PgVectorStore implements VectorStore {
  constructor(private readonly pool: Pool) {}

  async upsertDocument(doc: RagDocument): Promise<number> {
    const contentHash = sha256(doc.content);
    const result = await this.pool.query<DocumentRow>(
      `INSERT INTO rag_documents
         (organization_id, source, external_id, title, content, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (organization_id, source, external_id) DO UPDATE
         SET title = EXCLUDED.title,
             content = EXCLUDED.content,
             content_hash = EXCLUDED.content_hash,
             metadata = EXCLUDED.metadata,
             updated_at = NOW()
       RETURNING id`,
      [
        doc.organizationId,
        doc.source,
        doc.externalId ?? null,
        doc.title ?? null,
        doc.content,
        contentHash,
        JSON.stringify(doc.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("PgVectorStore.upsertDocument: no row returned");
    return row.id;
  }

  /**
   * Replace all chunks for a document atomically. Uses a dedicated client so
   * BEGIN/COMMIT cannot interleave with other pool consumers (G nitpick).
   */
  async replaceChunks(documentId: number, chunks: RagChunk[]): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM rag_chunks WHERE document_id = $1", [documentId]);
      for (const c of chunks) {
        await client.query(
          `INSERT INTO rag_chunks
             (document_id, organization_id, chunk_index, content, token_count,
              embedding, embedding_model, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8::jsonb)`,
          [
            documentId,
            c.organizationId,
            c.chunkIndex,
            c.content,
            c.tokenCount,
            c.embedding ? toVectorLiteral(c.embedding) : null,
            c.embeddingModel ?? null,
            JSON.stringify(c.metadata ?? {}),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async similaritySearch(opts: SimilaritySearchOptions): Promise<RetrievedChunk[]> {
    // Tenant guard — must come before any SQL touches rag_chunks.
    if (opts.organizationId === null || opts.organizationId === undefined) {
      throw new Error(
        "PgVectorStore.similaritySearch: organizationId is required (tenant isolation)",
      );
    }
    if (typeof opts.organizationId !== "string" || opts.organizationId.trim().length === 0) {
      throw new Error(
        `PgVectorStore.similaritySearch: organizationId must be a non-empty string, got ${String(opts.organizationId)}`,
      );
    }
    if (opts.queryEmbedding.length === 0) {
      throw new Error("PgVectorStore.similaritySearch: queryEmbedding is empty");
    }
    if (opts.topK <= 0) return [];

    const sources = opts.source ? (Array.isArray(opts.source) ? opts.source : [opts.source]) : null;

    const result = await this.pool.query<SimilarityRow>(
      `SELECT c.id            AS chunk_id,
              c.document_id   AS document_id,
              c.content       AS content,
              c.metadata      AS metadata,
              d.source        AS source,
              d.title         AS title,
              (1 - (c.embedding <=> $1::vector))::float AS score
         FROM rag_chunks c
         JOIN rag_documents d ON d.id = c.document_id
        WHERE c.organization_id = $2
          AND c.embedding IS NOT NULL
          AND ($3::text[] IS NULL OR d.source = ANY($3::text[]))
          AND ($4::text IS NULL OR c.embedding_model = $4)
        ORDER BY c.embedding <=> $1::vector
        LIMIT $5`,
      [
        toVectorLiteral(opts.queryEmbedding),
        opts.organizationId,
        sources,
        opts.embeddingModel ?? null,
        opts.topK,
      ],
    );

    const minScore = opts.minScore ?? 0;
    return result.rows
      .filter((r) => r.score >= minScore)
      .map((r) => ({
        chunkId: r.chunk_id,
        documentId: r.document_id,
        content: r.content,
        score: r.score,
        source: r.source,
        title: r.title ?? undefined,
        metadata: r.metadata ?? {},
      }));
  }
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Re-export helpers for tests.
export { parseVectorLiteral, toVectorLiteral };
