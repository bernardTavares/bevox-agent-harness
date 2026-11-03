import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { setupInfra, applyMigrations } from "../helpers/integration-setup.js";
import {
  PermissionAuditLogger,
  setPermissionAuditLogger,
  emitPermissionAudit,
} from "../../src/security/audit.js";
import { buildMcpPermissionContext } from "../../src/mcp/execution-context.js";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("permission_audit (integration)", () => {
  let teardown: () => Promise<void>;
  let pool: Pool;

  beforeAll(async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "harness-empty-migrations-"));
    const infra = await setupInfra({ migrationsDir: emptyDir });
    teardown = infra.teardown;
    pool = new Pool({ connectionString: infra.databaseUrl });
    await pool.query(`
      CREATE TABLE accounts (id SERIAL PRIMARY KEY, name TEXT);
      INSERT INTO accounts (id, name) VALUES (1, 'test');
    `);
    await applyMigrations(infra.databaseUrl, join(__dirname, "..", "..", "migrations"));
  }, 120_000);

  afterAll(async () => {
    setPermissionAuditLogger(null);
    if (pool) await pool.end();
    if (teardown) await teardown();
  }, 60_000);

  it("PermissionAuditLogger.log writes a row to permission_audit", async () => {
    const auditLogger = new PermissionAuditLogger(pool);
    await auditLogger.log({
      executionId: "11111111-1111-4111-8111-111111111111",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      agentName: "scheduler",
      toolName: "create-appointment",
      decision: "deny",
      reason: "AGENT_STATIC_DENIED",
      layer: "agent_static",
    });
    const result = await pool.query(
      `SELECT * FROM permission_audit WHERE execution_id = '11111111-1111-4111-8111-111111111111'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].tool_name).toBe("create-appointment");
    expect(result.rows[0].decision).toBe("deny");
  });

  it("emitPermissionAudit (fire-and-forget) persists when wired via setPermissionAuditLogger", async () => {
    setPermissionAuditLogger(new PermissionAuditLogger(pool));
    emitPermissionAudit({
      executionId: "22222222-2222-4222-8222-222222222222",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      agentName: "scheduler",
      toolName: "send-message",
      decision: "allow",
      layer: "allow",
    });
    // Wait briefly for the fire-and-forget insert
    await new Promise((r) => setTimeout(r, 100));
    const result = await pool.query(
      `SELECT * FROM permission_audit WHERE execution_id = '22222222-2222-4222-8222-222222222222'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].decision).toBe("allow");
    expect(result.rows[0].layer).toBe("allow");
  });

  // -------------------------------------------------------------------------
  // PERM-02 regression: synthetic mcp-<uuid> executionId must persist now
  // that the column is TEXT. Pre-fix, this INSERT silently dropped with
  // `22P02 invalid input syntax for type uuid`.
  // -------------------------------------------------------------------------
  it("PERM-02: persists a row with synthetic mcp-<uuid> executionId from buildMcpPermissionContext", async () => {
    const auditLogger = new PermissionAuditLogger(pool);
    const ctx = buildMcpPermissionContext({
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    });
    expect(ctx.executionId).toMatch(/^mcp-/);

    await auditLogger.log({
      executionId: ctx.executionId,
      organizationId: ctx.organizationId,
      agentName: ctx.agentName,
      toolName: "echo",
      decision: "allow",
      layer: "allow",
    });

    const result = await pool.query(
      `SELECT execution_id, decision, layer
         FROM permission_audit
        WHERE execution_id = $1`,
      [ctx.executionId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].execution_id).toBe(ctx.executionId);
    expect(result.rows[0].execution_id).toMatch(/^mcp-/);
    expect(result.rows[0].decision).toBe("allow");
  });
});
