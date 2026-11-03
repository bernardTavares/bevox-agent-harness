import type { Pool } from "pg";

import { createLogger } from "../config/logger.js";
import { getHarnessConfig } from "../config/harness-config.js";

import type { ScorerKind } from "./scorer.js";

const logger = createLogger({
  name: "eval-results-repo",
  level: getHarnessConfig().harness.logLevel,
});

export interface EvalResultEntry {
  executionId: string;
  organizationId: string;
  scorerName: string;
  scorerKind: ScorerKind;
  /** Null allowed — see migration 004 rationale. */
  score: number | null;
  reasoning: string;
  modelUsed: string | null;
  samplingReason: string;
}

/**
 * Persists scorer outputs to `eval_results`. Mirrors the
 * fire-and-forget pattern from `src/observability/usage-tracker.ts`:
 * errors are logged at WARN level — never thrown back to the caller —
 * because eval persistence must NOT block the worker.
 */
export class EvalResultsRepository {
  constructor(private readonly pool: Pool) {}

  async insert(entry: EvalResultEntry): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO eval_results (
          execution_id, organization_id, scorer_name, scorer_kind,
          score, reasoning, model_used, sampling_reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          entry.executionId,
          entry.organizationId,
          entry.scorerName,
          entry.scorerKind,
          entry.score,
          entry.reasoning,
          entry.modelUsed,
          entry.samplingReason,
        ],
      );
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          execution_id: entry.executionId,
          scorer: entry.scorerName,
        },
        "eval_result_insert_failed",
      );
    }
  }
}
