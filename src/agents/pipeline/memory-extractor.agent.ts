import type { Pool } from "pg";

import { ContactFactsRepository } from "../../memory/contact-facts.repository.js";
import { ContactProfileRepository } from "../../memory/contact-profile.repository.js";
import type { ContactProfileFields, NewContactFact } from "../../memory/types.js";
import { BaseAgent } from "../base-agent.js";
import type { AgentExecutionContext } from "../execution-context.js";
import type { AgentDefinition, AgentResult } from "../types.js";
import { extractJsonObject } from "./_shared/extract-json.js";

const DEFINITION: AgentDefinition = {
  name: "memory-extractor",
  type: "pipeline",
  description: "Extracts personal data from messages and updates contact profile and facts",
  reasoning: { default: "direct" },
  permissions: {
    required: ["read-profile", "write-profile", "write-fact"],
    denied: ["send-message", "request-human", "create-appointment", "cancel-appointment"],
  },
};

// Keys that map to fixed columns in contact_profiles
const FIXED_FIELD_KEYS = new Set([
  "full_name",
  "preferred_name",
  "birth_date",
  "gender",
  "document_number",
  "phone",
  "email",
  "address",
  "city",
  "state",
  "preferred_language",
  "preferred_contact_channel",
  "preferred_time_from",
  "preferred_time_to",
]);

interface ExtractedItem {
  type: "fixed" | "dynamic";
  key: string; // snake_case — matches ContactProfileFields key (fixed) or fact_key (dynamic)
  value: string;
  category?: string; // only for dynamic facts
  confidence: number;
}

interface ExtractionOutput {
  extracted: ExtractedItem[];
  nothingFound: boolean;
}

export class MemoryExtractorAgent extends BaseAgent {
  private readonly profileRepo: ContactProfileRepository;
  private readonly factsRepo: ContactFactsRepository;

  constructor(
    private readonly db: Pool,
    profileRepo?: ContactProfileRepository,
    factsRepo?: ContactFactsRepository,
  ) {
    super(DEFINITION);
    this.profileRepo = profileRepo ?? new ContactProfileRepository(db);
    this.factsRepo = factsRepo ?? new ContactFactsRepository(db);
  }

