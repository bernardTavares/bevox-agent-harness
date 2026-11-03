/**
 * Sprint D.3 — Message Embedding Indexer.
 *
 * Indexes new messages into `message_embeddings` (one row per message).
 * Uses content_hash to skip duplicates (same content, same contact).
 * Batches embeddings — the D.2 CachingEmbedder dedups identical content
 * across runs via the `rag_embedding_cache` table.
 *
 * Non-fatal failures: indexer errors must NOT block executions; the caller
 * (execution-handler) runs `.index()` fire-and-forget via queueMicrotask
 * or a BullMQ job.
 */

import crypto from "node:crypto";

import type { Pool } from "pg";

import { estimateTokens } from "../context/tokenizer.js";
import { toVectorLiteral } from "../rag/embedder.js";
import type { Embedder } from "../rag/types.js";

export interface IndexableMessage {
  messageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  messageAt: Date;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
}

export class MessageEmbeddingIndexer {
  constructor(
    private readonly db: Pool,
    private readonly embedder: Embedder,
  ) {}

  async index(
    organizationId: string,
    contactId: bigint,
    messages: IndexableMessage[],
  ): Promise<IndexResult> {
    if (messages.length === 0) return { indexed: 0, skipped: 0 };

    // Skip empty content — embedder providers reject empty strings.
    const candidate = messages.filter((m) => m.content && m.content.trim().length > 0);
    if (candidate.length === 0) return { indexed: 0, skipped: messages.length };

    // 1. Filter by message_id already present (cheap path before embed).
    const ids = candidate.map((m) => m.messageId);
    const existing = await this.db.query<{ message_id: string }>(
      `SELECT message_id FROM message_embeddings
        WHERE organization_id = $1 AND contact_id = $2 AND message_id = ANY($3::text[])`,
      [organizationId, contactId, ids],
    );
    const existingSet = new Set(existing.rows.map((r) => r.message_id));
    const toIndex = candidate.filter((m) => !existingSet.has(m.messageId));
    if (toIndex.length === 0) {
      return { indexed: 0, skipped: messages.length };
    }

    // 2. Embed (CachingEmbedder dedups by sha256 across runs).
    const embeddings = await this.embedder.embed(toIndex.map((m) => m.content));
    if (embeddings.length !== toIndex.length) {
      throw new Error(
        `MessageEmbeddingIndexer: embedder returned ${embeddings.length} for ${toIndex.length}`,
      );
    }

    // 3. Insert; UNIQUE (organization, contact, message_id) → DO NOTHING handles
    // concurrent indexers racing on the same payload.
    for (let i = 0; i < toIndex.length; i++) {
      const m = toIndex[i]!;
      const emb = embeddings[i]!;
      await this.db.query(
        `INSERT INTO message_embeddings
           (organization_id, contact_id, message_id, role, content, content_hash,
            token_count, embedding, embedding_model, message_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10)
         ON CONFLICT (organization_id, contact_id, message_id) DO NOTHING`,
        [
          organizationId,
          contactId,
          m.messageId,
          m.role,
          m.content,
          sha256(m.content),
          estimateTokens(m.content),
          toVectorLiteral(emb),
          this.embedder.model,
          m.messageAt,
        ],
      );
    }

    return { indexed: toIndex.length, skipped: messages.length - toIndex.length };
  }
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
