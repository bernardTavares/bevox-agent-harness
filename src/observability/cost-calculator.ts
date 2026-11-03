/**
 * Cost calculation for LLM calls.
 *
 * Pricing is stored as USD cents per 1M tokens. Multiply by tokens and divide
 * by 1_000_000, then ceil to avoid undercounting fractional cents.
 *
 * Unknown models log once via the provided logger and report cost 0.
 */

export interface ModelPricing {
  /** USD cents per 1M prompt tokens */
  prompt: number;
  /** USD cents per 1M completion tokens */
  completion: number;
}

export const PRICING_PER_1M_TOKENS_USD_CENTS: Readonly<Record<string, ModelPricing>> = {
  // OpenAI
  "gpt-4o-mini": { prompt: 15, completion: 60 },
  "gpt-4o": { prompt: 250, completion: 1000 },
  "gpt-4-turbo": { prompt: 1000, completion: 3000 },
  // Gemini
  "gemini-1.5-pro": { prompt: 125, completion: 500 },
  "gemini-1.5-flash": { prompt: 7.5, completion: 30 },
  "gemini-2.0-flash": { prompt: 10, completion: 40 },
};

const warnedModels = new Set<string>();

export interface CostLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Calculate cost in USD cents for a given LLM call.
 * Returns 0 (and warns once per model) when the model is not in the pricing table.
 */
export function calculateCostCents(
  model: string,
  promptTokens: number,
  completionTokens: number,
  logger?: CostLogger,
): number {
  const pricing = PRICING_PER_1M_TOKENS_USD_CENTS[model];
  if (!pricing) {
    if (logger && !warnedModels.has(model)) {
      warnedModels.add(model);
      logger.warn({ model }, "cost_calculator: unknown model, cost reported as 0");
    }
    return 0;
  }
  const cents = (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1_000_000;
  return Math.ceil(cents);
}

/** Test hook: reset the once-per-model warning cache. */
export function _resetWarnedModelsForTest(): void {
  warnedModels.clear();
}
