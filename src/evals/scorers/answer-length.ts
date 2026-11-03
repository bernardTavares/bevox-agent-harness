import type { Scorer, ScorerInput, ScorerResult } from "../scorer.js";

export class AnswerLengthScorer implements Scorer {
  readonly name = "answer-length";
  readonly kind = "statistical" as const;

  constructor(
    private readonly min: number = 20,
    private readonly max: number = 1500,
  ) {}

  async score(input: ScorerInput): Promise<ScorerResult> {
    const len = input.output.length;
    if (len < this.min) {
      return {
        score: 0,
        reasoning: `Too short: ${len} chars (min ${this.min}).`,
        model_used: null,
      };
    }
    if (len > this.max) {
      return {
        score: 0,
        reasoning: `Too long: ${len} chars (max ${this.max}).`,
        model_used: null,
      };
    }
    return {
      score: 1,
      reasoning: `Length ${len} within [${this.min}, ${this.max}].`,
      model_used: null,
    };
  }
}
