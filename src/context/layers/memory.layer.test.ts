import { describe, it, expect, vi } from "vitest";

import type { ContextInput } from "../types.js";

import { MemoryLayer } from "./memory.layer.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 99n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {},
};

const mockProfile = {
  full_name: "Joao Carlos da Silva",
  preferred_name: "Joao",
  phone: "(11) 99999-1234",
  email: "joao@example.com",
  last_interaction_at: new Date("2026-04-03"),
};

const mockFacts = [
  {
    fact_key: "filha",
    fact_value: "Ana Beatriz, 7 anos",
    category: "familia",
    confidence: "0.900",
    confirmed: true,
  },
  {
    fact_key: "plano",
    fact_value: "Unimed Gold",
    category: "saude",
    confidence: "0.850",
    confirmed: false,
  },
  {
    fact_key: "preferencia_horario",
    fact_value: "Prefere manha",
    category: "preferencia",
    confidence: "0.600",
    confirmed: false,
  },
];

describe("MemoryLayer", () => {
  const makeDb = (profile: object | null, facts: object[]) => ({
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: profile ? [profile] : [] })
      .mockResolvedValueOnce({ rows: facts }),
  });

  it("formats profile fields and facts", async () => {
    const layer = new MemoryLayer(makeDb(mockProfile, mockFacts) as never);
    const block = await layer.build(input);

    expect(block.section).toBe("## Informacoes do contato");
    expect(block.content).toContain("Joao Carlos da Silva");
    expect(block.content).toContain("Joao");
    expect(block.content).toContain("(11) 99999-1234");
    expect(block.content).toContain("Ana Beatriz, 7 anos");
    expect(block.priority).toBe(40);
    expect(block.compressible).toBe(true);
  });

  it("returns empty section when no profile exists", async () => {
    const layer = new MemoryLayer(makeDb(null, []) as never);
    const block = await layer.build(input);
    expect(block.content).toBe("");
  });

  it("queries with correct contact_id and organization_id", async () => {
    const db = makeDb(mockProfile, mockFacts);
    const layer = new MemoryLayer(db as never);
    await layer.build(input);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("contact_profiles"),
      expect.arrayContaining([1, 99n]),
    );
  });

  it("groups facts by category", async () => {
    const layer = new MemoryLayer(makeDb(mockProfile, mockFacts) as never);
    const block = await layer.build(input);
    expect(block.content).toContain("[familia]");
    expect(block.content).toContain("[saude]");
    expect(block.content).toContain("[preferencia]");
  });
});
