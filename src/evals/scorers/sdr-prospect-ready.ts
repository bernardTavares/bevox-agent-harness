import type { LLMGateway } from "../../integration/llm-gateway.js";
import { buildJudgePrompt, runJudge } from "../judge-prompt.js";
import type { Scorer, ScorerInput, ScorerResult } from "../scorer.js";

/**
 * Prospect-Ready gate (Spec §4.3 / §4.4).
 *
 * LLM judge that scores (0..1) how well the SDR agent output demonstrates
 * understanding of the prospect's world — specifically whether it articulates
 * ≥N of the four required dimensions:
 *   1. Target personas (roles, seniority, function)
 *   2. Buyer pains (specific problems the account faces)
 *   3. Trigger events (signals that create urgency / buying window)
 *   4. Red-flags (reasons to proceed cautiously or disqualify)
 *
 * A score ≥ 0.7 is treated as the certification gate pass threshold by the
 * SDR eval runner (Fase A).
 */
export class SdrProspectReadyScorer implements Scorer {
  readonly name = "sdr-prospect-ready";
  readonly kind = "llm-judge" as const;

  constructor(
    private readonly gateway: LLMGateway,
    private readonly model: string = "gpt-4o-mini",
  ) {}

  async score(input: ScorerInput): Promise<ScorerResult> {
    const prompts = buildJudgePrompt({
      rubric:
        "Evaluate whether the SDR agent's output demonstrates prospect-world readiness. " +
        "Prospect-world readiness means the response explicitly articulates ≥2 of the following " +
        "four dimensions, grounded in the specific account context: " +
        "(1) Target personas — who at this account is the buyer/champion/influencer; " +
        "(2) Buyer pains — the specific business problems or pressures this account faces; " +
        "(3) Trigger events — recent signals (funding, hires, expansions, news) that create urgency; " +
        "(4) Red-flags — reasons to approach cautiously or that may impede a sale.",
      scoringGuide:
        "Score 1.0 = all four dimensions clearly articulated with account-specific evidence; " +
        "Score 0.75 = three dimensions present with reasonable specificity; " +
        "Score 0.5 = two dimensions present or all four are vague/generic; " +
        "Score 0.25 = only one dimension present; " +
        "Score 0.0 = no prospect-world dimensions articulated (generic or empty response).",
      input: input.input,
      output: input.output,
    });

    const result = await runJudge(this.gateway, this.model, prompts, {
      executionId: input.meta.execution_id,
      organizationId: input.meta.organization_id,
      purpose: "eval:sdr-prospect-ready",
    });

    return { score: result.score, reasoning: result.reasoning, model_used: result.model_used };
  }
}
