import { describe, expect, it, vi } from "vitest";

import { CachingEmbedder, parseVectorLiteral, toVectorLiteral } from "../../../src/rag/embedder.js";
import type { EmbedRequest, EmbedResponse, LLMEmbedder } from "../../../src/integration/llm/embedder.js";

function makeLLM(dim = 1536): { llm: LLMEmbedder; calls: () => number } {
  let calls = 0;
  const llm: LLMEmbedder = {
    provider: "openai",
    model: "text-embedding-3-small",
    dim,
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      calls += 1;
      return {
        provider: "openai",
        model: "text-embedding-3-small",
        embeddings: req.inputs.map((s, i) => {
          const arr = new Array<number>(dim).fill(0);
          // Deterministic per-input vector so cache lookup is meaningful.
          arr[0] = s.length;
          arr[1] = i;
          return arr;
        }),
        usage: { input_tokens: req.inputs.length },
        latency_ms: 1,
      };
    },
  };
  return { llm, calls: () => calls };
}

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  cache: Map<string, number[]>;
}

function makePool(): MockPool {
  const cache = new Map<string, number[]>();
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT content_hash, embedding")) {
      const hashes = (params?.[1] as string[]) ?? [];
      const rows: { content_hash: string; embedding: string }[] = [];
      for (const h of hashes) {
        const v = cache.get(h);
        if (v) rows.push({ content_hash: h, embedding: toVectorLiteral(v) });
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO rag_embedding_cache")) {
      const hashArr = (params?.[1] as string[]) ?? [];
      const vecArr = (params?.[2] as string[]) ?? [];
      for (let i = 0; i < hashArr.length; i++) {
        cache.set(hashArr[i]!, parseVectorLiteral(vecArr[i]!));
      }
      return { rows: [], rowCount: hashArr.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, cache } as MockPool;
}

describe("CachingEmbedder", () => {
  it("rejects non-1536 dim (multi-dim guard)", () => {
    const { llm } = makeLLM(768);
    const pool = makePool();
    expect(() => new CachingEmbedder(llm, pool as never, { dim: 768 })).toThrowError(
      /not supported.*vector\(1536\)/,
    );
  });

  it("calls provider once per unique text; cached on second call", async () => {
    const { llm, calls } = makeLLM();
    const pool = makePool();
    const emb = new CachingEmbedder(llm, pool as never);

    const v1 = await emb.embed(["hello world"]);
    expect(v1).toHaveLength(1);
    expect(v1[0]).toHaveLength(1536);
    expect(calls()).toBe(1);

    const v2 = await emb.embed(["hello world"]);
    expect(v2[0]).toEqual(v1[0]);
    expect(calls()).toBe(1); // cache hit — no second provider call
  });

  it("mixes cached and uncached inputs in a single call", async () => {
    const { llm, calls } = makeLLM();
    const pool = makePool();
    const emb = new CachingEmbedder(llm, pool as never);

    await emb.embed(["one"]);
    expect(calls()).toBe(1);

    const out = await emb.embed(["one", "two", "three"]);
    expect(out).toHaveLength(3);
    // Only "two" and "three" required provider; called once total for the
    // second invocation (single batch of 2 misses).
    expect(calls()).toBe(2);
  });

  it("returns empty array for empty input", async () => {
    const { llm, calls } = makeLLM();
    const pool = makePool();
    const emb = new CachingEmbedder(llm, pool as never);
    const out = await emb.embed([]);
    expect(out).toEqual([]);
    expect(calls()).toBe(0);
  });

  it("throws when provider returns wrong-dim vectors", async () => {
    const { llm } = makeLLM(1536);
    // Override to return 1024-dim arrays.
    const broken: LLMEmbedder = {
      ...llm,
      async embed(req) {
        return {
          provider: "openai",
          model: "text-embedding-3-small",
          embeddings: req.inputs.map(() => new Array<number>(1024).fill(0)),
          usage: { input_tokens: 0 },
          latency_ms: 1,
        };
      },
    };
    const pool = makePool();
    const emb = new CachingEmbedder(broken, pool as never);
    await expect(emb.embed(["x"])).rejects.toThrowError(/dim mismatch/);
  });
});

describe("vector literal helpers", () => {
  it("round-trips a vector", () => {
    const v = [0.1, -0.2, 3.14];
    expect(parseVectorLiteral(toVectorLiteral(v))).toEqual(v);
  });

  it("rejects malformed literal", () => {
    expect(() => parseVectorLiteral("not a vector")).toThrowError(/malformed/);
  });
});
