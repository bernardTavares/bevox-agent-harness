/**
 * Sprint D.3 — Semantic Recall.
 *
 * Given the current user message and a contact, returns top-K historical
 * messages from `message_embeddings` that are semantically similar, excluding
 * the N most recent (which already appear in the chronological History layer).
 *
 * Tenant isolation: `organizationId` is mandatory in the SQL filter; tests assert
 * this. Mensagens com superseded_by_summary_fact_id IS NOT NULL são ignoradas
 * (already covered by a contact_fact summary).
 *
 * Reuses the D.2 `Embedder` interface (caching) — no new embedder lifecycle.
 */

import type { Pool } from "pg";

import { withSpan } from "../observability/spans.js";
import { toVectorLiteral } from "../rag/embedder.js";
import type { Embedder } from "../rag/types.js";

export interface RecalledMessage {
  messageId: string;
  role: string;
  content: string;
  score: number;
  messageAt: Date;
}

export interface SemanticRecallOptions {
  query: string;
  organizationId: string;
  contactId: bigint;
  topK?: number;
  minScore?: number;
  /** Skip the N most-recent messages — they already appear in the History layer. */
  excludeRecent?: number;
}

export interface SemanticRecall {
  recall(opts: SemanticRecallOptions): Promise<RecalledMessage[]>;
}

interface Row {
  message_id: string;
  role: string;
  content: string;
  message_at: Date;
  score: number;
}

export class RagSemanticRecall implements SemanticRecall {
  constructor(
    private readonly db: Pool,
    private readonly embedder: Embedder,
    private readonly defaults: { topK: number; minScore: number; excludeRecent: number } = {
      topK: 5,
      minScore: 0.6,
      excludeRecent: 10,
    },
  ) {}

  async recall(opts: SemanticRecallOptions): Promise<RecalledMessage[]> {
    if (!opts.query || opts.query.trim().length === 0) return [];
    if (typeof opts.organizationId !== "string" || opts.organizationId.trim().length === 0) {
      throw new Error("RagSemanticRecall.recall: organizationId is required (tenant isolation)");
    }

    const topK = opts.topK ?? this.defaults.topK;
    const minScore = opts.minScore ?? this.defaults.minScore;
    const excludeRecent = opts.excludeRecent ?? this.defaults.excludeRecent;

    return withSpan(
      "memory.semantic_recall",
      {
        "memory.organization_id": opts.organizationId,
        "memory.contact_id": String(opts.contactId),
        "memory.top_k": topK,
        "memory.min_score": minScore,
        "memory.exclude_recent": excludeRecent,
      },
      async (span) => {
        const [emb] = await this.embedder.embed([opts.query]);
        if (!emb) return [];
        const vec = toVectorLiteral(emb);

        // Cosine score = 1 - (embedding <=> query). Index on `embedding`
        // is HNSW + vector_cosine_ops (migration 007). The CTE assigns
        // recency_rank so we can skip the N most-recent that are already in
        // the chronological History layer.
        const r = await this.db.query<Row>(
          `WITH ranked AS (
             SELECT message_id,
                    ROW_NUMBER() OVER (ORDER BY message_at DESC) AS recency_rank
               FROM message_embeddings
              WHERE organization_id = $1
                AND contact_id = $2
                AND superseded_by_summary_fact_id IS NULL
                AND embedding IS NOT NULL
           )
           SELECT me.message_id,
                  me.role,
                  me.content,
                  me.message_at,
                  1 - (me.embedding <=> $3::vector) AS score
             FROM message_embeddings me
             JOIN ranked r USING (message_id)
            WHERE me.organization_id = $1
              AND me.contact_id = $2
              AND me.superseded_by_summary_fact_id IS NULL
              AND me.embedding IS NOT NULL
              AND r.recency_rank > $4
            ORDER BY me.embedding <=> $3::vector
            LIMIT $5`,
          [opts.organizationId, opts.contactId, vec, excludeRecent, topK],
        );

        const filtered = r.rows
          .filter((row) => Number(row.score) >= minScore)
          .map((row) => ({
            messageId: row.message_id,
            role: row.role,
            content: row.content,
            score: Number(row.score),
            messageAt: row.message_at,
          }));
        span.setAttribute("memory.recalled_count", filtered.length);
        return filtered;
      },
    );
  }
}
