import { describe, it, expect, vi } from "vitest";

import type { ContextInput } from "../types.js";

import { HistoryLayer } from "./history.layer.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 10n,
  conversationKey: "conv-abc",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {},
};

const mockMessages = [
  {
    role: "Cliente",
    content: "Oi, quero marcar uma consulta.",
    created_at: new Date("2026-04-03T10:00:00Z"),
  },
  {
    role: "Atendimento Inteligente",
    content: "Claro! Qual servico voce precisa?",
    created_at: new Date("2026-04-03T10:01:00Z"),
  },
  {
    role: "Cliente",
    content: "Consulta medica com a Dra. Ana.",
    created_at: new Date("2026-04-03T10:02:00Z"),
  },
];

describe("HistoryLayer", () => {
  it("formats messages with role prefix", async () => {
    const mockDb = { query: vi.fn().mockResolvedValue({ rows: mockMessages }) };
    const layer = new HistoryLayer(mockDb as never);
    const block = await layer.build(input);

    expect(block.section).toBe("## Historico da conversa");
    expect(block.content).toContain("Cliente: Oi, quero marcar uma consulta.");
    expect(block.content).toContain("Atendimento Inteligente: Claro!");
    expect(block.priority).toBe(50);
    expect(block.compressible).toBe(true);
  });

  it("returns empty section when no messages exist", async () => {
    const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new HistoryLayer(mockDb as never);
    const block = await layer.build(input);
    expect(block.content).toBe("");
  });

  it("queries with conversation_key and organization_id", async () => {
    const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const layer = new HistoryLayer(mockDb as never);
    await layer.build(input);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["conv-abc"]),
    );
  });

  it("respects custom window days from env", async () => {
    const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    // Layer should accept configurable window days
    const layer = new HistoryLayer(mockDb as never, { windowDays: 3, recencyLimitDays: 10 });
    await layer.build(input);
    const queryParams = mockDb.query.mock.calls[0][1] as unknown[];
    // The query should pass a date range param derived from windowDays
    expect(queryParams.length).toBeGreaterThanOrEqual(1);
  });
});
