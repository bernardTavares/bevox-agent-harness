import type { Pool } from "pg";

import { createLogger } from "../config/logger.js";

const logger = createLogger({ name: "execution-audit" });

/**
 * Action types captured by the execution audit trail. Mirrors the
 * `action_type` CHECK constraint in migration `013_execution_audit_extension.sql`.
 *
 * - `escalation` — surface agent handed off to a human (`request-human`)
 *   or sent a terminal `send-message` STOP signal. Captures who/when/why.
 * - `mutation_execution` — a side-effect tool was actually invoked
 *   (create-appointment, cancel-appointment, reschedule-appointment,
 *   waitlist-add, send-message). Captures parameters (sanitized) + result.
 *
 * `filter_evaluation` rows are written by {@link PermissionAuditLogger}; this
 * module never emits them.
 */
export type ExecutionAuditActionType =
  | "escalation"
  | "mutation_execution"
  | "proposal";

export type ExecutionAuditResult =
  | "success"
  | "failure"
  | "pending_approval"
  | "proposed";

export interface ExecutionAuditEntry {
  executionId: string;
  organizationId: string;
  agentName: string;
  /** Logical tool name (e.g. `create-appointment`) or escalation kind. */
  toolName: string;
  actionType: ExecutionAuditActionType;
  /**
   * Structured context payload. Callers MUST sanitize PII before passing
   * (phone numbers, message bodies, etc.). Keep small — this is JSONB
   * indexed by query, not a blob store.
   */
  actionDetails?: Record<string, unknown>;
  result?: ExecutionAuditResult;
  errorMessage?: string;
}

/**
 * PERM-03 (audit ref: runtime-gap-audit-2026-06-02). Persists sensitive
 * runtime actions — escalations and mutation executions — to the
 * `permission_audit` table extended by migration `013_execution_audit_extension.sql`.
 *
 * Same fire-and-forget contract as {@link PermissionAuditLogger}: failures
 * are logged at WARN but never block the runtime hot path.
 *
 * Migration `013_execution_audit_extension.sql` MUST be applied before
 * instantiating; otherwise INSERTs will fail at the `action_type` CHECK.
 */
export class ExecutionAuditLogger {
  constructor(private readonly pool: Pool) {}

  async log(entry: ExecutionAuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO permission_audit
        (execution_id, organization_id, agent_name, tool_name,
         action_type, action_details, result, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.executionId,
        entry.organizationId,
        entry.agentName,
        entry.toolName,
        entry.actionType,
        entry.actionDetails ? JSON.stringify(entry.actionDetails) : null,
        entry.result ?? null,
        entry.errorMessage ?? null,
      ],
    );
  }
}

// -----------------------------------------------------------------------------
// Module-level singleton wiring (mirrors PermissionAuditLogger so synchronous
// runtime call sites can emit without threading a logger through every layer).
// -----------------------------------------------------------------------------

let _instance: ExecutionAuditLogger | null = null;

export function setExecutionAuditLogger(logger: ExecutionAuditLogger | null): void {
  _instance = logger;
}

export function getExecutionAuditLogger(): ExecutionAuditLogger | null {
  return _instance;
}

/**
 * Fire-and-forget audit emit. Safe to call from synchronous contexts.
 *
 * When no logger is wired (e.g. unit tests, bootstrap not run), this is a
 * no-op — the runtime is never blocked by missing audit infrastructure.
 */
export function emitExecutionAudit(entry: ExecutionAuditEntry): void {
  const inst = _instance;
  if (!inst) return;
  inst.log(entry).catch((err) => {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        entry: {
          executionId: entry.executionId,
          organizationId: entry.organizationId,
          agentName: entry.agentName,
          toolName: entry.toolName,
          actionType: entry.actionType,
        },
      },
      "execution_audit_failed",
    );
  });
}

// -----------------------------------------------------------------------------
// Sanitization helpers — PERM-03 POC keeps these intentionally simple. A full
// PII redactor lives in `src/security/redactors.ts` for the LLM transcript
// path; mutation audit details are a different shape (structured params), so
// we apply targeted truncation here rather than reusing the transcript
// redactor wholesale.
// -----------------------------------------------------------------------------

const MAX_AUDIT_STRING_LENGTH = 256;

/**
 * Shallow-sanitize a structured params/details payload for audit storage.
 *
 * - Truncates string values longer than {@link MAX_AUDIT_STRING_LENGTH}.
 * - Leaves numbers/booleans/null intact.
 * - Recursively sanitizes one level of nested objects (no deep recursion to
 *   avoid pathological inputs blowing the audit write).
 *
 * NOT a full PII redactor. Callers MUST avoid placing raw phone numbers,
 * full message bodies, or document numbers into `actionDetails`. Use this
 * to bound size for fields you do choose to include.
 */
export function sanitizeAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = sanitizeValue(value, 0);
  }
  return out;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    if (value.length > MAX_AUDIT_STRING_LENGTH) {
      return value.slice(0, MAX_AUDIT_STRING_LENGTH) + "…[truncated]";
    }
    return value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => sanitizeValue(v, depth + 1));
  }
  if (depth >= 1) {
    // Don't recurse deeper than one level — avoids pathological nesting.
    return "[object]";
  }
  const nested: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    nested[k] = sanitizeValue(v, depth + 1);
  }
  return nested;
}
