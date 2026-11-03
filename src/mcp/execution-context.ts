import { randomUUID } from "node:crypto";

import type { PermissionContext } from "../permissions/types.js";

/**
 * Build a `PermissionContext` for a single MCP tool invocation.
 *
 * MCP calls do not originate from a Bevox execution dispatch, so there is no
 * `executionToken` to flow back to callbacks. We still build a structurally
 * valid `PermissionContext` so the existing 3-layer `evaluatePermission`
 * works unchanged — its audit row will simply carry the synthetic
 * `mcp-<uuid>` executionId.
 *
 * NOTE: skills that depend on `AgentExecutionContext.db` / `.llmClient` /
 * Bevox `executionToken` will crash if invoked through MCP. Those are
 * filtered out at exposure time by {@link buildExternalAgentDefinition} and
 * by the `stop_signal` rule in `filterExposedSkills`.
 */
export function buildMcpPermissionContext(opts: {
  organizationId: string;
  inboxId?: number;
  unavailableTools?: string[];
  accountDeniedTools?: string[];
}): PermissionContext {
  const executionId = `mcp-${randomUUID()}`;
  return {
    executionId,
    agentName: "mcp-external",
    agentType: "surface",
    organizationId: opts.organizationId,
    inboxId: opts.inboxId,
    conversationKey: executionId,
    unavailableTools: opts.unavailableTools ?? [],
    accountDeniedTools: opts.accountDeniedTools ?? [],
  };
}
