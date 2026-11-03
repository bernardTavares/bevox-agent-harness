/**
 * Why this test exists
 * ====================
 *
 * `RagRetriever(embedder, store)` takes its two collaborators via constructor
 * injection. The rest of the harness reaches the retriever through a
 * module-level singleton in `src/rag/registry.ts` (`getRetriever()` /
 * `setRetriever()`) — same pattern as `PermissionAuditLogger` / `RateLimiter`.
 *
 * PR 4 of the reasoning-engine refactor (see
 * `docs/superpowers/specs/2026-06-03-reasoning-engine-quality-design.md`)
 * will move that singleton off the module scope and onto
 * `ctx.retriever` (per-execution context). When that refactor happens, the
 * contract that MUST NOT regress is:
 *
 *   `RagRetriever.retrieve()` consults ONLY the deps it received in its
 *   constructor — not `getRetriever()`, not any other module-level state.
 *
 * If someone accidentally rewrites `retrieve()` to fall back to the global
 * (a tempting "defensive default"), tenant isolation breaks: a test setup
 * could inject a tenant-A retriever while the global still points at
 * tenant-B's store. This file pins the contract by:
 *
 *   1. Installing a SABOTAGE retriever in the global via `setRetriever()`.
 *      Its `retrieve()` throws if called — so any code path that consults
 *      the global instead of the injected deps fails loudly.
 *   2. Constructing `RagRetriever(embedder, store)` with fresh mock deps.
 *   3. Asserting the injected mocks were called AND the sabotage was not.
 *
 * Sentinel guard precedes shape assertions: we first prove the injected
 * embedder/store were actually exercised, then check call shapes. That way
 * a future "everything is undefined, every assertion is vacuously true"
 * regression cannot pass silently.
 *
 * Scope is intentionally tight — this is a regression guard for the
 * injection contract, not a re-test of retrieval semantics. The broader
 * behavioral coverage (empty query, topK forwarding, etc.) lives in
 * `retriever.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RagRetriever } from "../../../src/rag/retriever.js";
import { resetRetrieverForTests, setRetriever } from "../../../src/rag/registry.js";
import type {
  Embedder,
  RetrievedChunk,
  Retriever,
  SimilaritySearchOptions,
  VectorStore,
} from "../../../src/rag/types.js";

const ORG_ID = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";

/** A retriever that throws if anyone calls it. Used as the global sentinel. */
function makeSabotageRetriever(): Retriever {
  return {
    async retrieve() {
      throw new Error(
        "REGRESSION: RagRetriever consulted the module-level getRetriever() singleton " +
          "instead of its constructor-injected deps. PR 4 contract violated.",
      );
    },
  };
}

