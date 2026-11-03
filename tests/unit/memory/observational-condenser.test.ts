import { describe, expect, it, vi } from "vitest";

import { ObservationalCondenser } from "../../../src/memory/observational-condenser.js";

describe("ObservationalCondenser.maybeCondense", () => {
  function setup(opts: {
    lastSummaryRows: Array<{ extracted_at: Date }>;
    msgRows: Array<{
      message_id: string;
      token_count: number;
      message_at: Date;
      role: string;
      content: string;
    }>;
    runner?: ReturnType<typeof vi.fn>;
    config?: { thresholdMessages?: number; thresholdTokens?: number; thresholdDays?: number };
  }) {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: opts.lastSummaryRows })
      .mockResolvedValueOnce({ rows: opts.msgRows });
    const runner =
      opts.runner ??
      vi.fn(async () => ({
        summaryFactId: 42n,
        factsCreated: 3,
        messagesSuperseded: opts.msgRows.length,
      }));
    const deps = { llmGateway: {} as never, factsRepo: {} as never, db: { query } as never };
    const condenser = new ObservationalCondenser(
      { query } as never,
      {
        thresholdMessages: opts.config?.thresholdMessages ?? 50,
        thresholdTokens: opts.config?.thresholdTokens ?? 8000,
        thresholdDays: opts.config?.thresholdDays,
      },
      runner as never,
      deps,
    );
    return { condenser, runner, query };
  }

  it("returns ran=false when no candidate messages", async () => {
    const { condenser, runner } = setup({ lastSummaryRows: [], msgRows: [] });
    const r = await condenser.maybeCondense(1, 99n);
    expect(r.ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns ran=false when below thresholds", async () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      message_id: `m${i}`,
      token_count: 10,
      message_at: new Date(),
      role: "user",
      content: "hi",
    }));
    const { condenser, runner } = setup({ lastSummaryRows: [], msgRows: msgs });
    const r = await condenser.maybeCondense(1, 99n);
    expect(r.ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs when messages threshold is met and passes selected messages to runner", async () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({
      message_id: `m${i}`,
      token_count: 5,
      message_at: new Date(),
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`,
    }));
    const { condenser, runner } = setup({
      lastSummaryRows: [],
      msgRows: msgs,
      config: { thresholdMessages: 50, thresholdTokens: 100000 },
    });
    const r = await condenser.maybeCondense(1, 99n);
    expect(r.ran).toBe(true);
    expect(r.reason).toBe("messages_threshold");
    expect(r.summaryFactId).toBe(42n);
    expect(runner).toHaveBeenCalledOnce();
    const passed = runner.mock.calls[0]?.[0] as {
      messages: { messageId: string }[];
    };
    expect(passed.messages).toHaveLength(50);
  });

  it("reads last summary's extracted_at as lastCondenseAt", async () => {
    const oldDate = new Date(Date.now() - 10 * 86400_000);
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      message_id: `m${i}`,
      token_count: 5,
      message_at: new Date(),
      role: "user",
      content: "x",
    }));
    const { condenser, runner } = setup({
      lastSummaryRows: [{ extracted_at: oldDate }],
      msgRows: msgs,
      config: { thresholdMessages: 100, thresholdTokens: 100000, thresholdDays: 7 },
    });
    const r = await condenser.maybeCondense(1, 99n);
    expect(r.ran).toBe(true);
    expect(r.reason).toBe("time_threshold");
    expect(runner).toHaveBeenCalledOnce();
  });
});
