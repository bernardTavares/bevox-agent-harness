import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PermissionAuditLogger,
  setPermissionAuditLogger,
  emitPermissionAudit,
  getPermissionAuditFailureCount,
  resetPermissionAuditFailureCount,
} from "../../../src/security/audit.js";
import { evaluatePermission } from "../../../src/permissions/evaluator.js";
import { buildMcpPermissionContext } from "../../../src/mcp/execution-context.js";
import type { AgentDefinition } from "../../../src/agents/types.js";
import type { ToolDefinition } from "../../../src/tools/types.js";
import type { PermissionContext } from "../../../src/permissions/types.js";

function makePool(query: ReturnType<typeof vi.fn>): { query: typeof query } {
  return { query };
}

const baseAgent: AgentDefinition = {
  name: "scheduler",
  type: "surface",
  description: "test",
  reasoning: { default: "direct" },
  permissions: { required: [], denied: ["create-appointment"] },
} as unknown as AgentDefinition;

const baseTool: ToolDefinition = {
  name: "create-appointment",
  description: "t",
  category: "calendar",
  agentType: "surface",
  parameters: {},
  async execute() {
    return { success: true };
  },
};

const baseCtx: PermissionContext = {
  executionId: "00000000-0000-0000-0000-000000000001",
  agentName: "scheduler",
  agentType: "surface",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  conversationKey: "conv-1",
  unavailableTools: [],
  accountDeniedTools: [],
};

describe("PermissionAuditLogger", () => {
  beforeEach(() => {
    setPermissionAuditLogger(null);
  });

  it("writes a row with the parameterized columns", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = makePool(query);
    const auditor = new PermissionAuditLogger(pool as any);

    await auditor.log({
      executionId: "00000000-0000-0000-0000-000000000001",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      agentName: "scheduler",
      toolName: "send-message",
      decision: "deny",
      reason: "AGENT_STATIC_DENIED",
      layer: "agent_static",
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO permission_audit/);
    expect(params).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      "scheduler",
      "send-message",
      "deny",
      "AGENT_STATIC_DENIED",
      "agent_static",
    ]);
  });

  it("emitPermissionAudit is a no-op when no logger is wired", () => {
    setPermissionAuditLogger(null);
    expect(() =>
      emitPermissionAudit({
        executionId: "x",
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        agentName: "a",
        toolName: "t",
        decision: "deny",
        layer: "agent_static",
      }),
    ).not.toThrow();
  });

  it("evaluator emits an audit row on deny", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const auditor = new PermissionAuditLogger({ query } as any);
    setPermissionAuditLogger(auditor);

    const result = evaluatePermission(baseTool, baseAgent, baseCtx);
    expect(result.granted).toBe(false);

    // Audit is fire-and-forget — wait a tick.
    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO permission_audit/);
    expect(params[4]).toBe("deny");
    expect(params[6]).toBe("agent_static");
  });

  it("evaluator emits an audit row on allow", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    setPermissionAuditLogger(new PermissionAuditLogger({ query } as any));

    const allowAgent = {
      ...baseAgent,
      permissions: { required: [], denied: [] },
    } as AgentDefinition;
    const allowTool = { ...baseTool, name: "read-calendar" };
    const result = evaluatePermission(allowTool, allowAgent, baseCtx);
    expect(result.granted).toBe(true);

    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0][1];
    expect(params[4]).toBe("allow");
    expect(params[6]).toBe("allow");
  });

  // -------------------------------------------------------------------------
  // PERM-02 regression: MCP synthetic executionId must reach the INSERT.
  // -------------------------------------------------------------------------
  it("PERM-02: synthetic mcp-<uuid> executionId from buildMcpPermissionContext is passed through to the INSERT params", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    setPermissionAuditLogger(new PermissionAuditLogger({ query } as any));

    const mcpCtx = buildMcpPermissionContext({
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    });
    expect(mcpCtx.executionId).toMatch(/^mcp-[0-9a-f-]{36}$/);

    emitPermissionAudit({
      executionId: mcpCtx.executionId,
      organizationId: mcpCtx.organizationId,
      agentName: mcpCtx.agentName,
      toolName: "echo",
      decision: "allow",
      layer: "allow",
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0][1];
    expect(params[0]).toBe(mcpCtx.executionId);
    expect(params[0]).toMatch(/^mcp-/);
  });

  it("PERM-02: emit failure increments the dropped-row counter (audit completeness signal)", async () => {
    resetPermissionAuditFailureCount();
    const before = getPermissionAuditFailureCount();
    const query = vi.fn().mockRejectedValue(new Error("22P02 invalid input syntax for type uuid"));
    setPermissionAuditLogger(new PermissionAuditLogger({ query } as any));

    emitPermissionAudit({
      executionId: "mcp-018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      agentName: "mcp-external",
      toolName: "echo",
      decision: "allow",
      layer: "allow",
    });

    // Wait for fire-and-forget promise + the catch handler to run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(getPermissionAuditFailureCount()).toBe(before + 1);
    resetPermissionAuditFailureCount();
  });
});
