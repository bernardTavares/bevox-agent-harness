import type { Pool } from "pg";

import { BaseAgent } from "../base-agent.js";
import type { AgentExecutionContext } from "../execution-context.js";
import type { AgentDefinition, AgentResult } from "../types.js";
import { extractJsonObject } from "./_shared/extract-json.js";

const DEFINITION: AgentDefinition = {
  name: "message-analyzer",
  type: "pipeline",
  description: "Classifies incoming messages: sentiment, intent, topics, urgency",
  reasoning: { default: "direct" },
  permissions: {
    required: [],
    denied: ["*"],
  },
};

interface ClassificationOutput {
  sentiment: "positive" | "neutral" | "negative" | "frustrated" | "angry" | "confused";
  sentimentConfidence: number;
  intent: string;
  intentConfidence: number;
  topics: string[];
  urgency: "low" | "medium" | "high" | "critical";
  sdrSubMode?: "reativacao" | "qualificacao" | "nurture" | "handoff-iminente";
}

export class MessageAnalyzerAgent extends BaseAgent {
  constructor(private readonly db: Pool) {
    super(DEFINITION);
  }

  async execute(context: AgentExecutionContext): Promise<AgentResult> {
    const startMs = Date.now();

    // Extract the most recent incoming message text from context.
    // Only processes client-side (incoming) messages.
    const incomingText = this.extractIncomingText(context);

    if (!incomingText) {
      return { success: true, output: null }; // nothing to classify
    }

    const systemPrompt = `You are a message classification system for a customer service AI.
Analyze the customer message and return a JSON object with these exact fields:
- sentiment: one of "positive", "neutral", "negative", "frustrated", "angry", "confused"
- sentimentConfidence: number between 0 and 1
- intent: a short snake_case string describing the primary intent (e.g. "scheduling", "scheduling_cancellation", "scheduling_reschedule", "question", "complaint", "unknown")
- intentConfidence: number between 0 and 1
- topics: array of relevant topic strings (e.g. ["appointment", "doctor", "date_change"])
- urgency: one of "low", "medium", "high", "critical"
- sdrSubMode (optional): SDR engagement sub-mode — one of "reativacao", "qualificacao", "nurture", "handoff-iminente"; omit if not applicable

Return ONLY valid JSON. No markdown, no explanation.`;

    const userPrompt = `Customer message:\n${incomingText}`;

    let classification: ClassificationOutput;
    let modelUsed: string;

    try {
      // DirectEngine pattern: single structured LLM call.
      // LLM client will be wired in sub-project 4.
      const response = await context.llmClient.complete({
        model: context.accountConfig?.llmModel ?? "gpt-4o-mini",
        system: systemPrompt,
        user: userPrompt,
        responseFormat: { type: "json_object" },
        maxTokens: 256,
      });

      modelUsed = response.model;
      classification = extractJsonObject<ClassificationOutput>(response.content);
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const processingMs = Date.now() - startMs;

    // Persist to message_classifications
    try {
      await this.db.query(
        `INSERT INTO message_classifications
           (organization_id, conversation_key, message_id, execution_id,
            sentiment, sentiment_confidence, intent, intent_confidence,
            topics, urgency, model_used, processing_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          context.organizationId,
          context.conversationKey,
          context.messageId ?? null,
          context.executionId,
          classification.sentiment,
          classification.sentimentConfidence,
          classification.intent,
          classification.intentConfidence,
          classification.topics,
          classification.urgency,
          modelUsed,
          processingMs,
        ],
      );
    } catch (err) {
      // Non-fatal: log but do not fail the pipeline
      context.logger.error({ err }, "MessageAnalyzerAgent: failed to persist classification");
    }

    return {
      success: true,
      output: classification,
      modelUsed,
      processingMs,
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
