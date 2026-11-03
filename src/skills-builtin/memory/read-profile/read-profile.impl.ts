import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { ContactFactsRepository } from "../../../memory/contact-facts.repository.js";
import { ContactProfileRepository } from "../../../memory/contact-profile.repository.js";
import type { ToolResult } from "../../../tools/types.js";

interface ReadProfileParams {
  contact_id: number;
}

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as ReadProfileParams;
  if (p.contact_id == null) {
    return { success: false, error: "INVALID_PARAMS", detail: "contact_id is required" };
  }
  try {
    const profileRepo = new ContactProfileRepository(context.db);
    const factsRepo = new ContactFactsRepository(context.db);
    const contactId = BigInt(p.contact_id);
    const [profile, facts] = await Promise.all([
      profileRepo.findByContact(context.organizationId, contactId),
      factsRepo.listActive(context.organizationId, contactId),
    ]);
    return { success: true, data: { profile, facts } };
  } catch (err) {
    return { success: false, error: "EXTERNAL_ERROR", detail: String(err) };
  }
}
