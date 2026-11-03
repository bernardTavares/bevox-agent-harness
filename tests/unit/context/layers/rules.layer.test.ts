import { describe, it, expect, vi } from "vitest";

import { RulesLayer } from "../../../../src/context/layers/rules.layer.js";
import type { ContextInput } from "../../../../src/context/types.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 10n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {}
};

describe("RulesLayer", () => {
  it("formats active rules as numbered instructions", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
        {
          id: 1,
          description: "Encaminhar quando cliente solicitar cancelamento."
        },
        {
          id: 2,
          description: "Encaminhar para equipe medica se urgencia."
        }]

      })
    };
    const layer = new RulesLayer(db as never);
    const block = await layer.build(input);

    expect(block.section).toBe("## Regras de encaminhamento");
    expect(block.content).toMatch(/1\. Encaminhar quando cliente/);
    expect(block.content).toMatch(/2\. Encaminhar para equipe/);
    expect(block.compressible).toBe(false);
    expect(block.priority).toBe(20);
  });

  it("returns empty content when no rules", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new RulesLayer(db as never);
    const block = await layer.build(input);
    expect(block.content).toBe("");
  });

  it("queries with organizationId", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new RulesLayer(db as never);
    await layer.build(input);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ["018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b"]);
  });

  it("filters active+human-destination rules in SQL", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new RulesLayer(db as never);
    await layer.build(input);
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("active = true");
    expect(sql).toContain("'human'");
  });

  it("propagates db errors", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("db unreachable")) };
    const layer = new RulesLayer(db as never);
    await expect(layer.build(input)).rejects.toThrow("db unreachable");
  });
});