  async execute(context: AgentExecutionContext): Promise<AgentResult> {
    const startMs = Date.now();
    const { organizationId, contactId, conversationKey, executionId } = context;

    if (!contactId) {
      return { success: true, output: { skipped: true, reason: "no_contact_id" } };
    }

    const incomingText = this.extractIncomingText(context);
    if (!incomingText) {
      return { success: true, output: { skipped: true, reason: "no_incoming_message" } };
    }

    // Load current profile and facts to give LLM context
    const [profile, activeFacts] = await Promise.all([
      this.profileRepo.findOrCreate(organizationId, contactId),
      this.factsRepo.listActive(organizationId, contactId),
    ]);

    const systemPrompt = `You are a data extraction system for a customer service AI.
Extract personal information about the customer from their message.
Return a JSON object with field "extracted" (array) and "nothingFound" (boolean).

Each item in "extracted" must have:
- type: "fixed" (known profile field) or "dynamic" (any other personal fact)
- key: snake_case identifier
- value: the extracted value as a string
- category: (only for dynamic) a grouping like "family", "health", "preference", "work"
- confidence: number 0–1 indicating extraction confidence

Fixed fields (use these exact keys for type "fixed"):
full_name, preferred_name, birth_date, gender, document_number,
phone, email, address, city, state,
preferred_language, preferred_contact_channel,
preferred_time_from, preferred_time_to

Only extract information explicitly stated. Do not infer. Return ONLY valid JSON.`;

    const currentProfileSummary = JSON.stringify({
      full_name: profile.fullName,
      phone: profile.phone,
      email: profile.email,
    });

    const currentFactsSummary = activeFacts
      .slice(0, 20)
      .map((f) => `${f.factKey}: ${f.factValue}`)
      .join("\n");

    const userPrompt = `Current profile: ${currentProfileSummary}
Known facts:\n${currentFactsSummary || "(none)"}

Customer message:\n${incomingText}`;

    let extraction: ExtractionOutput;
    let modelUsed: string;

    try {
      // DirectEngine pattern: single structured LLM call.
      // LLM client will be wired in sub-project 4.
      const response = await context.llmClient.complete({
        model: context.accountConfig?.llmModel ?? "gpt-4o-mini",
        system: systemPrompt,
        user: userPrompt,
        responseFormat: { type: "json_object" },
        maxTokens: 512,
      });
      modelUsed = response.model;
      extraction = extractJsonObject<ExtractionOutput>(response.content);
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (extraction.nothingFound || !extraction.extracted?.length) {
      return {
        success: true,
        output: { extracted: [], skipped: false },
        modelUsed,
        processingMs: Date.now() - startMs,
      };
    }

    // Apply confidence thresholds:
    //   > 0.8  → confirmed = true (handled in insert)
    //   0.5–0.8 → confirmed = false (unconfirmed)
    //   < 0.5  → discard
    const toWrite = extraction.extracted.filter((item) => item.confidence >= 0.5);
    if (toWrite.length === 0) {
      return {
        success: true,
        output: { extracted: [], lowConfidenceDiscarded: extraction.extracted.length },
        modelUsed,
        processingMs: Date.now() - startMs,
      };
    }

    // Acquire pg_advisory_xact_lock and write inside a transaction.
    // Advisory lock keyed by contact_id prevents concurrent writes for the same contact.
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      // pg_advisory_xact_lock takes a bigint; pass contact_id directly
      await client.query("SELECT pg_advisory_xact_lock($1)", [contactId]);

      const fixedItems = toWrite.filter((i) => i.type === "fixed" && FIXED_FIELD_KEYS.has(i.key));
      const dynamicItems = toWrite.filter((i) => i.type === "dynamic");

      // Write fixed fields to contact_profiles
      if (fixedItems.length > 0) {
        const camelMap: Record<string, string> = {
          full_name: "fullName",
          preferred_name: "preferredName",
          birth_date: "birthDate",
          gender: "gender",
          document_number: "documentNumber",
          phone: "phone",
          email: "email",
          address: "address",
          city: "city",
          state: "state",
          preferred_language: "preferredLanguage",
          preferred_contact_channel: "preferredContactChannel",
          preferred_time_from: "preferredTimeFrom",
          preferred_time_to: "preferredTimeTo",
        };

        const fields: ContactProfileFields = {};
        for (const item of fixedItems) {
          const camelKey = camelMap[item.key];
          if (camelKey) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (fields as any)[camelKey] = item.value;
          }
        }
        await this.profileRepo.update(organizationId, contactId, fields, client);
      }

      // Write dynamic facts to contact_facts (superseding stale values)
      for (const item of dynamicItems) {
        const newFact: NewContactFact = {
          organizationId,
          contactId,
          factKey: item.key,
          factValue: item.value,
          category: item.category,
          confidence: item.confidence,
          sourceConversationKey: conversationKey,
          sourceExecutionId: executionId,
        };
        await this.factsRepo.upsertFact(newFact, client);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      return {
        success: false,
        output: null,
        error: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      client.release();
    }

    return {
      success: true,
      output: {
        extracted: toWrite.length,
        fixed: toWrite.filter((i) => i.type === "fixed").length,
        dynamic: toWrite.filter((i) => i.type === "dynamic").length,
        discarded: extraction.extracted.length - toWrite.length,
      },
      modelUsed,
      processingMs: Date.now() - startMs,
    };
  }

  private extractIncomingText(context: AgentExecutionContext): string {
    const incomingMessages = (context.messages ?? [])
      .filter((m) => m.direction === "incoming")
      .map((m) => m.content)
      .join("\n");
    return incomingMessages.trim();
  }
}
