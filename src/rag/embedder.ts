/**
 * Sprint D.2 — CachingEmbedder.
 *
 * Wraps an `LLMEmbedder` with a content-addressed cache (rag_embedding_cache)
 * keyed by (model, sha256(text)). Same text + same model = zero provider call
 * across deployments. Batches missing texts in groups of ≤100 (OpenAI's
 * batch limit; Gemini accepts more but we use the same cap for symmetry).
 *
 * Storage format note: pgvector accepts `[1,2,3]` text literal; we cast
 * `$N::vector` in INSERT so both bytea-shape and pure JS arrays work without
 * the `pgvector-node` dep.
 */

import crypto from "node:crypto";

import type { Pool } from "pg";

import type { LLMEmbedder } from "../integration/llm/embedder.js";

import type { Embedder } from "./types.js";

const PROVIDER_BATCH_SIZE = 100;

export interface CachingEmbedderOptions {
  /** Override model (must match underlying LLMEmbedder.model). */
  model?: string;
  /** Override dim. Used by tests / multi-dim guard. */
  dim?: number;
  /** If false, skips cache reads & writes (debug only). Default true. */
  cacheEnabled?: boolean;
}

export class CachingEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private readonly cacheEnabled: boolean;

  constructor(
    private readonly llm: LLMEmbedder,
    private readonly db: Pool,
    opts: CachingEmbedderOptions = {},
  ) {
    this.model = opts.model ?? llm.model;
    this.dim = opts.dim ?? llm.dim;
    this.cacheEnabled = opts.cacheEnabled !== false;

    // Multi-dim guard (G correção pós-review): until a multi-dim schema
    // exists, fail loudly if the embedder reports anything other than 1536.
    if (this.dim !== 1536) {
      throw new Error(
        `CachingEmbedder: dim=${this.dim} not supported. Schema rag_chunks.embedding is vector(1536). ` +
          `Add a migration before changing RAG_EMBEDDING_DIM.`,
      );
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const hashes = texts.map((t) => sha256(t));
    const result: (number[] | null)[] = new Array(texts.length).fill(null);

    // 1) Cache lookup.
    if (this.cacheEnabled) {
      const uniqueHashes = Array.from(new Set(hashes));
      const cached = await this.db.query<{ content_hash: string; embedding: string }>(
        `SELECT content_hash, embedding::text AS embedding
           FROM rag_embedding_cache
          WHERE model = $1 AND content_hash = ANY($2::text[])`,
        [this.model, uniqueHashes],
      );
      const hashToVec = new Map<string, number[]>();
      for (const row of cached.rows) {
        hashToVec.set(row.content_hash, parseVectorLiteral(row.embedding));
      }
      for (let i = 0; i < texts.length; i++) {
        const v = hashToVec.get(hashes[i]!);
        if (v) result[i] = v;
      }
    }

    // 2) Collect indices still missing; embed in batches.
    const missingIdx: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (result[i] === null) missingIdx.push(i);
    }

    for (let off = 0; off < missingIdx.length; off += PROVIDER_BATCH_SIZE) {
      const batchIdx = missingIdx.slice(off, off + PROVIDER_BATCH_SIZE);
      const batchTexts = batchIdx.map((i) => texts[i]!);
      const resp = await this.llm.embed({ inputs: batchTexts });
      if (resp.embeddings.length !== batchTexts.length) {
        throw new Error(
          `CachingEmbedder: provider returned ${resp.embeddings.length} embeddings for ${batchTexts.length} inputs`,
        );
      }
      for (let j = 0; j < batchIdx.length; j++) {
        const idx = batchIdx[j]!;
        const emb = resp.embeddings[j]!;
        if (emb.length !== this.dim) {
          throw new Error(
            `CachingEmbedder: dim mismatch — expected ${this.dim}, got ${emb.length}`,
          );
        }
        result[idx] = emb;
      }

      // 3) Write through to cache (best-effort, single statement w/ unnest).
      if (this.cacheEnabled) {
        const uniquePairs = new Map<string, number[]>();
        for (let j = 0; j < batchIdx.length; j++) {
          uniquePairs.set(hashes[batchIdx[j]!]!, resp.embeddings[j]!);
        }
        const hashArr: string[] = [];
        const vecArr: string[] = [];
        for (const [h, v] of uniquePairs) {
          hashArr.push(h);
          vecArr.push(toVectorLiteral(v));
        }
        if (hashArr.length > 0) {
          await this.db.query(
            `INSERT INTO rag_embedding_cache (model, content_hash, embedding)
                 SELECT $1, h, v::vector
                   FROM UNNEST($2::text[], $3::text[]) AS t(h, v)
             ON CONFLICT (model, content_hash) DO NOTHING`,
            [this.model, hashArr, vecArr],
          );
        }
      }
    }

    return result.map((v, i) => {
      if (!v) throw new Error(`CachingEmbedder: missing embedding for index ${i}`);
      return v;
    });
  }
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export function parseVectorLiteral(s: string): number[] {
  // pgvector returns "[v1,v2,...]" as text.
  const trimmed = s.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`parseVectorLiteral: malformed vector literal: ${s.slice(0, 32)}…`);
  }
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((x) => Number.parseFloat(x.trim()));
}
