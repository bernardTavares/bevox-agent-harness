/**
 * Sprint D.3 — ObservationalCondenser orchestrator.
 *
 * Per-(organization, contact) decision: should we condense now? If yes, run the
 * memory-condenser pipeline agent against the qualifying messages. Pure DB
 * + LLM gateway; queued/owned by the `harness.memory.condense` BullMQ worker.
 */

import type { Pool } from "pg";

import { withSpan } from "../observability/spans.js";
import type { runMemoryCondenser } from "../agents/pipeline/memory-condenser.agent.js";
import type { ContactFactsRepository } from "./contact-facts.repository.js";
import { evaluateCondenseSignal, type CondenseHeuristicConfig } from "./condense-heuristics.js";
import type { LLMGateway } from "../integration/llm-gateway.js";

export interface ObservationalCondenserDeps {
  llmGateway: LLMGateway;
  factsRepo: ContactFactsRepository;
  db: Pool;
}

export interface CondenserRunner {
  (input: {
    organizationId: string;
    contactId: bigint;
    messages: { messageId: string; role: string; content: string; messageAt: Date }[];
    executionId?: string;
    deps: ObservationalCondenserDeps;
  }): ReturnType<typeof runMemoryCondenser>;
}

export interface MaybeCondenseResult {
  ran: boolean;
  reason?: string;
  summaryFactId?: bigint;
  factsCreated?: number;
  messagesSuperseded?: number;
}

export class ObservationalCondenser {
  constructor(
    private readonly db: Pool,
    private readonly heuristicConfig: CondenseHeuristicConfig,
    private readonly runner: CondenserRunner,
    private readonly deps: ObservationalCondenserDeps,
  ) {}

  async maybeCondense(organizationId: string, contactId: bigint): Promise<MaybeCondenseResult> {
    return withSpan(
      "memory.condense.evaluate",
      {
        "memory.organization_id": organizationId,
        "memory.contact_id": String(contactId),
      },
      async (span) => {
        // 1) Last condense → look at contact_facts category='summary'.
        const lastSummary = await this.db.query<{ extracted_at: Date }>(
          `SELECT extracted_at FROM contact_facts
             WHERE organization_id = $1 AND contact_id = $2
               AND category = 'summary' AND superseded_by IS NULL
             ORDER BY extracted_at DESC LIMIT 1`,
          [organizationId, contactId],
        );
        const lastCondenseAt = lastSummary.rows[0]?.extracted_at ?? null;

        // 2) Messages not yet summarized for this contact.
        const msgs = await this.db.query<{
          message_id: string;
          token_count: number;
          message_at: Date;
          role: string;
          content: string;
        }>(
          `SELECT message_id, token_count, message_at, role, content
             FROM message_embeddings
            WHERE organization_id = $1 AND contact_id = $2
              AND superseded_by_summary_fact_id IS NULL
            ORDER BY message_at ASC`,
          [organizationId, contactId],
        );

        const signal = evaluateCondenseSignal({
          organizationId,
          contactId,
          newMessagesSinceLastCondense: msgs.rows.map((m) => ({
            messageId: m.message_id,
            tokenCount: m.token_count,
            messageAt: m.message_at,
          })),
          lastCondenseAt,
          config: this.heuristicConfig,
        });

        span.setAttribute("memory.candidate_count", msgs.rows.length);
        span.setAttribute("memory.should_condense", signal.shouldCondense);
        if (signal.reason) span.setAttribute("memory.reason", signal.reason);

        if (!signal.shouldCondense) {
          return { ran: false };
        }

        const idSet = new Set(signal.messageIdsToCondense);
        const selected = msgs.rows
          .filter((m) => idSet.has(m.message_id))
          .map((m) => ({
            messageId: m.message_id,
            role: m.role,
            content: m.content,
            messageAt: m.message_at,
          }));

        const result = await this.runner({
          organizationId,
          contactId,
          messages: selected,
          deps: this.deps,
        });

        return {
          ran: true,
          reason: signal.reason,
          summaryFactId: result.summaryFactId,
          factsCreated: result.factsCreated,
          messagesSuperseded: result.messagesSuperseded,
        };
      },
    );
  }
}
