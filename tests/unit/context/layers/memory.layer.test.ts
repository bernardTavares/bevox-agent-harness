import { describe, it, expect, vi } from "vitest";

import { MemoryLayer } from "../../../../src/context/layers/memory.layer.js";
import type { ContextInput } from "../../../../src/context/types.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 99n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {}
};

const mockProfile = {
  full_name: "Joao Carlos da Silva",
  preferred_name: "Joao",
  phone: "(11) 99999-1234",
  email: "joao@example.com",
  address: null,
  city: "Sao Paulo",
  state: "SP",
  preferred_language: "pt-BR",
  last_interaction_at: new Date("2026-04-03T00:00:00Z"),
  total_interactions: 5
};

const mockFacts = [
{
  fact_key: "filha",
  fact_value: "Ana Beatriz, 7 anos",
  category: "familia",
  confidence: "0.900",
  confirmed: true
},
{
  fact_key: "plano",
  fact_value: "Unimed Gold",
  category: "saude",
  confidence: "0.850",
  confirmed: false
},
{
  fact_key: "no_category",
  fact_value: "valor",
  category: null,
  confidence: "0.500",
  confirmed: false
}];


const makeDb = (profile: object | null, facts: object[]) => ({
  query: vi.
  fn().
  mockResolvedValueOnce({ rows: profile ? [profile] : [] }).
  mockResolvedValueOnce({ rows: facts })
});

describe("MemoryLayer", () => {
  it("formats profile and facts", async () => {
    const layer = new MemoryLayer(makeDb(mockProfile, mockFacts) as never);
    const block = await layer.build(input);

    expect(block.section).toBe("## Informacoes do contato");
    expect(block.content).toContain("Joao Carlos da Silva");
    expect(block.content).toContain("prefere: Joao");
    expect(block.content).toContain("(11) 99999-1234");
    expect(block.content).toContain("joao@example.com");
    expect(block.content).toContain("Sao Paulo, SP");
    expect(block.content).toContain("2026-04-03");
    expect(block.content).toContain("Ana Beatriz, 7 anos");
    expect(block.content).toContain("[familia]");
    expect(block.priority).toBe(40);
    expect(block.compressible).toBe(true);
  });

  it("returns empty block when no profile", async () => {
    const layer = new MemoryLayer(makeDb(null, []) as never);
    const block = await layer.build(input);
    expect(block.content).toBe("");
    expect(block.tokenEstimate).toBe(0);
  });

  it("queries with organizationId and contactId for both profile and facts", async () => {
    const db = makeDb(mockProfile, mockFacts);
    const layer = new MemoryLayer(db as never);
    await layer.build(input);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("contact_profiles"),
      ["018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", 99n]
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("contact_facts"),
      ["018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", 99n]
    );
  });

  it("renders profile without preferred_name when null", async () => {
    const layer = new MemoryLayer(
      makeDb({ ...mockProfile, preferred_name: null }, []) as never
    );
    const block = await layer.build(input);
    expect(block.content).toContain("Joao Carlos da Silva");
    expect(block.content).not.toContain("prefere:");
  });

  it("omits city/state line when both null", async () => {
    const layer = new MemoryLayer(
      makeDb({ ...mockProfile, city: null, state: null }, []) as never
    );
    const block = await layer.build(input);
    expect(block.content).not.toContain("Localizacao");
  });

  it("renders location with only city or only state", async () => {
    const layer = new MemoryLayer(
      makeDb({ ...mockProfile, state: null }, []) as never
    );
    const block = await layer.build(input);
    expect(block.content).toContain("Sao Paulo");
  });

  it("handles facts without category", async () => {
    const layer = new MemoryLayer(makeDb(mockProfile, mockFacts) as never);
    const block = await layer.build(input);
    expect(block.content).toContain("no_category: valor");
  });

  it("returns block without fact section when no facts", async () => {
    const layer = new MemoryLayer(makeDb(mockProfile, []) as never);
    const block = await layer.build(input);
    expect(block.content).toContain("Joao Carlos");
    expect(block.content).not.toContain("### Fatos conhecidos");
  });

  it("filters facts query to non-superseded", async () => {
    const db = makeDb(mockProfile, mockFacts);
    const layer = new MemoryLayer(db as never);
    await layer.build(input);
    const factsQuery = db.query.mock.calls[1][0] as string;
    expect(factsQuery).toContain("superseded_by IS NULL");
  });

  it("handles profile with only minimal fields", async () => {
    const minimalProfile = {
      full_name: null,
      preferred_name: null,
      phone: null,
      email: null,
      address: null,
      city: null,
      state: null,
      preferred_language: null,
      last_interaction_at: null,
      total_interactions: 0
    };
    const layer = new MemoryLayer(makeDb(minimalProfile, []) as never);
    const block = await layer.build(input);
    // Profile exists but no displayable fields → very short content
    expect(block.content.length).toBeLessThan(50);
  });
});