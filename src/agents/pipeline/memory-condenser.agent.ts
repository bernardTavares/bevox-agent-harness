/**
 * Sprint D.3 — memory-condenser pipeline agent.
 *
 * Runs OUT of the main execution flow (BullMQ worker `harness.memory.condense`)
 * to:
 *   1. Call LLMGateway with the condenser prompts → parse strict JSON.
 *   2. Persist the summary as a contact_fact (category='summary').
 *   3. Persist extracted facts.
 *   4. Mark the covered message_embeddings rows with
 *      `superseded_by_summary_fact_id` so the semantic-recall query skips them.
 *
 * Aligned with the AgentDefinition contract for discoverability and visibility
 * in the AgentRegistry; the runtime fn `runMemoryCondenser` is invoked
 * directly by the worker (no surface loop, no tool calls).
 *
 * LLM calls go through `LLMGateway.complete()` directly — same shape as
 * DirectEngine, since this is a single-shot structured-output extraction.
 */

import type { Pool } from "pg";
import { z } from "zod";

import { withSpan } from "../../observability/spans.js";
import type { ContactFactsRepository } from "../../memory/contact-facts.repository.js";
import type { NewContactFact } from "../../memory/types.js";
import type { LLMGateway } from "../../integration/llm-gateway.js";
import { BaseAgent } from "../base-agent.js";
import type { AgentExecutionContext } from "../execution-context.js";
import type { AgentDefinition, AgentResult } from "../types.js";
import { extractJsonObject, JsonExtractionError } from "./_shared/extract-json.js";

import {
  buildCondenserUserPrompt,
  CONDENSE_OUTPUT_JSON_SCHEMA,
  MEMORY_CONDENSER_SYSTEM_PROMPT,
} from "./memory-condenser.prompt.js";

export const memoryCondenserAgent: AgentDefinition = {
  name: "memory-condenser",
  type: "pipeline",
  description:
    "Condenses old conversation slices into a contact_facts summary + facts. " +
    "Runs out-of-band in the harness.memory.condense BullMQ queue.",
  reasoning: { default: "direct" },
  permissions: { required: [], denied: ["send-message", "request-human"] },
};

/**
 * Thin BaseAgent wrapper — registered in AgentRegistry for discoverability,
 * tracing, and permission/registry parity with other pipeline agents.
 *
 * The actual condense execution path is `runMemoryCondenser` (called by the
 * BullMQ worker), NOT this `.execute()` — pipeline agents in the main flow
 * already provide MemoryExtractor.
 */
export class MemoryCondenserAgent extends BaseAgent {
  constructor() {
    super(memoryCondenserAgent);
  }
  async execute(_context: AgentExecutionContext): Promise<AgentResult> {
    return {
      success: true,
      output: {
        skipped: true,
        reason: "memory-condenser is invoked out-of-band via the condense queue",
      },
    };
  }
}

const condenseOutputSchema = z.object({
  summary: z.string().min(1).max(500),
  facts: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        value: z.string().min(1).max(300),
        category: z.enum([
          "personal",
          "preference",
          "restriction",
          "history",
          "decision",
          "contact",
        ]),
      }),
    )
    .max(20),
});

export type CondenseOutput = z.infer<typeof condenseOutputSchema>;

export interface CondenseRunInput {
  organizationId: string;
  contactId: bigint;
  /** Conversation messages covered by this condense run (chronological). */
  messages: {
    messageId: string;
    role: string;
    content: string;
    messageAt: Date;
  }[];
  /** Optional execution id for telemetry / source_execution_id. */
  executionId?: string;
  deps: {
    llmGateway: LLMGateway;
    factsRepo: ContactFactsRepository;
    db: Pool;
  };
}

export interface CondenseRunResult {
  summaryFactId: bigint;
  factsCreated: number;
  messagesSuperseded: number;
}

/**
 * Parse possibly-imperfect LLM output. Some providers wrap JSON in code
 * fences or surround it with prose; the shared extractor strips them
 * defensively (finding a-agents-03) before Zod validates the shape.
 */
export function parseCondenseOutput(raw: string): CondenseOutput {
  let json: unknown;
  try {
    json = extractJsonObject(raw);
  } catch (err) {
    if (err instanceof JsonExtractionError) {
      throw new Error(`memory-condenser: LLM output is not valid JSON: ${err.message}`);
    }
    throw err;
  }
  return condenseOutputSchema.parse(json);
}

export async function runMemoryCondenser(input: CondenseRunInput): Promise<CondenseRunResult> {
  const { organizationId, contactId, messages, deps, executionId } = input;
  if (messages.length === 0) {
    throw new Error("runMemoryCondenser: messages must not be empty");
  }

  return withSpan(
    "memory.condense.run",
    {
      "memory.organization_id": organizationId,
      "memory.contact_id": String(contactId),
      "memory.message_count": messages.length,
    },
    async (span) => {
      const llmResp = await withSpan(
        "memory.condense.llm",
        { "memory.message_count": messages.length },
        async () =>
          deps.llmGateway.complete({
            messages: [
              { role: "system", content: MEMORY_CONDENSER_SYSTEM_PROMPT },
              {
                role: "user",
                content: buildCondenserUserPrompt({ messages }),
              },
            ],
            responseSchema: CONDENSE_OUTPUT_JSON_SCHEMA,
            maxTokens: 1024,
            temperature: 0.1,
            meta: { organizationId, executionId, purpose: "memory-condenser" },
          }),
      );

      const parsed = parseCondenseOutput(llmResp.content ?? "");

      const firstAt = messages[0]!.messageAt;
      const lastAt = messages.at(-1)!.messageAt;
      const summaryKey = `summary:${firstAt.toISOString().slice(0, 10)}_${lastAt
        .toISOString()
        .slice(0, 10)}`;

      const client = await deps.db.connect();
      let summaryFactId: bigint;
      let factsCreated = 0;
      let messagesSuperseded = 0;

      try {
        await client.query("BEGIN");
        // Lock on contact_id to serialize concurrent condense + extractor
        // writes (mirrors MemoryExtractor's advisory lock).
        await client.query("SELECT pg_advisory_xact_lock($1)", [contactId]);

        const summaryFact = await deps.factsRepo.insert(
          {
            organizationId,
            contactId,
            factKey: summaryKey,
            factValue: parsed.summary,
            category: "summary",
            confidence: 0.7, // medium — unconfirmed pending review
            sourceExecutionId: executionId,
            sourceAgent: "memory-condenser",
          } satisfies NewContactFact,
          client,
        );
        summaryFactId = summaryFact.id;

        for (const f of parsed.facts) {
          await deps.factsRepo.insert(
            {
              organizationId,
              contactId,
              factKey: f.key,
              factValue: f.value,
              category: f.category,
              confidence: 0.6,
              sourceExecutionId: executionId,
              sourceAgent: "memory-condenser",
            } satisfies NewContactFact,
            client,
          );
          factsCreated++;
        }

        // Mark the message_embeddings rows that were just summarized.
        const ids = messages.map((m) => m.messageId);
        const r = await client.query(
          `UPDATE message_embeddings
              SET superseded_by_summary_fact_id = $1
            WHERE organization_id = $2
              AND contact_id = $3
              AND message_id = ANY($4::text[])
              AND superseded_by_summary_fact_id IS NULL`,
          [summaryFactId, organizationId, contactId, ids],
        );
        messagesSuperseded = r.rowCount ?? 0;

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }

      span.setAttribute("memory.facts_created", factsCreated);
      span.setAttribute("memory.messages_superseded", messagesSuperseded);
      return { summaryFactId, factsCreated, messagesSuperseded };
    },
  );
}
