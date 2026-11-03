import type { LLMGateway } from "../../integration/llm-gateway.js";
import { buildJudgePrompt, runJudge } from "../judge-prompt.js";
import type { Scorer, ScorerInput, ScorerResult } from "../scorer.js";

export class RelevancyScorer implements Scorer {
  readonly name = "relevancy";
  readonly kind = "llm-judge" as const;

  constructor(
    private readonly gateway: LLMGateway,
    private readonly model: string = "gpt-4o-mini",
  ) {}

  async score(input: ScorerInput): Promise<ScorerResult> {
    const prompts = buildJudgePrompt({
      rubric:
        "Evaluate whether the agent's response directly addresses the user's question or request.",
      scoringGuide:
        "Score 1.0 = fully addresses; 0.5 = partially addresses; 0.0 = ignores the request.",
      input: input.input,
      output: input.output,
    });
    const result = await runJudge(this.gateway, this.model, prompts, {
      executionId: input.meta.execution_id,
      organizationId: input.meta.organization_id,
      purpose: "eval:relevancy",
    });
    return { score: result.score, reasoning: result.reasoning, model_used: result.model_used };
  }
}
