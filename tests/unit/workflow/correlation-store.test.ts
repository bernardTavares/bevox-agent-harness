/**
 * Tests for correlation-store.ts
 *
 * Verifies:
 * - REPLY_RESUMABLE constant (L4 — SQL↔TS drift prevention)
 * - upsertSuspended / markRunning / markTerminal call the pool with correct SQL params
 * - resolveActive: null on 0 rows, row on 1, deterministic + ambiguity alarm on N > 1
 * - resolveActive never throws on DB error (returns null)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REPLY_RESUMABLE,
  CorrelationStore,
} from "../../../src/workflow/correlation-store.js";

// ---------------------------------------------------------------------------
// L4: REPLY_RESUMABLE constant — must match migration 009 partial-unique literal
// ---------------------------------------------------------------------------

describe("REPLY_RESUMABLE constant", () => {
  it('equals exactly ["reply:inbound"] — must stay in sync with migration 009 partial-unique predicate', () => {
    // Explicit value assertion: SQL↔TS drift is caught here.
    expect(REPLY_RESUMABLE).toEqual(["reply:inbound"]);
    expect(REPLY_RESUMABLE[0]).toBe("reply:inbound");
    expect(REPLY_RESUMABLE).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(queryResponse: { rows: unknown[]; rowCount?: number } = { rows: [], rowCount: 0 }) {
  return {
    query: vi.fn().mockResolvedValue({ rows: queryResponse.rows, rowCount: queryResponse.rowCount ?? queryResponse.rows.length }),
  };
}

// ---------------------------------------------------------------------------
// upsertSuspended
// ---------------------------------------------------------------------------

describe("CorrelationStore.upsertSuspended", () => {
  it("calls pool.query with correct params", async () => {
    const pool = makePool();
    const store = new CorrelationStore(pool as never);

    await store.upsertSuspended({
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactKey: "c-1",
      workflowExecutionId: "wf-1",
      suspendToken: "tok-1",
      resumeEvent: "reply:inbound",
      workflowVersion: 3,
    });

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO workflow_correlation/i);
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(params).toContain("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");  // organizationId
    expect(params).toContain("c-1");       // contactKey
    expect(params).toContain("wf-1");      // workflowExecutionId
    expect(params).toContain("tok-1");     // suspendToken
    expect(params).toContain("reply:inbound"); // resumeEvent
    expect(params).toContain(3);           // workflowVersion
  });
});

// ---------------------------------------------------------------------------
// markRunning
// ---------------------------------------------------------------------------

describe("CorrelationStore.markRunning", () => {
  it("calls pool.query with UPDATE setting status=running", async () => {
    const pool = makePool();
    const store = new CorrelationStore(pool as never);

    await store.markRunning("wf-1");

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE workflow_correlation/i);
    expect(sql).toMatch(/running/i);
    expect(params).toContain("wf-1");
  });
});

// ---------------------------------------------------------------------------
// markTerminal
// ---------------------------------------------------------------------------

describe("CorrelationStore.markTerminal", () => {
  it("calls pool.query with UPDATE setting status=completed", async () => {
    const pool = makePool();
    const store = new CorrelationStore(pool as never);

    await store.markTerminal("wf-1", "completed");

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE workflow_correlation/i);
    expect(params).toContain("wf-1");
    expect(params).toContain("completed");
  });

  it("calls pool.query with UPDATE setting status=failed", async () => {
    const pool = makePool();
    const store = new CorrelationStore(pool as never);

    await store.markTerminal("wf-2", "failed");

    const [, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(params).toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// resolveActive
// ---------------------------------------------------------------------------

describe("CorrelationStore.resolveActive", () => {
  it("returns null when 0 rows returned from DB", async () => {
    const pool = makePool({ rows: [], rowCount: 0 });
    const store = new CorrelationStore(pool as never);

    const result = await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", "c-1");

    expect(result).toBeNull();
  });

  it("returns the single row when exactly 1 match", async () => {
    const pool = makePool({
      rows: [
        {
          workflow_execution_id: "wf-1",
          organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          contact_key: "c-1",
          suspend_token: "tok-1",
          resume_event: "reply:inbound",
          status: "suspended",
          updated_at: new Date("2024-01-01"),
          workflow_version: 1,
        },
      ],
    });
    const store = new CorrelationStore(pool as never);

    const result = await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", "c-1");

    expect(result).not.toBeNull();
    expect(result!.workflowExecutionId).toBe("wf-1");
    expect(result!.organizationId).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
    expect(result!.contactKey).toBe("c-1");
    expect(result!.suspendToken).toBe("tok-1");
    expect(result!.resumeEvent).toBe("reply:inbound");
    expect(result!.status).toBe("suspended");
    expect(result!.workflowVersion).toBe(1);
  });

  it("queries with REPLY_RESUMABLE as the event filter param", async () => {
    const pool = makePool({ rows: [] });
    const store = new CorrelationStore(pool as never);

    await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8c", "c-99");

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT/i);
    expect(sql).toMatch(/workflow_correlation/i);
    expect(params).toContain("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8c");
    expect(params).toContain("c-99");
    // REPLY_RESUMABLE must appear in the query params (L4 contract)
    expect(params).toContainEqual(REPLY_RESUMABLE);
  });

  it("returns deterministic pick (first row from SQL ORDER BY) when N > 1", async () => {
    // The store trusts the DB ORDER BY (workflow_version DESC, updated_at DESC, id DESC)
    // and picks rows[0]. We supply rows already sorted — the determinism is in the SQL.
    const pool = makePool({
      rows: [
        {
          workflow_execution_id: "wf-bbb",
          organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          contact_key: "c-1",
          suspend_token: "tok-b",
          resume_event: "reply:inbound",
          status: "suspended",
          updated_at: new Date("2024-01-03"),
          workflow_version: 3,
        },
        {
          workflow_execution_id: "wf-ccc",
          organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          contact_key: "c-1",
          suspend_token: "tok-c",
          resume_event: "reply:inbound",
          status: "suspended",
          updated_at: new Date("2024-01-02"),
          workflow_version: 2,
        },
        {
          workflow_execution_id: "wf-aaa",
          organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          contact_key: "c-1",
          suspend_token: "tok-a",
          resume_event: "reply:inbound",
          status: "suspended",
          updated_at: new Date("2024-01-01"),
          workflow_version: 1,
        },
      ],
    });
    const store = new CorrelationStore(pool as never);

    const result = await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", "c-1");

    // Must pick first row — highest workflow_version=3 → wf-bbb
    expect(result).not.toBeNull();
    expect(result!.workflowExecutionId).toBe("wf-bbb");
  });

  it("fires ambiguity alarm when N > 1 rows returned", async () => {
    const pool = makePool({
      rows: [
        {
          workflow_execution_id: "wf-x",
          organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          contact_key: "c-1",
          suspend_token: "tok-x",
          resume_event: "reply:inbound",
          status: "suspended",
          updated_at: new Date(),
          workflow_version: 1,
        },
        {
          workflow_execution_id: "wf-y",
          organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          contact_key: "c-1",
          suspend_token: "tok-y",
          resume_event: "reply:inbound",
          status: "suspended",
          updated_at: new Date(),
          workflow_version: 1,
        },
      ],
    });
    const store = new CorrelationStore(pool as never);

    const warnSpy = vi.fn();
    store._testOnlySetAlarmFn(warnSpy);

    await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", "c-1");

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-1", count: 2 }),
      expect.stringContaining("ambiguity"),
    );
  });

  it("does NOT fire ambiguity alarm when exactly 1 row returned", async () => {
    const pool = makePool({
      rows: [
        {
          workflow_execution_id: "wf-1",
          organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          contact_key: "c-1",
          suspend_token: "tok-1",
          resume_event: "reply:inbound",
          status: "suspended",
          updated_at: new Date(),
          workflow_version: 1,
        },
      ],
    });
    const store = new CorrelationStore(pool as never);

    const warnSpy = vi.fn();
    store._testOnlySetAlarmFn(warnSpy);

    await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", "c-1");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("never throws on DB error — returns null (never-throws contract)", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("DB down")) };
    const store = new CorrelationStore(pool as never);

    const result = await store.resolveActive("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", "c-1");

    expect(result).toBeNull();
  });
});
