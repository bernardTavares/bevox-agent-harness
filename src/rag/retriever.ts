/**
 * Sprint D.2 — RagRetriever: query → embed → vector search.
 *
 * Thin orchestration over `Embedder` + `VectorStore`. Wraps the call in an
 * OTEL span `rag.retrieve` (no-op when OTEL_ENABLED=false). topK defaulted
 * via env (`RAG_TOP_K_DEFAULT`). minScore is opt-in; surface tools that need
 * a quality bar (e.g. search-faq) pass their own threshold.
 */

import { getEnv } from "../config/env.js";
import { withSpan } from "../observability/spans.js";

import type { Embedder, RetrieveOptions, RetrievedChunk, Retriever, VectorStore } from "./types.js";

export class RagRetriever implements Retriever {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
  ) {}

  async retrieve(opts: RetrieveOptions): Promise<RetrievedChunk[]> {
    const env = getEnv();
    const topK = opts.topK ?? env.RAG_TOP_K_DEFAULT;
    if (!opts.query || !opts.query.trim()) {
      return [];
    }

    return withSpan(
      "rag.retrieve",
      {
        "rag.organization_id": opts.organizationId,
        "rag.top_k": topK,
        "rag.source": Array.isArray(opts.source)
          ? opts.source.join(",")
          : (opts.source ?? undefined),
        "rag.embedding_model": this.embedder.model,
      },
      async (span) => {
        const embeddings = await this.embedder.embed([opts.query]);
        const queryEmbedding = embeddings[0];
        if (!queryEmbedding) {
          throw new Error("RagRetriever: embedder returned no embedding for query");
        }
        const results = await this.store.similaritySearch({
          queryEmbedding,
          organizationId: opts.organizationId,
          source: opts.source,
          topK,
          minScore: opts.minScore,
        });
        span.setAttribute("rag.results_count", results.length);
        span.setAttribute("rag.top_score", results[0]?.score ?? 0);
        return results;
      },
    );
  }
}
