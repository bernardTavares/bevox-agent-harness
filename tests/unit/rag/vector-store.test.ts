import { describe, expect, it, vi } from "vitest";

import { PgVectorStore } from "../../../src/rag/vector-store.js";

const ORG = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";

function makePool() {
  return { query: vi.fn(), connect: vi.fn() };
}

describe("PgVectorStore.similaritySearch — tenant guard (ADR-019)", () => {
  it("throws when organizationId is null", async () => {
    const pool = makePool();
    const store = new PgVectorStore(pool as never);
    await expect(
      store.similaritySearch({
        queryEmbedding: [0.1],
        organizationId: null as unknown as string,
        topK: 5,
      }),
    ).rejects.toThrowError(/organizationId is required/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("throws when organizationId is undefined", async () => {
    const pool = makePool();
    const store = new PgVectorStore(pool as never);
    await expect(
      store.similaritySearch({
        queryEmbedding: [0.1],
        organizationId: undefined as unknown as string,
        topK: 5,
      }),
    ).rejects.toThrowError(/organizationId is required/);
  });

  it("throws when organizationId is not a non-empty string", async () => {
    const pool = makePool();
    const store = new PgVectorStore(pool as never);
    await expect(
      store.similaritySearch({
        queryEmbedding: [0.1],
        organizationId: "" as unknown as string,
        topK: 5,
      }),
    ).rejects.toThrowError(/must be a non-empty string/);
    await expect(
      store.similaritySearch({
        queryEmbedding: [0.1],
        organizationId: 1 as unknown as string,
        topK: 5,
      }),
    ).rejects.toThrowError(/must be a non-empty string/);
  });

  it("throws on empty queryEmbedding", async () => {
    const pool = makePool();
    const store = new PgVectorStore(pool as never);
    await expect(
      store.similaritySearch({ queryEmbedding: [], organizationId: ORG, topK: 5 }),
    ).rejects.toThrowError(/empty/);
  });

  it("returns [] for topK <= 0 without hitting DB", async () => {
    const pool = makePool();
    const store = new PgVectorStore(pool as never);
    expect(
      await store.similaritySearch({ queryEmbedding: [0.1], organizationId: ORG, topK: 0 }),
    ).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("passes organizationId as 2nd query parameter (tenant isolation in SQL)", async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const store = new PgVectorStore(pool as never);
    await store.similaritySearch({
      queryEmbedding: [0.1, 0.2],
      organizationId: ORG,
      topK: 3,
    });
    expect(pool.query).toHaveBeenCalledOnce();
    const args = pool.query.mock.calls[0]![1] as unknown[];
    expect(args[1]).toBe(ORG); // organizationId is second positional param
  });

  it("filters out rows below minScore", async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { chunk_id: 1, document_id: 10, content: "hit", metadata: {}, source: "faq", title: null, score: 0.9 },
        { chunk_id: 2, document_id: 10, content: "miss", metadata: {}, source: "faq", title: null, score: 0.2 },
      ],
      rowCount: 2,
    });
    const store = new PgVectorStore(pool as never);
    const out = await store.similaritySearch({
      queryEmbedding: [0.1],
      organizationId: ORG,
      topK: 5,
      minScore: 0.5,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.chunkId).toBe(1);
  });
});
