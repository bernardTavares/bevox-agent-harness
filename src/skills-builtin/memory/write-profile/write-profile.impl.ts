import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { ContactProfileRepository } from "../../../memory/contact-profile.repository.js";
import type { ToolResult } from "../../../tools/types.js";

interface WriteProfileParams {
  contact_id: number;
  fields: Record<string, unknown>;
}

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as WriteProfileParams;
  if (p.contact_id == null || !p.fields) {
    return { success: false, error: "INVALID_PARAMS", detail: "contact_id and fields are required" };
  }
  try {
    const profileRepo = new ContactProfileRepository(context.db);
    const contactId = BigInt(p.contact_id);
    await profileRepo.update(context.organizationId, contactId, p.fields);
    return { success: true, data: { updated: true } };
  } catch (err) {
    return { success: false, error: "EXTERNAL_ERROR", detail: String(err) };
  }
}
