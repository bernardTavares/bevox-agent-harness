import { describe, expect, it } from "vitest";

import { AnswerLengthScorer } from "../../../../src/evals/scorers/answer-length.js";
import type { ScorerInput } from "../../../../src/evals/scorer.js";

function buildInput(output: string): ScorerInput {
  return {
    input: "qualquer",
    output,
    meta: {
      execution_id: "55555555-5555-5555-5555-555555555555",
      account_id: 1,
      agent_name: "scheduler",
      reasoning_engine: "react",
    },
  };
}

describe("AnswerLengthScorer", () => {
  it("scores too-short as 0", async () => {
    const r = await new AnswerLengthScorer(20, 1500).score(buildInput("ok"));
    expect(r.score).toBe(0);
    expect(r.reasoning).toMatch(/Too short/);
  });

  it("scores too-long as 0", async () => {
    const r = await new AnswerLengthScorer(20, 50).score(buildInput("a".repeat(100)));
    expect(r.score).toBe(0);
    expect(r.reasoning).toMatch(/Too long/);
  });

  it("scores in-range as 1", async () => {
    const r = await new AnswerLengthScorer(5, 50).score(buildInput("hello world"));
    expect(r.score).toBe(1);
    expect(r.reasoning).toMatch(/within/);
  });

  it("model_used is null (statistical)", async () => {
    const r = await new AnswerLengthScorer().score(buildInput("hello world from agent"));
    expect(r.model_used).toBeNull();
  });
});
