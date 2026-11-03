import { randomUUID } from "node:crypto";

import type {
  CreateInput,
  UpdatePatch,
  WorkflowStateRow,
  WorkflowStateStore,
} from "../../src/workflow/state-store.js";
import type { WorkflowState } from "../../src/workflow/types.js";

type Row = WorkflowStateRow;

/**
 * In-memory replacement for {@link WorkflowStateStore}. Implements the same
 * public surface so the workflow engine can be exercised without a live
 * Postgres instance.
 */
export class FakeWorkflowStore
  implements
    Pick<
      WorkflowStateStore,
      | "create"
      | "load"
      | "loadBySuspendToken"
      | "update"
      | "listExpired"
      | "listSuspended"
      | "listActiveVersions"
      | "claimForResume"
      | "claimForExpiry"
    >
{
  readonly rows = new Map<string, Row>();

  async create(input: CreateInput): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    this.rows.set(id, {
      id,
      executionId: input.executionId,
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      organizationId: input.organizationId,
      status: input.status,
      state: input.state,
      currentStep: input.currentStep,
      suspendToken: input.suspendToken,
      suspendReason: input.suspendReason,
      resumeEvent: input.resumeEvent,
      resumePayload: input.resumePayload ?? null,
      timeoutAt: input.timeoutAt,
      createdAt: now,
      updatedAt: now,
      completedAt: input.completedAt ?? null,
      error: input.error ?? null,
      lockVersion: 0,
    });
    return id;
  }

  async load(id: string): Promise<Row | null> {
    return this.rows.get(id) ?? null;
  }

  async loadBySuspendToken(token: string, organizationId: string): Promise<Row | null> {
    for (const r of this.rows.values()) {
      if (r.suspendToken === token && r.organizationId === organizationId) return r;
    }
    return null;
  }

  async update(id: string, patch: UpdatePatch): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, {
      ...row,
      ...patch,
      lockVersion: row.lockVersion + 1,
      updatedAt: new Date(),
    } as Row);
  }

  /**
   * Conditional claim for resume — mirrors the real store's single atomic UPDATE.
   * Returns true only when status='suspended' AND suspend_token matches.
   * On success, writes the full transition patch atomically (no partial write on
   * lost race). Never mutates on a lost race.
   */
  async claimForResume(
    id: string,
    suspendToken: string,
    patch: { state: WorkflowState; resumePayload: unknown },
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "suspended" || row.suspendToken !== suspendToken) {
      return false;
    }
    this.rows.set(id, {
      ...row,
      status: "running",
      suspendToken: null,
      state: patch.state,
      resumePayload: patch.resumePayload ?? null,
      suspendReason: null,
      resumeEvent: null,
      timeoutAt: null,
      lockVersion: row.lockVersion + 1,
      updatedAt: new Date(),
    });
    return true;
  }

  /**
   * Conditional claim for expiry — mirrors the real store's guarded UPDATE.
   * Returns true only when status='suspended' AND timeout_at is non-null AND <= now.
   */
  async claimForExpiry(
    id: string,
    error: unknown = { reason: "timeout" },
  ): Promise<boolean> {
    const row = this.rows.get(id);
    const now = Date.now();
    if (
      !row ||
      row.status !== "suspended" ||
      row.timeoutAt === null ||
      row.timeoutAt.getTime() > now
    ) {
      return false;
    }
    this.rows.set(id, {
      ...row,
      status: "failed",
      error,
      completedAt: new Date(),
      suspendToken: null,
      lockVersion: row.lockVersion + 1,
      updatedAt: new Date(),
    });
    return true;
  }

  async listExpired(now: Date, limit: number): Promise<Row[]> {
    const out: Row[] = [];
    for (const r of this.rows.values()) {
      if (r.status === "suspended" && r.timeoutAt && r.timeoutAt.getTime() <= now.getTime()) {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async listSuspended(organizationId: string): Promise<Row[]> {
    return [...this.rows.values()].filter(
      (r) => r.organizationId === organizationId && r.status === "suspended",
    );
  }

  async listActiveVersions(workflowId: string): Promise<number[]> {
    const set = new Set<number>();
    for (const r of this.rows.values()) {
      if (r.workflowId === workflowId && (r.status === "running" || r.status === "suspended")) {
        set.add(r.workflowVersion);
      }
    }
    return [...set];
  }
}
