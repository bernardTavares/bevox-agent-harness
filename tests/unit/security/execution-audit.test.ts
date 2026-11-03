import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  ExecutionAuditLogger,
  emitExecutionAudit,
  sanitizeAuditDetails,
  setExecutionAuditLogger,
  type ExecutionAuditEntry,
} from "../../../src/security/execution-audit.js";

function makePool(query: ReturnType<typeof vi.fn>): { query: typeof query } {
  return { query };
}

const baseEntry: ExecutionAuditEntry = {
  executionId: "00000000-0000-0000-0000-000000000001",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  agentName: "scheduler",
  toolName: "create-appointment",
  actionType: "mutation_execution",
  actionDetails: { tool_category: "calendar" },
  result: "success",
};

describe("ExecutionAuditLogger", () => {
  beforeEach(() => {
    setExecutionAuditLogger(null);
  });

  it("writes a row populating action_type and action_details JSONB", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const auditor = new ExecutionAuditLogger(makePool(query) as never);

    await auditor.log(baseEntry);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO permission_audit/);
    expect(sql).toMatch(/action_type/);
    expect(sql).toMatch(/action_details/);
    expect(params[0]).toBe(baseEntry.executionId);
    expect(params[1]).toBe(baseEntry.organizationId);
    expect(params[2]).toBe(baseEntry.agentName);
    expect(params[3]).toBe(baseEntry.toolName);
    expect(params[4]).toBe("mutation_execution");
    expect(JSON.parse(params[5] as string)).toEqual({ tool_category: "calendar" });
    expect(params[6]).toBe("success");
    expect(params[7]).toBeNull();
  });

  it("persists errorMessage on failure result", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const auditor = new ExecutionAuditLogger(makePool(query) as never);

    await auditor.log({
      ...baseEntry,
      result: "failure",
      errorMessage: "E_TOOL_BACKEND_5XX: upstream timeout",
    });

    const params = query.mock.calls[0][1];
    expect(params[6]).toBe("failure");
    expect(params[7]).toBe("E_TOOL_BACKEND_5XX: upstream timeout");
  });

  it("serializes null action_details when not provided", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const auditor = new ExecutionAuditLogger(makePool(query) as never);

    await auditor.log({
      executionId: baseEntry.executionId,
      organizationId: baseEntry.organizationId,
      agentName: "scheduler",
      toolName: "request-human",
      actionType: "escalation",
    });

    const params = query.mock.calls[0][1];
    expect(params[4]).toBe("escalation");
    expect(params[5]).toBeNull();
    expect(params[6]).toBeNull();
  });

  it("supports escalation action_type", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const auditor = new ExecutionAuditLogger(makePool(query) as never);

    await auditor.log({
      ...baseEntry,
      toolName: "request-human",
      actionType: "escalation",
      actionDetails: { escalation_reason: "no_surface_agent_available" },
      result: "pending_approval",
    });

    const params = query.mock.calls[0][1];
    expect(params[4]).toBe("escalation");
    expect(JSON.parse(params[5] as string)).toEqual({
      escalation_reason: "no_surface_agent_available",
    });
    expect(params[6]).toBe("pending_approval");
  });
});

describe("emitExecutionAudit (fire-and-forget)", () => {
  beforeEach(() => {
    setExecutionAuditLogger(null);
  });

  it("is a no-op when no logger is wired", () => {
    expect(() => emitExecutionAudit(baseEntry)).not.toThrow();
  });

  it("dispatches to the wired logger without awaiting", () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    setExecutionAuditLogger(new ExecutionAuditLogger(makePool(query) as never));

    // Should return synchronously (no await).
    const ret = emitExecutionAudit(baseEntry);
    expect(ret).toBeUndefined();
  });

  it("swallows logger failures so the runtime hot path is never blocked", async () => {
    const query = vi.fn().mockRejectedValue(new Error("db down"));
    setExecutionAuditLogger(new ExecutionAuditLogger(makePool(query) as never));

    // Must not reject — failure is caught and logged at WARN inside.
    emitExecutionAudit(baseEntry);

    // Wait a microtask tick so the rejected promise gets handled.
    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenCalledTimes(1);
    // No assertion needed on logger.warn — the behavior under test is the
    // absence of an unhandled rejection.
  });
});

describe("sanitizeAuditDetails", () => {
  it("truncates strings longer than the audit limit", () => {
    const longString = "a".repeat(300);
    const out = sanitizeAuditDetails({ message_body: longString });
    expect((out.message_body as string).length).toBeLessThan(longString.length);
    expect(out.message_body).toMatch(/\[truncated\]$/);
  });

  it("leaves short strings, numbers, booleans, and null untouched", () => {
    const out = sanitizeAuditDetails({
      tool: "create-appointment",
      duration_ms: 1234,
      success: true,
      maybe: null,
    });
    expect(out).toEqual({
      tool: "create-appointment",
      duration_ms: 1234,
      success: true,
      maybe: null,
    });
  });

  it("recurses one level into nested objects then collapses deeper structures", () => {
    const out = sanitizeAuditDetails({
      meta: {
        category: "calendar",
        nested: { too: "deep" },
      },
    });
    expect(out.meta).toEqual({
      category: "calendar",
      nested: "[object]",
    });
  });

  it("caps array length to bound JSONB row size", () => {
    const huge = Array.from({ length: 50 }, (_, i) => i);
    const out = sanitizeAuditDetails({ slots: huge });
    expect((out.slots as number[]).length).toBeLessThanOrEqual(20);
  });
});
