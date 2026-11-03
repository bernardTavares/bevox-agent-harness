import { describe, it, expect, vi } from "vitest";

import type { ContextInput } from "../types.js";

import { RulesLayer } from "./rules.layer.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 10n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {},
};

describe("RulesLayer", () => {
  it("formats active rules as numbered instructions", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: 1, description: "Encaminhar quando cliente solicitar cancelamento de plano." },
          { id: 2, description: "Encaminhar para equipe medica se urgencia critica." },
        ],
      }),
    };
    const layer = new RulesLayer(mockDb as never);
    const block = await layer.build(input);

    expect(block.section).toBe("## Regras de encaminhamento");
    expect(block.content).toContain(
      "1. Encaminhar quando cliente solicitar cancelamento de plano.",
    );
    expect(block.content).toContain("2. Encaminhar para equipe medica se urgencia critica.");
    expect(block.compressible).toBe(false);
    expect(block.priority).toBe(20);
  });

  it("returns empty section when no rules exist", async () => {
    const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new RulesLayer(mockDb as never);
    const block = await layer.build(input);
    expect(block.content).toBe("");
  });

  it("queries only active rules for the correct account", async () => {
    const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new RulesLayer(mockDb as never);
    await layer.build(input);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("organization_id"),
      expect.arrayContaining([42]),
    );
  });
});
