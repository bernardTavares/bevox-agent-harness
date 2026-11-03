import type { Pool } from "pg";

import { calculateCostCents, type CostLogger } from "./cost-calculator.js";

export interface UsageEntry {
  executionId: string;
  organizationId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  purpose?: string;
}

/**
 * Records LLM usage (tokens/cost/latency) to the `execution_usage` table.
 * Cost is computed via `cost-calculator` from the model name.
 *
 * Phase 5 will wrap this in a Usage decorator around the LLM adapter chain.
 */
export class UsageTracker {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: CostLogger,
  ) {}

  async record(entry: UsageEntry): Promise<void> {
    const cost = calculateCostCents(
      entry.model,
      entry.promptTokens,
      entry.completionTokens,
      this.logger,
    );
    const totalTokens = entry.promptTokens + entry.completionTokens;
    await this.pool.query(
      `INSERT INTO execution_usage
        (execution_id, organization_id, provider, model,
         prompt_tokens, completion_tokens, total_tokens,
         cost_usd_cents, latency_ms, call_purpose)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        entry.executionId,
        entry.organizationId,
        entry.provider,
        entry.model,
        entry.promptTokens,
        entry.completionTokens,
        totalTokens,
        cost,
        entry.latencyMs,
        entry.purpose ?? null,
      ],
    );
  }
}
