import type { Pool } from "pg";

import { migrateState, type WorkflowState, type WorkflowStatus } from "./types.js";

/**
 * Row shape returned by the store. `state` is always validated via Zod
 * before being handed back to callers (resume must never operate on an
 * unknown shape).
 */
export interface WorkflowStateRow {
  id: string;
  executionId: string;
  workflowId: string;
  workflowVersion: number;
  organizationId: string;
  status: WorkflowStatus;
  state: WorkflowState;
  currentStep: string | null;
  suspendToken: string | null;
  suspendReason: string | null;
  resumeEvent: string | null;
  resumePayload: unknown;
  timeoutAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  error: unknown;
  lockVersion: number;
}

export type CreateInput = Omit<
  WorkflowStateRow,
  "id" | "createdAt" | "updatedAt" | "completedAt" | "lockVersion"
> & {
  completedAt?: Date | null;
};

export type UpdatePatch = Partial<
  Pick<
    WorkflowStateRow,
    | "status"
    | "state"
    | "currentStep"
    | "suspendToken"
    | "suspendReason"
    | "resumeEvent"
    | "resumePayload"
    | "timeoutAt"
    | "completedAt"
    | "error"
  >
>;

/**
 * Persistence for `workflow_executions`. All JSONB columns are serialised
 * here; callers pass plain JS objects/values.
 */
