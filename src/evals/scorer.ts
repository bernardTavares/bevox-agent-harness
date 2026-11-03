/**
 * Scorer framework — Sprint A.2.
 *
 * Conventions:
 *  - `score` is ALWAYS in [0, 1] OR `null` when the scorer cannot meaningfully
 *    evaluate (e.g. FaithfulnessScorer without grounding context). Dashboards
 *    must filter `score IS NOT NULL` for averages.
 *  - Higher = better. Toxicity scorers return (1 - toxic) so the convention
 *    holds uniformly.
 *  - `reasoning` is always provided so manual review / audit is possible.
 */

import { z } from "zod";

export type ScorerKind = "llm-judge" | "rule" | "statistical";

export interface ScorerInput {
  /** Last user message in the thread. */
  input: string;
  /** Final response synthesized by the agent. */
  output: string;
  /** Context fed to the agent (5-layer context builder output, optional). */
  context?: {
    system_prompt?: string;
    contact_profile?: Record<string, unknown>;
    facts?: Array<{ key: string; value: string }>;
    knowledge?: string[];
  };
  /** Metadata for downstream joins. */
  meta: {
    execution_id: string;
    organization_id: string;
    agent_name: string;
    reasoning_engine: string;
  };
}

export const scorerResultSchema = z.object({
  /**
   * Score in [0, 1] OR null. Null signals "cannot evaluate" — persisted but
   * excluded from averages.
   */
  score: z.number().min(0).max(1).nullable(),
  reasoning: z.string().min(1).max(2000),
  /** Model used by LLM-as-judge scorers; null for rule/statistical. */
  model_used: z.string().nullable(),
});

export type ScorerResult = z.infer<typeof scorerResultSchema>;

export interface Scorer {
  readonly name: string;
  readonly kind: ScorerKind;
  score(input: ScorerInput): Promise<ScorerResult>;
}
