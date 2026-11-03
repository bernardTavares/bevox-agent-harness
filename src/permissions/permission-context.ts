import type { AgentDefinition } from "../agents/types.js";
import type { ExecutionPayload } from "../runtime/execution-handler.js";

import type { PermissionContext } from "./types.js";

export interface PermissionContextBuilderOptions {
  agent: AgentDefinition;
  payload: ExecutionPayload;
  unavailableTools: string[];
  /**
   * Optional pre-computed account-denied tools list. When omitted, builder
   * derives it from `payload` via `deriveAccountDeniedTools` (which requires
   * `allKnownToolNames` to compute the complement of `payload.skills`).
   *
   * Prefer passing `allKnownToolNames` and letting the builder derive — the
   * `accountDeniedTools` escape hatch exists only for callers that have
   * already computed the list out-of-band (e.g. tests).
   */
  accountDeniedTools?: string[];
  /**
   * Full set of tool names registered in the runtime tool registry. Required
   * for `payload.skills` (whitelist) → `accountDeniedTools` (blacklist)
   * derivation. When omitted (and `accountDeniedTools` is also omitted), the
   * builder falls back to using only `payload.account_denied_tools` as the
   * Layer-2 denylist (no whitelist enforcement).
   */
  allKnownToolNames?: string[];
}

/**
 * PERM-05 (auditoria 2026-06-02): derive the Layer-2 `accountDeniedTools`
 * list from the inbound execution payload.
 *
 * Semantic model (clarified for PERM-05):
 *
 * - `payload.account_denied_tools` is an **explicit blacklist** (authoritative,
 *   used as-is). Tools listed here are always denied at Layer 2 regardless of
 *   the allowlist.
 *
 * - `payload.skills` is an **allowlist** of permitted tools. When non-empty,
 *   the complement (all registered tool names \ skills) is added to the
 *   denylist. When empty, no allowlist filter is applied (legacy behaviour:
 *   only the explicit blacklist applies).
 *
 * - The final list is the **union** of:
 *   1. `payload.account_denied_tools` (explicit deny), and
 *   2. `complement(allKnownToolNames, payload.skills)` when both are non-empty.
 *
 * - Deduplicated (stable order: explicit-deny first, then complement).
 *
 * If `allKnownToolNames` is omitted or empty, only the explicit blacklist
 * applies — this is the safe degradation path when the registry is not yet
 * available at the call site.
 */
export function deriveAccountDeniedTools(
  payload: ExecutionPayload,
  allKnownToolNames?: string[],
): string[] {
  const payloadDenied = (payload as { account_denied_tools?: unknown }).account_denied_tools;
  const explicitDeny: string[] = Array.isArray(payloadDenied)
    ? (payloadDenied as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const allow: string[] = Array.isArray(payload.skills) ? payload.skills : [];

  // Fast paths
  if (allow.length === 0) {
    // No allowlist → only explicit denylist applies (deduplicated).
    return Array.from(new Set(explicitDeny));
  }
  if (!allKnownToolNames || allKnownToolNames.length === 0) {
    // Allowlist present but no registry to compute complement → fall back to
    // explicit denylist only. Caller is responsible for warning in this case;
    // PERM-05 chose safe degradation over hard failure to avoid breaking the
    // execution path when registry wiring is incomplete (e.g. early bootstrap
    // or test stubs).
    return Array.from(new Set(explicitDeny));
  }

  // Compute complement: all registered tools not in the allowlist.
  const allowSet = new Set(allow);
  const complement: string[] = [];
  for (const tool of allKnownToolNames) {
    if (!allowSet.has(tool)) {
      complement.push(tool);
    }
  }

  // Union: explicit deny first (stable), then complement (deduplicated).
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const t of explicitDeny) {
    if (!seen.has(t)) {
      seen.add(t);
      merged.push(t);
    }
  }
  for (const t of complement) {
    if (!seen.has(t)) {
      seen.add(t);
      merged.push(t);
    }
  }
  return merged;
}

export function buildPermissionContext(opts: PermissionContextBuilderOptions): PermissionContext {
  const organizationId = opts.payload.organization_id;
  const conversationKey =
    typeof opts.payload.conversation?.["id"] === "string"
      ? opts.payload.conversation["id"]
      : String(opts.payload.conversation?.["id"] ?? opts.payload.execution_id);
  const inboxId =
    typeof opts.payload.context?.["inbox_id"] === "number"
      ? opts.payload.context["inbox_id"]
      : undefined;

  // PERM-05: prefer caller-supplied accountDeniedTools (test escape hatch);
  // otherwise derive from payload + registry tool names. Both default to
  // an empty array, preserving legacy behaviour when neither input is given.
  const accountDeniedTools =
    opts.accountDeniedTools ?? deriveAccountDeniedTools(opts.payload, opts.allKnownToolNames);

  return {
    executionId: opts.payload.execution_id,
    agentName: opts.agent.name,
    agentType: opts.agent.type,
    organizationId,
    inboxId,
    conversationKey,
    unavailableTools: opts.unavailableTools,
    accountDeniedTools,
  };
}
