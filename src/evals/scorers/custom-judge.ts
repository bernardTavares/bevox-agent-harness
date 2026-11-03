import type { LLMGateway } from "../../integration/llm-gateway.js";
import { buildJudgePrompt, runJudge } from "../judge-prompt.js";
import type { Scorer, ScorerInput, ScorerResult } from "../scorer.js";

export interface CustomJudgeConfig {
  /** Logical name (suffix). Final scorer name = `custom:<name>`. */
  name: string;
  rubric: string;
  scoringGuide: string;
  /** If true, ScorerInput.context is JSON-serialized into the prompt. */
  useContext?: boolean;
  /** Defaults to gpt-4o-mini. */
  model?: string;
}

/**
 * Lets operators register an ad-hoc LLM-as-judge scorer in harness-config
 * (evals.custom_judges[]) without writing new code.
 */
export class CustomJudgeScorer implements Scorer {
  readonly kind = "llm-judge" as const;
  readonly name: string;

  constructor(
    private readonly gateway: LLMGateway,
    private readonly config: CustomJudgeConfig,
  ) {
    this.name = `custom:${config.name}`;
  }

  async score(input: ScorerInput): Promise<ScorerResult> {
    const ctxBlock =
      this.config.useContext && input.context ? JSON.stringify(input.context, null, 2) : undefined;
    const prompts = buildJudgePrompt({
      rubric: this.config.rubric,
      scoringGuide: this.config.scoringGuide,
      contextBlock: ctxBlock,
      input: input.input,
      output: input.output,
    });
    const result = await runJudge(this.gateway, this.config.model ?? "gpt-4o-mini", prompts, {
      executionId: input.meta.execution_id,
      organizationId: input.meta.organization_id,
      purpose: `eval:${this.name}`,
    });
    return { score: result.score, reasoning: result.reasoning, model_used: result.model_used };
  }
}