describe("RagRetriever — constructor injection regression guard (PR 4 contract)", () => {
  beforeEach(() => {
    // Plant a tripwire in the global slot. If the SUT touches it, the test fails.
    setRetriever(makeSabotageRetriever());
  });

  afterEach(() => {
    resetRetrieverForTests();
  });

  it("retrieve() flows through the constructor-injected embedder and store ONLY", async () => {
    const embed = vi.fn<Embedder["embed"]>().mockResolvedValue([[0.11, 0.22, 0.33]]);
    const embedder: Embedder = {
      model: "text-embedding-3-small-test",
      dim: 3,
      embed,
    };

    const fixture: RetrievedChunk[] = [
      {
        chunkId: 42,
        documentId: 7,
        content: "injected-doc",
        score: 0.88,
        source: "faq",
        metadata: { provenance: "constructor-injected" },
      },
    ];
    const similaritySearch = vi
      .fn<VectorStore["similaritySearch"]>()
      .mockResolvedValue(fixture);
    const store: VectorStore = {
      upsertDocument: vi.fn(async () => 1),
      replaceChunks: vi.fn(async () => undefined),
      similaritySearch,
    };

    const retriever = new RagRetriever(embedder, store);
    const out = await retriever.retrieve({
      query: "what are the studio hours",
      organizationId: ORG_ID,
      source: "faq",
      topK: 4,
    });

    // ── Sentinel guard: prove the injected deps actually flowed.
    //    These must hold BEFORE any shape assertion — otherwise the test
    //    could pass vacuously if the SUT silently no-op'd.
    expect(embed.mock.calls.length).toBeGreaterThan(0);
    expect(similaritySearch.mock.calls.length).toBeGreaterThan(0);

    // ── Shape: embedder received the raw query as a singleton batch.
    expect(embed).toHaveBeenCalledWith(["what are the studio hours"]);

    // ── Shape: store received the embedding produced by THIS embedder
    //    (not whatever the sabotage global might have returned), plus
    //    the tenant + retrieval params unchanged from the caller.
    expect(similaritySearch).toHaveBeenCalledTimes(1);
    const searchArg = similaritySearch.mock.calls[0]?.[0];
    expect(searchArg).toMatchObject<Partial<SimilaritySearchOptions>>({
      queryEmbedding: [0.11, 0.22, 0.33],
      organizationId: ORG_ID,
      source: "faq",
      topK: 4,
    });

    // ── Result is whatever the injected store returned, unchanged.
    expect(out).toMatchObject([
      {
        chunkId: 42,
        content: "injected-doc",
        metadata: { provenance: "constructor-injected" },
      },
    ]);
  });

  it("two RagRetriever instances with different deps do not cross-contaminate via the global", async () => {
    // Tenant-A wiring.
    const embedA = vi.fn<Embedder["embed"]>().mockResolvedValue([[1, 0, 0]]);
    const searchA = vi.fn<VectorStore["similaritySearch"]>().mockResolvedValue([
      {
        chunkId: 1,
        documentId: 1,
        content: "from-A",
        score: 0.9,
        source: "faq",
        metadata: {},
      },
    ]);
    const retrieverA = new RagRetriever(
      { model: "m-a", dim: 3, embed: embedA },
      {
        upsertDocument: vi.fn(async () => 1),
        replaceChunks: vi.fn(async () => undefined),
        similaritySearch: searchA,
      },
    );

    // Tenant-B wiring — distinct mocks, distinct fixture content.
    const embedB = vi.fn<Embedder["embed"]>().mockResolvedValue([[0, 1, 0]]);
    const searchB = vi.fn<VectorStore["similaritySearch"]>().mockResolvedValue([
      {
        chunkId: 2,
        documentId: 2,
        content: "from-B",
        score: 0.8,
        source: "faq",
        metadata: {},
      },
    ]);
    const retrieverB = new RagRetriever(
      { model: "m-b", dim: 3, embed: embedB },
      {
        upsertDocument: vi.fn(async () => 1),
        replaceChunks: vi.fn(async () => undefined),
        similaritySearch: searchB,
      },
    );

    const outA = await retrieverA.retrieve({ query: "q", organizationId: ORG_ID });
    const outB = await retrieverB.retrieve({ query: "q", organizationId: ORG_ID });

    // Sentinel guard: each instance touched ONLY its own deps.
    expect(embedA).toHaveBeenCalledTimes(1);
    expect(embedB).toHaveBeenCalledTimes(1);
    expect(searchA).toHaveBeenCalledTimes(1);
    expect(searchB).toHaveBeenCalledTimes(1);

    // Results carry the per-instance fixture content unchanged.
    expect(outA[0]).toMatchObject({ content: "from-A" });
    expect(outB[0]).toMatchObject({ content: "from-B" });

    // Cross-check: B's store never saw A's embedding and vice versa.
    expect(searchA.mock.calls[0]?.[0].queryEmbedding).toEqual([1, 0, 0]);
    expect(searchB.mock.calls[0]?.[0].queryEmbedding).toEqual([0, 1, 0]);
  });
});
