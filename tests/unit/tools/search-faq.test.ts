import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; logic lives in the skill impl.
import {
  execute,
  SEARCH_FAQ_SCHEMA_VERSION,
} from "../../../src/skills-builtin/knowledge/search-faq/search-faq.impl.js";
import { resetRetrieverForTests, setRetriever } from "../../../src/rag/registry.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { Retriever, RetrievedChunk } from "../../../src/rag/types.js";

function makeContext(): AgentExecutionContext {
  return {
    executionId: "exec-1",
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    conversationKey: "conv-1",
    db: { query: vi.fn() } as never,
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
    llmClient: { complete: async () => ({ content: "", model: "fake" }) },
  };
}

function mockRetriever(impl: Retriever["retrieve"]): Retriever {
  return { retrieve: impl };
}

describe("search-faq skill execute (RAG)", () => {
  beforeEach(() => {
    resetRetrieverForTests();
  });
  afterEach(() => {
    resetRetrieverForTests();
  });

  it("returns INVALID_PARAMS when query is missing", async () => {
    const ctx = makeContext();
    const result = await execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns degraded:true when no retriever is wired", async () => {
    const ctx = makeContext();
    const result = await execute({ query: "como cancelar?" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      schema_version: SEARCH_FAQ_SCHEMA_VERSION,
      degraded: true,
      results: [],
    });
  });

  it("maps retrieved chunks into v2 result schema", async () => {
    const fixture: RetrievedChunk[] = [
      {
        chunkId: 11,
        documentId: 101,
        content: "Para cancelar, abra o app.",
        score: 0.91,
        source: "faq",
        title: "Como cancelar",
        metadata: {},
      },
      {
        chunkId: 12,
        documentId: 102,
        content: "Reagendamentos são pelo suporte.",
        score: 0.64,
        source: "faq",
        title: "Reagendamento",
        metadata: {},
      },
    ];
    const retrieve = vi.fn(async () => fixture);
    setRetriever(mockRetriever(retrieve));

    const ctx = makeContext();
    const result = await execute({ query: "cancelar", limit: 5 }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { schema_version: number; degraded: boolean; results: unknown[] };
    expect(data.schema_version).toBe(SEARCH_FAQ_SCHEMA_VERSION);
    expect(data.degraded).toBe(false);
    expect(data.results).toHaveLength(2);
    // Backward-compat alias: `id` mirrors chunkId so v1 consumers don't break.
    const first = data.results[0] as { id: number; chunkId: number; score: number; content: string };
    expect(first.id).toBe(11);
    expect(first.chunkId).toBe(11);
    expect(first.score).toBeCloseTo(0.91);
    expect(first.content).toContain("cancelar");

    // Account scoping: retriever was called with the context's organizationId.
    expect(retrieve).toHaveBeenCalledOnce();
    expect(retrieve.mock.calls[0]?.[0]?.organizationId).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
    expect(retrieve.mock.calls[0]?.[0]?.source).toBe("faq");
  });

  it("clamps limit into [1, 20]", async () => {
    const retrieve = vi.fn(async () => []);
    setRetriever(mockRetriever(retrieve));
    const ctx = makeContext();
    await execute({ query: "x", limit: 9999 }, ctx);
    expect(retrieve.mock.calls[0]?.[0]?.topK).toBe(20);
    await execute({ query: "x", limit: -10 }, ctx);
    expect(retrieve.mock.calls[1]?.[0]?.topK).toBe(1);
  });

  it("returns degraded:true when schema is not applied (graceful)", async () => {
    setRetriever(
      mockRetriever(async () => {
        throw new Error('relation "rag_chunks" does not exist');
      }),
    );
    const ctx = makeContext();
    const result = await execute({ query: "x" }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { degraded: boolean }).degraded).toBe(true);
  });

  it("returns RAG_FAILURE on unexpected errors", async () => {
    setRetriever(
      mockRetriever(async () => {
        throw new Error("connection refused");
      }),
    );
    const ctx = makeContext();
    const result = await execute({ query: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("RAG_FAILURE");
    expect(result.detail).toContain("connection refused");
  });
});
