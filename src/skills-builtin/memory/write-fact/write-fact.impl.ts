import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { ContactFactsRepository } from "../../../memory/contact-facts.repository.js";
import type { ToolResult } from "../../../tools/types.js";

interface WriteFactParams {
  contact_id: number;
  fact_key: string;
  fact_value: string;
  category?: string;
  confidence: number;
}

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as WriteFactParams;
  if (p.contact_id == null || !p.fact_key || !p.fact_value || p.confidence == null) {
    return {
      success: false,
      error: "INVALID_PARAMS",
      detail: "contact_id, fact_key, fact_value, and confidence are required",
    };
  }

  if (p.confidence < 0.5) {
    return { success: true, data: { skipped: true, reason: "LOW_CONFIDENCE" } };
  }

  const confirmed = p.confidence >= 0.8;
  const contactId = BigInt(p.contact_id);
  const factsRepo = new ContactFactsRepository(context.db);

  const client = await context.db.connect();
  try {
    await client.query("BEGIN");
    const newFact = await factsRepo.upsertFact(
      {
        organizationId: context.organizationId,
        contactId,
        factKey: p.fact_key,
        factValue: p.fact_value,
        category: p.category,
        confidence: p.confidence,
        sourceConversationKey: context.conversationKey,
        sourceExecutionId: context.executionId,
      },
      client,
    );
    await client.query("COMMIT");
    return { success: true, data: { inserted: true, confirmed, factId: String(newFact.id) } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { success: false, error: "EXTERNAL_ERROR", detail: String(err) };
  } finally {
    client.release();
  }
}
