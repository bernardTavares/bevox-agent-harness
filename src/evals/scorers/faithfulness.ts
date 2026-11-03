import type { LLMGateway } from "../../integration/llm-gateway.js";
import { buildJudgePrompt, runJudge } from "../judge-prompt.js";
import type { Scorer, ScorerInput, ScorerResult } from "../scorer.js";

/**
 * Faithfulness checks whether the response is grounded in the provided
 * context (facts + knowledge layers). When neither is present, returns
 * `score: null` — dashboards filter `score IS NOT NULL` so the metric is
 * not inflated by N/A cases.
 */
export class FaithfulnessScorer implements Scorer {
  readonly name = "faithfulness";
  readonly kind = "llm-judge" as const;

  constructor(
    private readonly gateway: LLMGateway,
    private readonly model: string = "gpt-4o-mini",
  ) {}

  async score(input: ScorerInput): Promise<ScorerResult> {
    const facts = input.context?.facts ?? [];
    const knowledge = input.context?.knowledge ?? [];
    if (facts.length === 0 && knowledge.length === 0) {
      return {
        score: null,
        reasoning: "No grounding context (facts/knowledge) provided; faithfulness N/A.",
        model_used: null,
      };
    }
    const ctxBlock = JSON.stringify({ facts, knowledge }, null, 2);
    const prompts = buildJudgePrompt({
      rubric:
        "Evaluate whether the agent's response is faithful to the provided context (no hallucinations).",
      scoringGuide:
        "Score 1.0 = every claim grounded; 0.5 = mostly grounded with minor extrapolation; 0.0 = invented facts.",
      contextBlock: ctxBlock,
      input: input.input,
      output: input.output,
    });
    const result = await runJudge(this.gateway, this.model, prompts, {
      executionId: input.meta.execution_id,
      organizationId: input.meta.organization_id,
      purpose: "eval:faithfulness",
    });
    return { score: result.score, reasoning: result.reasoning, model_used: result.model_used };
  }
}
