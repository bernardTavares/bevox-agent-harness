import { describe, expect, it, vi } from "vitest";

import { RagSemanticRecall } from "../../../src/memory/semantic-recall.js";
import type { Embedder } from "../../../src/rag/types.js";

const ORG = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";

function makeEmbedder(vec: number[] = new Array(1536).fill(0.01)): Embedder {
  return {
    model: "text-embedding-3-small",
    dim: 1536,
    embed: vi.fn().mockResolvedValue([vec]),
  } as Embedder;
}

function makeDb(rows: Array<Record<string, unknown>>): {
  query: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

describe("RagSemanticRecall", () => {
  it("returns recalled messages above minScore", async () => {
    const db = makeDb([
      {
        message_id: "m1",
        role: "user",
        content: "old question about agendamento",
        message_at: new Date("2024-01-01"),
        score: 0.92,
      },
      {
        message_id: "m2",
        role: "assistant",
        content: "irrelevant",
        message_at: new Date("2024-01-02"),
        score: 0.45,
      },
    ]);
    const recall = new RagSemanticRecall(db as never, makeEmbedder());
    const out = await recall.recall({
      query: "quero remarcar",
      organizationId: ORG,
      contactId: 99n,
      topK: 5,
      minScore: 0.6,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.messageId).toBe("m1");
    expect(out[0]!.score).toBeCloseTo(0.92, 2);
  });

  it("returns empty when no rows match", async () => {
    const db = makeDb([]);
    const recall = new RagSemanticRecall(db as never, makeEmbedder());
    const out = await recall.recall({
      query: "test",
      organizationId: ORG,
      contactId: 99n,
    });
    expect(out).toEqual([]);
  });

  it("returns empty when query is empty", async () => {
    const db = makeDb([{ message_id: "m1", role: "user", content: "x", message_at: new Date(), score: 0.9 }]);
    const recall = new RagSemanticRecall(db as never, makeEmbedder());
    const out = await recall.recall({
      query: "   ",
      organizationId: ORG,
      contactId: 99n,
    });
    expect(out).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("filters by organizationId (tenant isolation) in SQL parameters", async () => {
    const db = makeDb([]);
    const recall = new RagSemanticRecall(db as never, makeEmbedder());
    await recall.recall({
      query: "hi",
      organizationId: ORG,
      contactId: 7n,
      topK: 3,
      excludeRecent: 5,
    });
    expect(db.query).toHaveBeenCalledOnce();
    const args = db.query.mock.calls[0]?.[1] as unknown[];
    expect(args[0]).toBe(ORG);
    expect(args[1]).toBe(7n);
    expect(args[3]).toBe(5); // excludeRecent
    expect(args[4]).toBe(3); // topK
  });

  it("excludes superseded messages via WHERE clause", async () => {
    const db = makeDb([]);
    const recall = new RagSemanticRecall(db as never, makeEmbedder());
    await recall.recall({ query: "x", organizationId: ORG, contactId: 1n });
    const sql = db.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("superseded_by_summary_fact_id IS NULL");
  });

  it("throws if organizationId is missing", async () => {
    const recall = new RagSemanticRecall(makeDb([]) as never, makeEmbedder());
    await expect(
      recall.recall({
        query: "x",
        // @ts-expect-error testing tenant guard
        organizationId: undefined,
        contactId: 1n,
      }),
    ).rejects.toThrow(/organizationId/);
  });
});
