import { describe, expect, it, vi } from "vitest";

import { RagRetriever } from "../../../src/rag/retriever.js";
import type {
  Embedder,
  RetrievedChunk,
  SimilaritySearchOptions,
  VectorStore,
} from "../../../src/rag/types.js";

function makeEmbedder(dim = 1536): Embedder {
  return {
    model: "text-embedding-3-small",
    dim,
    async embed(texts) {
      return texts.map(() => new Array<number>(dim).fill(0.1));
    },
  };
}

function makeStore(results: RetrievedChunk[]): {
  store: VectorStore;
  lastCall: () => SimilaritySearchOptions | undefined;
} {
  let lastCall: SimilaritySearchOptions | undefined;
  const store: VectorStore = {
    async upsertDocument() {
      return 1;
    },
    async replaceChunks() {
      /* noop */
    },
    async similaritySearch(opts) {
      lastCall = opts;
      return results;
    },
  };
  return { store, lastCall: () => lastCall };
}

describe("RagRetriever", () => {
  it("returns [] for empty query without embedding", async () => {
    const embedder = makeEmbedder();
    const embedSpy = vi.spyOn(embedder, "embed");
    const { store } = makeStore([]);
    const r = new RagRetriever(embedder, store);
    expect(
      await r.retrieve({ query: "", organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b" }),
    ).toEqual([]);
    expect(
      await r.retrieve({ query: "   ", organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b" }),
    ).toEqual([]);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("forwards organizationId/source/topK to the store", async () => {
    const { store, lastCall } = makeStore([]);
    const r = new RagRetriever(makeEmbedder(), store);
    await r.retrieve({
      query: "x",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      source: "faq",
      topK: 7,
    });
    expect(lastCall()?.organizationId).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
    expect(lastCall()?.source).toBe("faq");
    expect(lastCall()?.topK).toBe(7);
  });

  it("uses RAG_TOP_K_DEFAULT when topK omitted", async () => {
    const { store, lastCall } = makeStore([]);
    const r = new RagRetriever(makeEmbedder(), store);
    await r.retrieve({ query: "x", organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b" });
    // env default is 5
    expect(lastCall()?.topK).toBe(5);
  });

  it("returns store results unchanged (no re-ranking)", async () => {
    const fixture: RetrievedChunk[] = [
      { chunkId: 1, documentId: 10, content: "a", score: 0.9, source: "faq", metadata: {} },
      { chunkId: 2, documentId: 10, content: "b", score: 0.7, source: "faq", metadata: {} },
    ];
    const { store } = makeStore(fixture);
    const r = new RagRetriever(makeEmbedder(), store);
    const out = await r.retrieve({
      query: "x",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    });
    expect(out).toEqual(fixture);
  });
});
