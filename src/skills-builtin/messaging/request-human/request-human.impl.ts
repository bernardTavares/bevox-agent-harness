import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { checkRateLimit } from "../../../tools/_shared/rate-limit.js";
import type { ToolResult } from "../../../tools/types.js";

interface RequestHumanParams {
  reason: string;
  team_id?: number;
}

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as RequestHumanParams;
  if (!p.reason) {
    return { success: false, error: "INVALID_PARAMS", detail: "reason is required" };
  }
  const denied = await checkRateLimit(context.organizationId, "request-human", "request-human");
  if (denied) return denied;
  return {
    success: true,
    data: { handoff: true, reason: p.reason, team_id: p.team_id ?? null },
  };
}
