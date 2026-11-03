import { describe, expect, it } from "vitest";

import { evaluateCondenseSignal } from "../../../src/memory/condense-heuristics.js";

function msg(id: string, tokens = 50, daysAgo = 0): {
  messageId: string;
  tokenCount: number;
  messageAt: Date;
} {
  return {
    messageId: id,
    tokenCount: tokens,
    messageAt: new Date(Date.now() - daysAgo * 86400_000),
  };
}

describe("evaluateCondenseSignal", () => {
  it("triggers on messages threshold", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, 5));
    const r = evaluateCondenseSignal({
      accountId: 1,
      contactId: 99n,
      newMessagesSinceLastCondense: msgs,
      config: { thresholdMessages: 50, thresholdTokens: 100000 },
    });
    expect(r.shouldCondense).toBe(true);
    expect(r.reason).toBe("messages_threshold");
    expect(r.messageIdsToCondense).toHaveLength(50);
  });

  it("triggers on tokens threshold", () => {
    const msgs = [msg("a", 5000), msg("b", 4000)];
    const r = evaluateCondenseSignal({
      accountId: 1,
      contactId: 99n,
      newMessagesSinceLastCondense: msgs,
      config: { thresholdMessages: 100, thresholdTokens: 8000 },
    });
    expect(r.shouldCondense).toBe(true);
    expect(r.reason).toBe("tokens_threshold");
  });

  it("triggers on time threshold only when min messages present", () => {
    const oldDate = new Date(Date.now() - 10 * 86400_000); // 10 days ago
    const msgs = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, 10));
    const r = evaluateCondenseSignal({
      accountId: 1,
      contactId: 99n,
      newMessagesSinceLastCondense: msgs,
      lastCondenseAt: oldDate,
      config: { thresholdMessages: 100, thresholdTokens: 100000, thresholdDays: 7 },
    });
    expect(r.shouldCondense).toBe(true);
    expect(r.reason).toBe("time_threshold");
  });

  it("does not trigger on time threshold with too few messages", () => {
    const oldDate = new Date(Date.now() - 10 * 86400_000);
    const r = evaluateCondenseSignal({
      accountId: 1,
      contactId: 99n,
      newMessagesSinceLastCondense: [msg("a", 5), msg("b", 5)],
      lastCondenseAt: oldDate,
      config: { thresholdMessages: 100, thresholdTokens: 100000, thresholdDays: 7 },
    });
    expect(r.shouldCondense).toBe(false);
  });

  it("does not trigger when below all thresholds", () => {
    const r = evaluateCondenseSignal({
      accountId: 1,
      contactId: 99n,
      newMessagesSinceLastCondense: [msg("a", 100), msg("b", 100)],
      config: { thresholdMessages: 50, thresholdTokens: 8000 },
    });
    expect(r.shouldCondense).toBe(false);
    expect(r.messageIdsToCondense).toEqual([]);
  });

  it("does not trigger time threshold without lastCondenseAt", () => {
    const r = evaluateCondenseSignal({
      accountId: 1,
      contactId: 99n,
      newMessagesSinceLastCondense: Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 10)),
      config: { thresholdMessages: 100, thresholdTokens: 100000, thresholdDays: 7 },
    });
    expect(r.shouldCondense).toBe(false);
  });

  it("returns empty signal when zero messages", () => {
    const r = evaluateCondenseSignal({
      accountId: 1,
      contactId: 99n,
      newMessagesSinceLastCondense: [],
      config: { thresholdMessages: 50, thresholdTokens: 8000 },
    });
    expect(r.shouldCondense).toBe(false);
  });

  it("messages_threshold takes precedence over tokens_threshold", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, 1000));
    const r = evaluateCondenseSignal({
      accountId: 1,
      contactId: 99n,
      newMessagesSinceLastCondense: msgs,
      config: { thresholdMessages: 50, thresholdTokens: 8000 },
    });
    expect(r.reason).toBe("messages_threshold");
  });
});
