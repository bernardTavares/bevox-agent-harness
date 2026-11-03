import { describe, it, expect, vi } from "vitest";

import { MemoryLayer } from "../../../src/context/layers/memory.layer.js";
import type {
  SemanticRecall,
  RecalledMessage,
} from "../../../src/memory/semantic-recall.js";
import type { ContextInput } from "../../../src/context/types.js";

/*
 * DEFERRED (NOT covered here — see plan §A/§C):
 *  - minScore filtered AFTER `LIMIT topK` (semantic-recall.ts) can
 *    return < topK items at default topK=5/minScore=0.6. Product decision:
 *    accept-as-is OR move the filter into SQL. Filed, not fixed (touches
 *    recall(), a non-goal). [reviewer concern 2 / §C item 1]
 *  - minScore=0.6 unvalidated against real PT-BR SDR embeddings. Calibrate
 *    against data before flipping ON. [reviewer concern 3 / §A gate 2]
 *  - excludeRecent (messages) vs History window (turns/tokens) are not
 *    commensurable; measure empirically before enabling. [concern 5 / §A gate 3]
 *  - 800ms layer timeout default unvalidated vs embedding provider P99.
 *    [concern 1 / §A gate 1]
 */

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 99n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {},
  userMessage: "preciso remarcar meu horario",
};

// profile row present, facts empty — so the recall section is the variable part.
function makeDb() {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ full_name: "Maria Souza", total_interactions: 1 }] })
      .mockResolvedValueOnce({ rows: [] }),
  };
}

function recallReturning(hits: RecalledMessage[]): SemanticRecall {
  return { recall: async () => hits };
}

const hit = (content: string): RecalledMessage => ({
  messageId: "m-1",
  role: "user",
  content,
  score: 0.81,
  messageAt: new Date("2026-04-01T10:00:00Z"),
});

describe("MemoryLayer recall branch (CTX-03)", () => {
  it("renders the recall section when recall returns hits", async () => {
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: recallReturning([hit("queria agendar para sexta")]),
    });
    const block = await layer.build(input);
    expect(block.content).toContain("### Memorias semanticamente relevantes");
    expect(block.content).toContain("queria agendar para sexta");
  });

  it("truncates a recalled body longer than recallContentTruncate (default 200)", async () => {
    const long = "x".repeat(250);
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: recallReturning([hit(long)]),
    });
    const block = await layer.build(input);
    expect(block.content).toContain("x".repeat(200) + "...");
    expect(block.content).not.toContain("x".repeat(201));
  });

  it("honors a custom recallContentTruncate", async () => {
    const long = "y".repeat(50);
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: recallReturning([hit(long)]),
      recallContentTruncate: 10,
    });
    const block = await layer.build(input);
    expect(block.content).toContain("y".repeat(10) + "...");
  });

  it("skips recall entirely when userMessage is absent", async () => {
    const fake = recallReturning([hit("should not appear")]);
    const spy = vi.spyOn(fake, "recall");
    const layer = new MemoryLayer(makeDb() as never, { semanticRecall: fake });
    const noMsg: ContextInput = { ...input, userMessage: undefined };
    const block = await layer.build(noMsg);
    expect(spy).not.toHaveBeenCalled();
    expect(block.content).not.toContain("### Memorias semanticamente relevantes");
  });

  it("skips recall when the token budget is too tight (budgetOk=false)", async () => {
    const fake = recallReturning([hit("should not appear")]);
    const spy = vi.spyOn(fake, "recall");
    const layer = new MemoryLayer(makeDb() as never, { semanticRecall: fake });
    // tiny budget → estimateTokens(lines) >= tokenBudget - 200 → skip
    const tight: ContextInput = { ...input, tokenBudget: 10 };
    const block = await layer.build(tight);
    expect(spy).not.toHaveBeenCalled();
    expect(block.content).not.toContain("### Memorias semanticamente relevantes");
  });

  it("fail-open: recall that throws does NOT block the profile/facts block", async () => {
    const throwing: SemanticRecall = {
      recall: async () => {
        throw new Error("embedder down");
      },
    };
    const layer = new MemoryLayer(makeDb() as never, { semanticRecall: throwing });
    const block = await layer.build(input);
    expect(block.content).toContain("Maria Souza"); // profile still rendered
    expect(block.content).not.toContain("### Memorias semanticamente relevantes");
  });
});
