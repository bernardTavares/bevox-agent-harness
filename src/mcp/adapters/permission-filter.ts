import micromatch from "micromatch";

import type { AgentDefinition } from "../../agents/types.js";
import { evaluatePermission } from "../../permissions/evaluator.js";
import type { PermissionContext, PermissionDenialReason } from "../../permissions/types.js";
import { skillToToolDefinition } from "../../tools/unified-registry.js";
import type { LoadedSkill } from "../../skills/skill-runtime.js";

import { mcpToolId } from "./skill-to-mcp.js";

/**
 * Filter which skills are EXPOSED via MCP at startup.
 *
 * Two-stage filtering:
 *   1. Skills with `sideEffects: ["stop_signal"]` (e.g. `send-message`,
 *      `request-human`) are unconditionally excluded — they depend on a Bevox
 *      `executionToken` for callbacks and cannot be invoked through an MCP
 *      external client.
 *   2. Whitelist glob match against the dotted id `${category}.${name}`,
 *      pulled from env `MCP_EXPOSED_SKILLS` (csv).
 *
 * Convention: the id used by globs is `${category}.${name}` — never the bare
 * manifest `name` — so categories can be opened with `calendar.*` without
 * listing every skill.
 *
 * Fail-closed: empty `patterns` ⇒ zero skills exposed. The operator must
 * explicitly opt-in to each surface area.
 */
export function filterExposedSkills(skills: LoadedSkill[], patterns: string[]): LoadedSkill[] {
  if (patterns.length === 0) return [];

  // Stage 1: drop skills whose side-effects make them un-exposable.
  const candidates = skills.filter(
    (s) => !s.manifest.permissions.sideEffects.includes("stop_signal"),
  );

  // Stage 2: glob whitelist on the dotted id.
  return candidates.filter((s) => micromatch.isMatch(mcpToolId(s), patterns));
}

/**
 * Synthetic AgentDefinition representing an external MCP caller.
 *
 * Built once per server instance and passed as the `agent` argument to the
 * existing `PermissionEvaluator`. We deny stop-signal and DB/LLM-coupled
 * skills by default to mirror the static filter above, plus any extra names
 * configured by the operator via `MCP_DENIED_SKILLS`.
 */
export function buildExternalAgentDefinition(extraDenied: string[] = []): AgentDefinition {
  // Skills that touch ctx.db / ctx.llmClient / executionToken cannot serve an
  // external MCP caller out-of-the-box. The default whitelist excludes them
  // statically; this list ensures the runtime evaluator also denies them
  // even if the operator opens a wider glob by mistake.
  const defaultDenied = new Set<string>([
    "send-message",
    "request-human",
    "write-fact",
    "write-profile",
    "read-profile",
    // calendar mutations require an account-scoped HTTP client; safe-by-default
    // we leave them in the *required* set rather than deny so operators can
    // opt them in explicitly when an MCP-friendly client is wired.
  ]);
  for (const name of extraDenied) {
    if (name) defaultDenied.add(name);
  }

  return {
    name: "mcp-external",
    type: "surface",
    description: "Synthetic agent representing an external Model Context Protocol caller.",
    reasoning: { default: "direct" },
    permissions: {
      required: [],
      denied: Array.from(defaultDenied),
    },
  };
}

export interface RuntimePermissionDecision {
  allowed: boolean;
  reason?: PermissionDenialReason;
}

/**
 * Runtime gate — reuses the existing 3-layer `evaluatePermission` so MCP
 * calls go through the same auditing as in-process tool invocations.
 */
export function isAllowedAtRuntime(
  skill: LoadedSkill,
  agent: AgentDefinition,
  context: PermissionContext,
): RuntimePermissionDecision {
  const tool = skillToToolDefinition(skill);
  const result = evaluatePermission(tool, agent, context);
  if (result.granted) return { allowed: true };
  return { allowed: false, reason: result.reason };
}
