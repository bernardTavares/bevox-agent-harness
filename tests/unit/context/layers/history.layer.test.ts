import { describe, it, expect, vi } from "vitest";

import { HistoryLayer } from "../../../../src/context/layers/history.layer.js";
import type { ContextInput } from "../../../../src/context/types.js";

const input: ContextInput = {
  executionId: "e1",
  accountId: 1,
  contactId: 10n,
  conversationKey: "conv-abc",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {}
};

const mockMessages = [
{
  role: "Cliente",
  content: "Oi, quero marcar uma consulta.",
  created_at: new Date("2026-04-03T10:00:00Z")
},
{
  role: "Atendimento Inteligente",
  content: "Claro! Qual servico voce precisa?",
  created_at: new Date("2026-04-03T10:01:00Z")
}];


describe("HistoryLayer", () => {
  it("formats messages with role prefix", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: mockMessages }) };
    const layer = new HistoryLayer(db as never);
    const block = await layer.build(input);

    expect(block.section).toBe("## Historico da conversa");
    expect(block.content).toContain("Cliente: Oi, quero marcar uma consulta.");
    expect(block.content).toContain("Atendimento Inteligente: Claro!");
    expect(block.priority).toBe(50);
    expect(block.compressible).toBe(true);
  });

  it("returns empty section when no messages", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new HistoryLayer(db as never);
    const block = await layer.build(input);
    expect(block.content).toBe("");
    expect(block.tokenEstimate).toBe(0);
  });

  it("queries with conversationKey", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new HistoryLayer(db as never);
    await layer.build(input);
    expect(db.query).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["conv-abc"])
    );
  });

  it("accepts custom windowDays and recencyLimitDays", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new HistoryLayer(db as never, {
      windowDays: 3,
      recencyLimitDays: 7
    });
    await layer.build(input);
    const [_sql, params] = db.query.mock.calls[0];
    expect((params as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it("uses defaults from env when options not provided", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new HistoryLayer(db as never);
    await layer.build(input);
    expect(db.query).toHaveBeenCalled();
  });

  it("trims whitespace from content", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
        {
          role: "Cliente",
          content: "  message with spaces  ",
          created_at: new Date()
        }]

      })
    };
    const layer = new HistoryLayer(db as never);
    const block = await layer.build(input);
    expect(block.content).toContain("Cliente: message with spaces");
  });

  it("propagates db errors", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("db down")) };
    const layer = new HistoryLayer(db as never);
    await expect(layer.build(input)).rejects.toThrow("db down");
  });
});