export class WorkflowStateStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateInput): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO workflow_executions (
         execution_id, workflow_id, workflow_version, organization_id, status,
         state, current_step, suspend_token, suspend_reason, resume_event,
         resume_payload, timeout_at, completed_at, error
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        input.executionId,
        input.workflowId,
        input.workflowVersion,
        input.organizationId,
        input.status,
        JSON.stringify(input.state),
        input.currentStep,
        input.suspendToken,
        input.suspendReason,
        input.resumeEvent,
        input.resumePayload === undefined ? null : JSON.stringify(input.resumePayload),
        input.timeoutAt,
        input.completedAt ?? null,
        input.error === undefined ? null : JSON.stringify(input.error),
      ],
    );
    return rows[0]!.id;
  }

  async load(id: string): Promise<WorkflowStateRow | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM workflow_executions WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows.length === 0 ? null : this.rowToModel(rows[0]);
  }

  /**
   * Lookup by suspend token. `organizationId` is REQUIRED to prevent token
   * enumeration across organizations (correção pós-review).
   */
  async loadBySuspendToken(
    token: string,
    organizationId: string,
  ): Promise<WorkflowStateRow | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM workflow_executions
       WHERE suspend_token = $1 AND organization_id = $2
       LIMIT 1`,
      [token, organizationId],
    );
    return rows.length === 0 ? null : this.rowToModel(rows[0]);
  }

  async update(id: string, patch: UpdatePatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, value: unknown, serialise = false) => {
      sets.push(`${col} = $${i++}`);
      params.push(serialise && value !== null ? JSON.stringify(value) : value);
    };

    if (patch.status !== undefined) push("status", patch.status);
    if (patch.state !== undefined) push("state", patch.state, true);
    if (patch.currentStep !== undefined) push("current_step", patch.currentStep);
    if (patch.suspendToken !== undefined) push("suspend_token", patch.suspendToken);
    if (patch.suspendReason !== undefined) push("suspend_reason", patch.suspendReason);
    if (patch.resumeEvent !== undefined) push("resume_event", patch.resumeEvent);
    if (patch.resumePayload !== undefined) push("resume_payload", patch.resumePayload, true);
    if (patch.timeoutAt !== undefined) push("timeout_at", patch.timeoutAt);
    if (patch.completedAt !== undefined) push("completed_at", patch.completedAt);
    if (patch.error !== undefined) push("error", patch.error, true);

    sets.push(`lock_version = lock_version + 1`);
    sets.push(`updated_at = NOW()`);
    params.push(id);

    if (sets.length === 2) return; // only lock_version + updated_at — nothing to do

    await this.pool.query(
      `UPDATE workflow_executions SET ${sets.join(", ")} WHERE id = $${i}`,
      params,
    );
  }

  async listExpired(now: Date, limit: number): Promise<WorkflowStateRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM workflow_executions
       WHERE status = 'suspended' AND timeout_at IS NOT NULL AND timeout_at <= $1
       ORDER BY timeout_at ASC
       LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => this.rowToModel(r));
  }

  async listSuspended(organizationId: string, limit = 50): Promise<WorkflowStateRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM workflow_executions
       WHERE organization_id = $1 AND status = 'suspended'
       ORDER BY updated_at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
    return rows.map((r) => this.rowToModel(r));
  }

  /**
   * Active versions still referenced by running/suspended executions.
   * Used by the registry to decide which versions can be deprecated.
   */
  async listActiveVersions(workflowId: string): Promise<number[]> {
    const { rows } = await this.pool.query<{ workflow_version: number }>(
      `SELECT DISTINCT workflow_version
       FROM workflow_executions
       WHERE workflow_id = $1 AND status IN ('running','suspended')`,
      [workflowId],
    );
    return rows.map((r) => r.workflow_version);
  }

  /**
   * Optimistic-concurrency claim for resume.
   *
   * Atomically transitions `status='suspended' AND suspend_token=$token` →
   * `status='running'` and writes the full transition patch (state, resumePayload,
   * clears suspend_reason/resume_event/timeout_at) in a single UPDATE statement,
   * eliminating the torn-write window that existed when these were two separate calls.
   *
   * Returns `true` when the row was claimed, `false` when the predicate did not match
   * (another worker already claimed it — lost the race). Never throws on a lost race.
   */
  async claimForResume(
    id: string,
    suspendToken: string,
    patch: { state: WorkflowState; resumePayload: unknown },
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE workflow_executions
       SET status = 'running',
           suspend_token = NULL,
           lock_version = lock_version + 1,
           state = $3,
           suspend_reason = NULL,
           resume_event = NULL,
           timeout_at = NULL,
           resume_payload = $4,
           updated_at = NOW()
       WHERE id = $1
         AND status = 'suspended'
         AND suspend_token = $2
       RETURNING id`,
      [
        id,
        suspendToken,
        JSON.stringify(patch.state),
        patch.resumePayload === undefined ? null : JSON.stringify(patch.resumePayload),
      ],
    );
    return (rowCount ?? 0) === 1;
  }

  /**
   * Optimistic-concurrency claim for expiry.
   *
   * Atomically transitions `status='suspended' AND timeout_at <= NOW()` → `status='failed'`
   * and bumps `lock_version`. Returns `true` when claimed, `false` when the predicate did
   * not match (the row was already resumed — must NOT clobber). Never throws on a lost race.
   */
  async claimForExpiry(id: string, error: unknown = { reason: "timeout" }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE workflow_executions
       SET status = 'failed',
           error = $2,
           completed_at = NOW(),
           suspend_token = NULL,
           lock_version = lock_version + 1,
           updated_at = NOW()
       WHERE id = $1
         AND status = 'suspended'
         AND timeout_at IS NOT NULL
         AND timeout_at <= NOW()
       RETURNING id`,
      [id, JSON.stringify(error)],
    );
    return (rowCount ?? 0) === 1;
  }

  private rowToModel(r: Record<string, unknown>): WorkflowStateRow {
    return {
      id: r["id"] as string,
      executionId: r["execution_id"] as string,
      workflowId: r["workflow_id"] as string,
      workflowVersion: r["workflow_version"] as number,
      organizationId: r["organization_id"] as string,
      status: r["status"] as WorkflowStatus,
      // pg returns JSONB pre-parsed when types are properly registered.
      state: migrateState(r["state"]),
      currentStep: (r["current_step"] as string | null) ?? null,
      suspendToken: (r["suspend_token"] as string | null) ?? null,
      suspendReason: (r["suspend_reason"] as string | null) ?? null,
      resumeEvent: (r["resume_event"] as string | null) ?? null,
      resumePayload: r["resume_payload"] ?? null,
      timeoutAt: (r["timeout_at"] as Date | null) ?? null,
      createdAt: r["created_at"] as Date,
      updatedAt: r["updated_at"] as Date,
      completedAt: (r["completed_at"] as Date | null) ?? null,
      error: r["error"] ?? null,
      lockVersion: Number(r["lock_version"] ?? 0),
    };
  }
}
