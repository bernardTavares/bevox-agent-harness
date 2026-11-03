import { describe, expect, it, vi } from "vitest";

import { MessageEmbeddingIndexer } from "../../../src/memory/message-embedding-indexer.js";
import type { Embedder } from "../../../src/rag/types.js";

function makeEmbedder(): Embedder {
  return {
    model: "text-embedding-3-small",
    dim: 1536,
    embed: vi.fn(async (texts: string[]) =>
      texts.map(() => new Array(1536).fill(0.01)),
    ),
  } as Embedder;
}

describe("MessageEmbeddingIndexer", () => {
  it("indexes new messages and returns count", async () => {
    // 1st query: existing message_id lookup → no rows.
    // Then per-message INSERTs (2).
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const idx = new MessageEmbeddingIndexer(
      { query } as never,
      makeEmbedder(),
    );
    const r = await idx.index(1, 99n, [
      { messageId: "m1", role: "user", content: "ola", messageAt: new Date() },
      { messageId: "m2", role: "assistant", content: "oi!", messageAt: new Date() },
    ]);
    expect(r.indexed).toBe(2);
    expect(r.skipped).toBe(0);
    expect(query).toHaveBeenCalledTimes(3); // 1 select + 2 inserts
  });

  it("skips messages with existing message_id (cheap dedup path)", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ message_id: "m1" }], rowCount: 1 });
    const idx = new MessageEmbeddingIndexer({ query } as never, makeEmbedder());
    const r = await idx.index(1, 99n, [
      { messageId: "m1", role: "user", content: "x", messageAt: new Date() },
    ]);
    expect(r.indexed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("filters out empty content before embedding", async () => {
    const emb = makeEmbedder();
    const query = vi.fn();
    const idx = new MessageEmbeddingIndexer({ query } as never, emb);
    const r = await idx.index(1, 99n, [
      { messageId: "m1", role: "user", content: "  ", messageAt: new Date() },
      { messageId: "m2", role: "assistant", content: "", messageAt: new Date() },
    ]);
    expect(r.indexed).toBe(0);
    expect(r.skipped).toBe(2);
    expect(emb.embed).not.toHaveBeenCalled();
  });

  it("returns zero for empty input list", async () => {
    const emb = makeEmbedder();
    const idx = new MessageEmbeddingIndexer({ query: vi.fn() } as never, emb);
    const r = await idx.index(1, 99n, []);
    expect(r.indexed).toBe(0);
  });

  it("uses ON CONFLICT DO NOTHING on insert", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const idx = new MessageEmbeddingIndexer({ query } as never, makeEmbedder());
    await idx.index(1, 99n, [
      { messageId: "m1", role: "user", content: "x", messageAt: new Date() },
    ]);
    const insertSql = query.mock.calls[1]?.[0] as string;
    expect(insertSql).toContain("ON CONFLICT");
    expect(insertSql).toContain("DO NOTHING");
  });
});
