import { describe, expect, it, vi } from "vitest";

import {
  MemoryCondenserAgent,
  parseCondenseOutput,
  runMemoryCondenser,
  memoryCondenserAgent,
} from "../../../../src/agents/pipeline/memory-condenser.agent.js";

describe("memoryCondenserAgent definition", () => {
  it("declares pipeline type and direct reasoning", () => {
    expect(memoryCondenserAgent.name).toBe("memory-condenser");
    expect(memoryCondenserAgent.type).toBe("pipeline");
    expect(memoryCondenserAgent.reasoning.default).toBe("direct");
  });

  it("denies tools that would cause cross-account side effects", () => {
    expect(memoryCondenserAgent.permissions.denied).toContain("send-message");
    expect(memoryCondenserAgent.permissions.denied).toContain("request-human");
  });
});

describe("MemoryCondenserAgent.execute (registry shim)", () => {
  it("is a no-op when invoked from main execution flow", async () => {
    const agent = new MemoryCondenserAgent();
    const r = await agent.execute({} as never);
    expect(r.success).toBe(true);
    const out = r.output as { skipped: boolean };
    expect(out.skipped).toBe(true);
  });
});

describe("parseCondenseOutput", () => {
  it("parses a plain JSON object", () => {
    const out = parseCondenseOutput(
      JSON.stringify({
        summary: "Cliente confirmou agendamento sexta 10h.",
        facts: [
          { key: "agendamento", value: "sexta 10h", category: "decision" },
        ],
      }),
    );
    expect(out.summary).toMatch(/sexta/);
    expect(out.facts).toHaveLength(1);
  });

  it("strips markdown code fences", () => {
    const wrapped = "```json\n" + JSON.stringify({ summary: "s", facts: [] }) + "\n```";
    const out = parseCondenseOutput(wrapped);
    expect(out.summary).toBe("s");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseCondenseOutput("not json")).toThrow();
  });

  it("rejects facts with invalid category", () => {
    expect(() =>
      parseCondenseOutput(
        JSON.stringify({
          summary: "ok",
          facts: [{ key: "k", value: "v", category: "invalid" }],
        }),
      ),
    ).toThrow();
  });
});

describe("runMemoryCondenser", () => {
  it("persists summary + facts and supersedes covered messages", async () => {
    const factsRepo = {
      insert: vi
        .fn()
        // first call: summary fact insert
        .mockResolvedValueOnce({
          id: 999n,
          factKey: "summary:2024-01-01_2024-01-02",
        })
        // subsequent: facts
        .mockResolvedValueOnce({ id: 1000n })
        .mockResolvedValueOnce({ id: 1001n }),
    };
    const client = {
      query: vi
        .fn()
        // BEGIN
        .mockResolvedValueOnce({})
        // pg_advisory_xact_lock
        .mockResolvedValueOnce({})
        // UPDATE message_embeddings
        .mockResolvedValueOnce({ rowCount: 2 })
        // COMMIT
        .mockResolvedValueOnce({}),
    };
    const db = {
      connect: vi.fn().mockResolvedValue({
        ...client,
        release: vi.fn(),
      }),
    };
    const llmGateway = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          summary: "Cliente quer remarcar para sexta.",
          facts: [
            { key: "preferencia_horario", value: "manha", category: "preference" },
            { key: "agendamento_pendente", value: "sexta 10h", category: "decision" },
          ],
        }),
        tool_calls: [],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        model: "gpt-4o-mini",
        provider: "openai",
        latency_ms: 200,
      }),
    };

    const r = await runMemoryCondenser({
      accountId: 1,
      contactId: 99n,
      messages: [
        {
          messageId: "m1",
          role: "user",
          content: "quero remarcar",
          messageAt: new Date("2024-01-01"),
        },
        {
          messageId: "m2",
          role: "assistant",
          content: "para quando?",
          messageAt: new Date("2024-01-02"),
        },
      ],
      deps: { llmGateway: llmGateway as never, factsRepo: factsRepo as never, db: db as never },
    });

    expect(r.summaryFactId).toBe(999n);
    expect(r.factsCreated).toBe(2);
    expect(r.messagesSuperseded).toBe(2);
    // 3 inserts: 1 summary + 2 facts
    expect(factsRepo.insert).toHaveBeenCalledTimes(3);
    // The first insert must be category=summary and source_agent=memory-condenser
    const firstArg = factsRepo.insert.mock.calls[0]?.[0] as {
      category: string;
      sourceAgent: string;
    };
    expect(firstArg.category).toBe("summary");
    expect(firstArg.sourceAgent).toBe("memory-condenser");
  });

  it("throws when LLM returns malformed JSON", async () => {
    const llmGateway = {
      complete: vi.fn().mockResolvedValue({
        content: "totally not json",
        tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        model: "x",
        provider: "y",
        latency_ms: 1,
      }),
    };
    await expect(
      runMemoryCondenser({
        accountId: 1,
        contactId: 99n,
        messages: [
          {
            messageId: "m1",
            role: "user",
            content: "x",
            messageAt: new Date(),
          },
        ],
        deps: {
          llmGateway: llmGateway as never,
          factsRepo: {} as never,
          db: {} as never,
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects empty message list", async () => {
    await expect(
      runMemoryCondenser({
        accountId: 1,
        contactId: 99n,
        messages: [],
        deps: { llmGateway: {} as never, factsRepo: {} as never, db: {} as never },
      }),
    ).rejects.toThrow(/messages must not be empty/);
  });
});
