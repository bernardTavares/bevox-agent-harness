import type { Pool } from "pg";

import { createLogger } from "../config/logger.js";

const logger = createLogger({ name: "permission-audit" });

export type AuditLayer = "agent_static" | "execution_context" | "allow";

export interface PermissionAuditEntry {
  executionId: string;
  organizationId: string;
  agentName: string;
  toolName: string;
  decision: "allow" | "deny";
  reason?: string;
  layer: AuditLayer;
}

/**
 * Persists permission decisions to `permission_audit`. All writes are
 * fire-and-forget — failures are logged at ERROR and accumulated in a
 * process-local counter (see {@link getPermissionAuditFailureCount}) so
 * dropped audit rows are visible in logs and exposable as a metric. The
 * write itself never blocks the synchronous permission evaluator that
 * calls this.
 *
 * Migration `002_permission_audit.sql` MUST be applied before instantiating.
 * Migration `013_permission_audit_execution_id_text.sql` is required for
 * MCP tool invocations whose synthetic `mcp-<uuid>` executionId would
 * otherwise be rejected by the legacy UUID column type.
 */
export class PermissionAuditLogger {
  constructor(private readonly pool: Pool) {}

  async log(entry: PermissionAuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO permission_audit
        (execution_id, organization_id, agent_name, tool_name, decision, reason, layer)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.executionId,
        entry.organizationId,
        entry.agentName,
        entry.toolName,
        entry.decision,
        entry.reason ?? null,
        entry.layer,
      ],
    );
  }
}

// -----------------------------------------------------------------------------
// Module-level singleton wiring (so the synchronous evaluator stays sync).
// -----------------------------------------------------------------------------

let _instance: PermissionAuditLogger | null = null;
let _failureCount = 0;

export function setPermissionAuditLogger(logger: PermissionAuditLogger | null): void {
  _instance = logger;
}

export function getPermissionAuditLogger(): PermissionAuditLogger | null {
  return _instance;
}

/**
 * Process-local counter of permission_audit INSERTs that failed (and were
 * therefore silently dropped). Exposed for metrics scraping and for
 * regression tests. Resettable via {@link resetPermissionAuditFailureCount}.
 */
export function getPermissionAuditFailureCount(): number {
  return _failureCount;
}

export function resetPermissionAuditFailureCount(): void {
  _failureCount = 0;
}

/**
 * Fire-and-forget audit emit. Safe to call from synchronous contexts.
 * Failures are logged at ERROR (audit completeness is a HIGH-severity
 * concern - finding PERM-02) and increment a process-local counter
 * (see {@link getPermissionAuditFailureCount}).
 */
export function emitPermissionAudit(entry: PermissionAuditEntry): void {
  const inst = _instance;
  if (!inst) return;
  inst.log(entry).catch((err) => {
    _failureCount += 1;
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        entry: { ...entry },
        failureCount: _failureCount,
      },
      "permission_audit_failed",
    );
  });
}
