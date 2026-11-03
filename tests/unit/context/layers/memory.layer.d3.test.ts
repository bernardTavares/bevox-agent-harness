/**
 * Sprint D.3 — MemoryLayer extensions:
 *   - "Resumo de interacoes passadas" (summaries via factsRepo)
 *   - "Memorias semanticamente relevantes" (via SemanticRecall)
 *
 * The base regression suite lives in `memory.layer.test.ts`; this file only
 * covers the D.3 additions and guarantees they are no-ops when not wired
 * (zero-regression contract).
 */

import { describe, expect, it, vi } from "vitest";

import { MemoryLayer } from "../../../../src/context/layers/memory.layer.js";
import type { ContextInput } from "../../../../src/context/types.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 99n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {},
  userMessage: "quero remarcar para semana que vem",
};

const profile = {
  full_name: "Joao",
  preferred_name: null,
  phone: null,
  email: null,
  address: null,
  city: null,
  state: null,
  preferred_language: "pt-BR",
  last_interaction_at: null,
  total_interactions: 0,
};

function makeDb(facts: object[] = []): {
  query: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [profile] })
      .mockResolvedValueOnce({ rows: facts }),
  };
}

describe("MemoryLayer D.3 extensions", () => {
  it("is backward-compatible when no D.3 deps are provided", async () => {
    const layer = new MemoryLayer(makeDb() as never);
    const block = await layer.build(input);
    expect(block.section).toBe("## Informacoes do contato");
    expect(block.content).not.toContain("semanticamente relevantes");
    expect(block.content).not.toContain("Resumo de interacoes");
  });

  it("adds summaries section when factsRepo returns summaries", async () => {
    const factsRepo = {
      findSummaries: vi.fn().mockResolvedValue([
        {
          extractedAt: new Date("2024-03-10"),
          factValue: "Cliente confirmou remarcacao para sexta.",
        },
      ]),
    };
    const layer = new MemoryLayer(makeDb() as never, {
      factsRepo: factsRepo as never,
    });
    const block = await layer.build(input);
    expect(block.content).toContain("Resumo de interacoes passadas");
    expect(block.content).toContain("Cliente confirmou remarcacao");
    expect(factsRepo.findSummaries).toHaveBeenCalledWith(
      "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      99n,
    );
  });

  it("omits summaries section when factsRepo returns nothing", async () => {
    const factsRepo = { findSummaries: vi.fn().mockResolvedValue([]) };
    const layer = new MemoryLayer(makeDb() as never, {
      factsRepo: factsRepo as never,
    });
    const block = await layer.build(input);
    expect(block.content).not.toContain("Resumo de interacoes");
  });

  it("adds semantic recall section when recall returns matches", async () => {
    const semanticRecall = {
      recall: vi.fn().mockResolvedValue([
        {
          messageId: "m42",
          role: "user",
          score: 0.83,
          content: "Da pra remarcar para sexta as 10h?",
          messageAt: new Date("2023-12-15"),
        },
      ]),
    };
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: semanticRecall as never,
    });
    const block = await layer.build(input);
    expect(block.content).toContain("Memorias semanticamente relevantes");
    expect(block.content).toContain("score 0.83");
    expect(block.content).toContain("Da pra remarcar");
    expect(semanticRecall.recall).toHaveBeenCalledWith(
      expect.objectContaining({
        query: input.userMessage,
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        contactId: 99n,
      }),
    );
  });

  it("skips semantic recall when no userMessage provided", async () => {
    const semanticRecall = { recall: vi.fn() };
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: semanticRecall as never,
    });
    const inp = { ...input, userMessage: undefined };
    const block = await layer.build(inp);
    expect(semanticRecall.recall).not.toHaveBeenCalled();
    expect(block.content).not.toContain("semanticamente relevantes");
  });

  it("non-fatally degrades when semanticRecall throws", async () => {
    const semanticRecall = {
      recall: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: semanticRecall as never,
    });
    const block = await layer.build(input);
    expect(block.section).toBe("## Informacoes do contato");
    expect(block.content).not.toContain("semanticamente relevantes");
  });

  it("base facts query excludes category='summary'", async () => {
    const db = makeDb();
    const layer = new MemoryLayer(db as never);
    await layer.build(input);
    const factsSql = db.query.mock.calls[1]?.[0] as string;
    expect(factsSql).toMatch(/category\s+<>\s+'summary'/);
  });

  it("truncates long recalled message content to 200 chars by default", async () => {
    const longContent = "x".repeat(500);
    const semanticRecall = {
      recall: vi.fn().mockResolvedValue([
        {
          messageId: "m1",
          role: "user",
          score: 0.9,
          content: longContent,
          messageAt: new Date(),
        },
      ]),
    };
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: semanticRecall as never,
    });
    const block = await layer.build(input);
    // 200 chars + "..." marker
    expect(block.content).toContain("...");
    expect(block.content.length).toBeLessThan(input.userMessage!.length + 1000);
  });
});
