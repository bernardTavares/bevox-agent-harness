import { describe, it, expect, afterEach, vi } from "vitest";

import { createContextBuilder } from "../../../src/context/builder-factory.js";
import {
  setSemanticRecall,
  resetMemoryRegistryForTests,
} from "../../../src/memory/registry.js";
import type {
  SemanticRecall,
  RecalledMessage,
} from "../../../src/memory/semantic-recall.js";
import type { ContextInput } from "../../../src/context/types.js";

// A fake recall that returns one fixed hit and records that it was called.
function makeFakeRecall(hits: RecalledMessage[]): SemanticRecall & { calls: number } {
  return {
    calls: 0,
    async recall() {
      (this as { calls: number }).calls += 1;
      return hits;
    },
  } as SemanticRecall & { calls: number };
}

// Fake pg Pool routed by SQL. The factory builds 4 layers (BaseConfig, Rules,
// Memory, History) that ALL share this one Pool and query it in parallel via
// the builder's Promise.allSettled — so a fixed two-response queue would be
// consumed out of order by Rules/History and starve MemoryLayer. Route by SQL
// instead: contact_profiles → one row, everything else (contact_facts, rules,
// messages) → empty rows.
function makeDb() {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("contact_profiles")) {
        return Promise.resolve({ rows: [{ full_name: "Maria Souza", total_interactions: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

const baseInput: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 99n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {},
  userMessage: "preciso remarcar meu horario",
};

const fixedHit: RecalledMessage = {
  messageId: "m-1",
  role: "user",
  content: "queria agendar para sexta",
  score: 0.82,
  messageAt: new Date("2026-04-01T10:00:00Z"),
};

describe("createContextBuilder — CTX-03 recall edge", () => {
  afterEach(() => {
    resetMemoryRegistryForTests();
  });

  it("reads getSemanticRecall() from the registry and the recall block renders", async () => {
    const fake = makeFakeRecall([fixedHit]);
    setSemanticRecall(fake);
    const builder = createContextBuilder(
      { db: makeDb() as never },
      { globalMaxTokens: Number.POSITIVE_INFINITY, layerTimeoutMs: 5000 },
    );
    const built = await builder.build(baseInput);
    expect(fake.calls).toBe(1);
    expect(built.systemPrompt).toContain("### Memorias semanticamente relevantes");
    expect(built.systemPrompt).toContain("queria agendar para sexta");
  });

  it("degrades to undefined recall (no block, NO throw) when the registry is unset", async () => {
    resetMemoryRegistryForTests(); // ensure no recall registered
    const builder = createContextBuilder(
      { db: makeDb() as never },
      { globalMaxTokens: Number.POSITIVE_INFINITY, layerTimeoutMs: 5000 },
    );
    const built = await builder.build(baseInput);
    expect(built.systemPrompt).not.toContain("### Memorias semanticamente relevantes");
  });

  it("prefers an explicit deps.memory.semanticRecall over the registry", async () => {
    const registryFake = makeFakeRecall([fixedHit]);
    setSemanticRecall(registryFake);
    const overrideFake = makeFakeRecall([{ ...fixedHit, content: "OVERRIDE HIT" }]);
    const builder = createContextBuilder(
      { db: makeDb() as never, memory: { semanticRecall: overrideFake } },
      { globalMaxTokens: Number.POSITIVE_INFINITY, layerTimeoutMs: 5000 },
    );
    const built = await builder.build(baseInput);
    expect(overrideFake.calls).toBe(1);
    expect(registryFake.calls).toBe(0); // `?? getSemanticRecall()` short-circuits
    expect(built.systemPrompt).toContain("OVERRIDE HIT");
  });

  it("does NOT compress internally at the INFINITY sentinel (single budget gate is external)", async () => {
    const fake = makeFakeRecall([fixedHit]);
    setSemanticRecall(fake);
    const builder = createContextBuilder(
      { db: makeDb() as never },
      { globalMaxTokens: Number.POSITIVE_INFINITY, layerTimeoutMs: 5000 },
    );
    const built = await builder.build(baseInput);
    // With the sentinel, the builder never crosses its limit → never compresses.
    expect(built.compressed).toBe(false);
  });
});
