/**
 * Correlation projection store (Fase C §5, CF1 deviation).
 *
 * Maintains the `workflow_correlation` table — the index that lets an inbound
 * prospect reply find the right suspended cadence execution.
 *
 * REPLY_RESUMABLE must stay in sync with migration 009 partial-unique literal
 * (L4 — SQL↔TS drift is caught by the constant assertion test).
 *
 * L7: ambiguity alarm routes via logger, NOT a new hook-bus event.
 */

import type { Pool } from "pg";
import { createLogger } from "../config/logger.js";

// ---------------------------------------------------------------------------
// L4: REPLY_RESUMABLE — must match 009_workflow_correlation.sql exactly.
//   The partial-unique index predicate uses: resume_event IN ('reply:inbound')
//   DO NOT change this without updating the migration and its index predicate.
// ---------------------------------------------------------------------------
export const REPLY_RESUMABLE = ["reply:inbound"] as const;
export type ReplyResumableEvent = (typeof REPLY_RESUMABLE)[number];

const logger = createLogger({ name: "correlation-store" });

export interface UpsertSuspendedInput {
  organizationId: string;
  contactKey: string;
  workflowExecutionId: string;
  suspendToken: string | null;
  resumeEvent: string;
  /** workflow_version from the execution row — used for deterministic tie-break */
  workflowVersion: number;
}

export interface CorrelationRow {
  workflowExecutionId: string;
  organizationId: string;
  contactKey: string;
  suspendToken: string | null;
  resumeEvent: string;
  status: string;
  updatedAt: Date;
  workflowVersion: number;
}

type AlarmFn = (data: Record<string, unknown>, message: string) => void;

/**
 * Projection store for `workflow_correlation`.
 *
 * All read operations (resolveActive) are never-throws — they return null on
 * any DB error. Write operations (upsertSuspended, markRunning, markTerminal)
 * are best-effort from the store perspective but do propagate DB errors to
 * callers (the hook handler catches them via the bus best-effort wrapper).
 */
export class CorrelationStore {
  private _alarmFn: AlarmFn = (data, message) => {
    logger.warn(data, message);
  };

  constructor(private readonly pool: Pool) {}

  /**
   * TEST SEAM: Override the ambiguity alarm function (for unit tests that
   * cannot easily spy on the logger singleton).
   */
  _testOnlySetAlarmFn(fn: AlarmFn): void {
    this._alarmFn = fn;
  }

  /**
   * Insert or update a correlation row when a workflow is suspended.
   * Uses workflow_execution_id as the natural key for upsert.
   */
  async upsertSuspended(input: UpsertSuspendedInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO workflow_correlation (
         organization_id, contact_key, workflow_execution_id,
         suspend_token, resume_event, status, workflow_version, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'suspended', $6, NOW())
       ON CONFLICT (workflow_execution_id)
       DO UPDATE SET
         suspend_token   = EXCLUDED.suspend_token,
         resume_event    = EXCLUDED.resume_event,
         status          = 'suspended',
         workflow_version = EXCLUDED.workflow_version,
         updated_at      = NOW()`,
      [
        input.organizationId,
        input.contactKey,
        input.workflowExecutionId,
        input.suspendToken,
        input.resumeEvent,
        input.workflowVersion,
      ],
    );
  }

  /**
   * Mark a correlation row as running (after a successful resume claim).
   */
  async markRunning(workflowExecutionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_correlation
          SET status = 'running', updated_at = NOW()
        WHERE workflow_execution_id = $1`,
      [workflowExecutionId],
    );
  }

  /**
   * Mark a correlation row as terminal (completed or failed).
   * After this, resolveActive will no longer return the row.
   */
  async markTerminal(workflowExecutionId: string, status: "completed" | "failed"): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_correlation
          SET status = $2, updated_at = NOW()
        WHERE workflow_execution_id = $1`,
      [workflowExecutionId, status],
    );
  }

  /**
   * Resolve the active (suspended + REPLY_RESUMABLE) correlation row for
   * a given (organizationId, contactKey) pair.
   *
   * - Returns null when 0 matches.
   * - Returns the single row when exactly 1 match.
   * - On N > 1 matches: fires the ambiguity alarm (L7 — logger.warn) and
   *   returns the DETERMINISTIC pick: max workflow_version → newest
   *   updated_at → lexicographic workflow_execution_id (DESC).
   * - Never throws on DB error — returns null instead.
   */
  async resolveActive(organizationId: string, contactKey: string): Promise<CorrelationRow | null> {
    try {
      const { rows } = await this.pool.query<{
        workflow_execution_id: string;
        organization_id: string;
        contact_key: string;
        suspend_token: string | null;
        resume_event: string;
        status: string;
        updated_at: Date;
        workflow_version: string | number;
      }>(
        `SELECT workflow_execution_id, organization_id, contact_key,
                suspend_token, resume_event, status, updated_at, workflow_version
           FROM workflow_correlation
          WHERE organization_id = $1
            AND contact_key = $2
            AND status = 'suspended'
            AND resume_event = ANY($3::text[])
          ORDER BY
            workflow_version DESC,
            updated_at DESC,
            workflow_execution_id DESC`,
        [organizationId, contactKey, REPLY_RESUMABLE],
      );

      if (rows.length === 0) return null;

      if (rows.length > 1) {
        // L7: ambiguity alarm — log via logger/observability, NOT a hook-bus event.
        this._alarmFn(
          {
            organizationId,
            contactKey,
            count: rows.length,
            ids: rows.map((r) => r.workflow_execution_id),
          },
          "correlation-store: ambiguity — multiple suspended REPLY_RESUMABLE rows for same organization+contact",
        );
      }

      const top = rows[0]!;
      return {
        workflowExecutionId: top.workflow_execution_id,
        organizationId: top.organization_id as string,
        contactKey: top.contact_key,
        suspendToken: top.suspend_token,
        resumeEvent: top.resume_event,
        status: top.status,
        updatedAt: top.updated_at instanceof Date ? top.updated_at : new Date(top.updated_at),
        workflowVersion: Number(top.workflow_version),
      };
    } catch {
      // Never throw on read error — zero-cost gate pattern (mirrors sdr-account-state.repository.ts)
      return null;
    }
  }
}
