import type { LLMGateway } from "../integration/llm-gateway.js";

import { AnswerLengthScorer } from "./scorers/answer-length.js";
import { FaithfulnessScorer } from "./scorers/faithfulness.js";
import { NoPiiScorer } from "./scorers/no-pii.js";
import { RelevancyScorer } from "./scorers/relevancy.js";
import { SdrAuditGateScorer } from "./scorers/sdr-audit-gate.js";
import { SdrMessageReadyScorer } from "./scorers/sdr-message-ready.js";
import { SdrProspectReadyScorer } from "./scorers/sdr-prospect-ready.js";
import { ToxicityScorer } from "./scorers/toxicity.js";
import type { Scorer } from "./scorer.js";

export interface ScorerFactoryOptions {
  gateway?: LLMGateway;
  judgeModel?: string;
}

/**
 * Resolves a list of scorer names to concrete Scorer instances.
 * Unknown names are silently skipped (logged by caller if needed).
 * LLM-as-judge scorers are skipped when no gateway is provided.
 */
export function buildScorers(names: string[], options: ScorerFactoryOptions = {}): Scorer[] {
  const out: Scorer[] = [];
  const model = options.judgeModel ?? "gpt-4o-mini";
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    switch (name) {
      case "relevancy":
        if (options.gateway) out.push(new RelevancyScorer(options.gateway, model));
        break;
      case "toxicity":
        if (options.gateway) out.push(new ToxicityScorer(options.gateway, model));
        break;
      case "faithfulness":
        if (options.gateway) out.push(new FaithfulnessScorer(options.gateway, model));
        break;
      case "no-pii":
        out.push(new NoPiiScorer());
        break;
      case "answer-length":
        out.push(new AnswerLengthScorer());
        break;
      case "sdr-audit-gate":
        out.push(new SdrAuditGateScorer());
        break;
      case "sdr-message-ready":
        out.push(new SdrMessageReadyScorer());
        break;
      case "sdr-prospect-ready":
        if (options.gateway) out.push(new SdrProspectReadyScorer(options.gateway, model));
        break;
      default:
        // ignore unknown names (custom judges handled separately)
        break;
    }
  }
  return out;
}
