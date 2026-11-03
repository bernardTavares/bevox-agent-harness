import { describe, expect, it, vi } from "vitest";

import { EvalRunner } from "../../../src/evals/runner.js";
import type { Scorer, ScorerInput, ScorerResult } from "../../../src/evals/scorer.js";

const fakeInput: ScorerInput = {
  input: "hi",
  output: "hello",
  meta: {
    execution_id: "66666666-6666-6666-6666-666666666666",
    account_id: 1,
    agent_name: "scheduler",
    reasoning_engine: "react",
  },
};

function makeScorer(name: string, kind: Scorer["kind"], result: ScorerResult | Error): Scorer {
  return {
    name,
    kind,
    score: vi
      .fn<[ScorerInput], Promise<ScorerResult>>()
      .mockImplementation(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
  };
}

describe("EvalRunner", () => {
  it("runs all scorers and tolerates one failing", async () => {
    const ok = makeScorer("ok", "rule", { score: 1, reasoning: "x", model_used: null });
    const fail = makeScorer("fail", "rule", new Error("boom"));
    const results = await new EvalRunner([ok, fail]).run(fakeInput);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ scorer: "ok", kind: "rule" });
    expect((results[0].result as ScorerResult).score).toBe(1);
    expect(results[1]).toMatchObject({ scorer: "fail", kind: "rule" });
    expect((results[1].result as { error: string }).error).toBe("boom");
  });

  it("each RunnerResult carries scorer.kind for persistence", async () => {
    const llm = makeScorer("relevancy", "llm-judge", {
      score: 0.9,
      reasoning: "r",
      model_used: "gpt-4o-mini",
    });
    const stat = makeScorer("len", "statistical", {
      score: 1,
      reasoning: "ok",
      model_used: null,
    });
    const results = await new EvalRunner([llm, stat]).run(fakeInput);
    expect(results.map((r) => r.kind)).toEqual(["llm-judge", "statistical"]);
  });

  it("calls logger.warn on failure", async () => {
    const warn = vi.fn();
    const fail = makeScorer("fail", "rule", new Error("boom"));
    await new EvalRunner([fail], { warn }).run(fakeInput);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ scorer: "fail", err: "boom" }),
      "scorer_failed",
    );
  });

  it("runs scorers in parallel (not serial)", async () => {
    let active = 0;
    let maxActive = 0;
    const slow: Scorer = {
      name: "slow",
      kind: "rule",
      async score() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { score: 1, reasoning: "x", model_used: null };
      },
    };
    await new EvalRunner([slow, slow, slow]).run(fakeInput);
    expect(maxActive).toBeGreaterThanOrEqual(2);
  });
});
