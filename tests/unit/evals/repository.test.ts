import { describe, expect, it, vi } from "vitest";

import { EvalResultsRepository, type EvalResultEntry } from "../../../src/evals/repository.js";

function fakeEntry(overrides: Partial<EvalResultEntry> = {}): EvalResultEntry {
  return {
    executionId: "11111111-1111-1111-1111-111111111111",
    accountId: 42,
    scorerName: "relevancy",
    scorerKind: "llm-judge",
    score: 0.87,
    reasoning: "Directly answers.",
    modelUsed: "gpt-4o-mini",
    samplingReason: "policy:ratio:0.1",
    ...overrides,
  };
}

describe("EvalResultsRepository", () => {
  it("issues a single parameterized INSERT with 8 params", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = { query } as unknown as import("pg").Pool;
    await new EvalResultsRepository(pool).insert(fakeEntry());

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO eval_results/);
    expect(params).toHaveLength(8);
    expect(params[4]).toBe(0.87); // score
    expect(params[6]).toBe("gpt-4o-mini"); // model_used
  });

  it("persists score=null when scorer returns N/A", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = { query } as unknown as import("pg").Pool;
    await new EvalResultsRepository(pool).insert(fakeEntry({ score: null }));
    expect(query.mock.calls[0][1][4]).toBeNull();
  });

  it("swallows DB errors (fire-and-forget)", async () => {
    const query = vi.fn().mockRejectedValue(new Error("connection refused"));
    const pool = { query } as unknown as import("pg").Pool;
    // Must NOT throw.
    await expect(
      new EvalResultsRepository(pool).insert(fakeEntry()),
    ).resolves.toBeUndefined();
  });
});
