import type { AgentDefinition } from "../agents/types.js";
import { createLogger } from "../config/logger.js";
import { emitPermissionAudit, type AuditLayer } from "../security/audit.js";
import type { ToolDefinition } from "../tools/types.js";

import type { PermissionContext, PermissionDenialReason, PermissionResult } from "./types.js";

const logger = createLogger({ name: "permission-evaluator" });

function layerFromReason(reason: PermissionDenialReason): AuditLayer {
  if (reason === "AGENT_STATIC_DENIED" || reason === "AGENT_TYPE_MISMATCH") {
    return "agent_static";
  }
  return "execution_context";
}

function audit(
  result: PermissionResult,
  agent: AgentDefinition,
  tool: ToolDefinition,
  ctx: PermissionContext,
): void {
  emitPermissionAudit({
    executionId: ctx.executionId,
    organizationId: ctx.organizationId,
    agentName: agent.name,
    toolName: tool.name,
    decision: result.granted ? "allow" : "deny",
    reason: result.granted ? undefined : result.reason,
    layer: result.granted ? "allow" : layerFromReason(result.reason),
  });
}

// Hardcoded pipeline-only and surface-only tool names (Layer 3)
const PIPELINE_ONLY_TOOLS = new Set(["write-profile", "write-fact"]);
const SURFACE_ONLY_TOOLS = new Set(["send-message", "request-human"]);

export function evaluatePermission(
  tool: ToolDefinition,
  agent: AgentDefinition,
  context: PermissionContext,
): PermissionResult {
  const result = evaluateInner(tool, agent, context);
  // Fire-and-forget audit. Stays synchronous so existing callers don't need
  // to become async (Phase 3 INDEX correction).
  audit(result, agent, tool, context);
  return result;
}

function evaluateInner(
  tool: ToolDefinition,
  agent: AgentDefinition,
  context: PermissionContext,
): PermissionResult {
  // Layer 1 — Agent static definition
  if (agent.permissions.denied.includes(tool.name)) {
    logger.debug({ tool: tool.name, agent: agent.name }, "Permission denied: AGENT_STATIC_DENIED");
    return { granted: false, tool: tool.name, reason: "AGENT_STATIC_DENIED" };
  }
  if (PIPELINE_ONLY_TOOLS.has(tool.name) && agent.type === "surface") {
    logger.debug(
      { tool: tool.name, agent: agent.name },
      "Permission denied: AGENT_TYPE_MISMATCH (pipeline-only)",
    );
    return { granted: false, tool: tool.name, reason: "AGENT_TYPE_MISMATCH" };
  }
  if (SURFACE_ONLY_TOOLS.has(tool.name) && agent.type === "pipeline") {
    logger.debug(
      { tool: tool.name, agent: agent.name },
      "Permission denied: AGENT_TYPE_MISMATCH (surface-only)",
    );
    return { granted: false, tool: tool.name, reason: "AGENT_TYPE_MISMATCH" };
  }

  // Layer 2 — Execution context
  if (context.unavailableTools.includes(tool.name)) {
    logger.debug({ tool: tool.name }, "Permission denied: TOOL_UNAVAILABLE");
    return { granted: false, tool: tool.name, reason: "TOOL_UNAVAILABLE" };
  }
  if (context.accountDeniedTools.includes(tool.name)) {
    logger.debug(
      { tool: tool.name, organizationId: context.organizationId },
      "Permission denied: EXECUTION_CONTEXT_DENIED",
    );
    return { granted: false, tool: tool.name, reason: "EXECUTION_CONTEXT_DENIED" };
  }

  return { granted: true, tool: tool.name };
}

/**
 * Filters a list of tools down to those permitted for the agent in this context.
 * Also validates that all required tools are present (logs warning if not).
 */
export function filterPermittedTools(
  tools: ToolDefinition[],
  agent: AgentDefinition,
  context: PermissionContext,
): ToolDefinition[] {
  const permitted: ToolDefinition[] = [];
  for (const tool of tools) {
    const result = evaluatePermission(tool, agent, context);
    if (result.granted) {
      permitted.push(tool);
    }
  }

  // Warn if any required tool was filtered out
  for (const required of agent.permissions.required) {
    if (!permitted.find((t) => t.name === required)) {
      logger.warn({ agent: agent.name, tool: required }, "Required tool was denied for agent");
    }
  }

  return permitted;
}
