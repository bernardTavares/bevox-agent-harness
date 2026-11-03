import type { Scorer, ScorerInput, ScorerKind, ScorerResult } from "./scorer.js";

export interface RunnerLogger {
  warn(obj: object, msg: string): void;
}

export interface RunnerResult {
  scorer: string;
  /** Carried alongside result so persistence layer doesn't need a kindOf lookup. */
  kind: ScorerKind;
  result: ScorerResult | { error: string };
}

/**
 * Runs N scorers in parallel against the same ScorerInput. A failing scorer
 * does NOT bring down the rest — its error is logged at WARN and surfaced in
 * the RunnerResult as `{ error: string }`. Persistence layer skips error
 * entries.
 */
export class EvalRunner {
  constructor(
    private readonly scorers: Scorer[],
    private readonly logger?: RunnerLogger,
  ) {}

  get registeredScorers(): readonly Scorer[] {
    return this.scorers;
  }

  async run(input: ScorerInput): Promise<RunnerResult[]> {
    return Promise.all(
      this.scorers.map(async (scorer): Promise<RunnerResult> => {
        try {
          const result = await scorer.score(input);
          return { scorer: scorer.name, kind: scorer.kind, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger?.warn(
            {
              scorer: scorer.name,
              execution_id: input.meta.execution_id,
              err: message,
            },
            "scorer_failed",
          );
          return {
            scorer: scorer.name,
            kind: scorer.kind,
            result: { error: message },
          };
        }
      }),
    );
  }
}
