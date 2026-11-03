-- Migration: 013_permission_audit_execution_id_text
--
-- Re-types `permission_audit.execution_id` from UUID to TEXT to admit
-- synthetic ids generated for MCP tool invocations.
--
-- Context:
--   MCP tool calls do not originate from a Bevox execution dispatch token,
--   so `buildMcpPermissionContext()` (src/mcp/execution-context.ts) builds
--   a synthetic id of the form `mcp-<uuid>` to keep audit rows distinct
--   from regular harness executions. The legacy `UUID NOT NULL` schema
--   rejected these INSERTs and the PermissionAuditLogger silently
--   swallowed the failure, leaving MCP traffic completely unaudited.
--
-- This migration:
--   * Re-types the column to TEXT (UUID -> TEXT is a safe in-place cast in
--     Postgres: every UUID value renders to its canonical text form).
--   * Preserves NOT NULL.
--   * Preserves the three indexes (TEXT comparisons use the same btree).
--
-- Forward-compatibility:
--   * Migrations 002 and 011 are also updated to declare TEXT directly.
--     Fresh environments therefore never see the UUID variant. This
--     migration is the recovery path for environments that already ran
--     011 with the old type.
--
-- Idempotency:
--   Postgres `ALTER COLUMN ... TYPE TEXT` is a no-op when the column is
--   already TEXT. Guarded with a DO block so re-running on a fresh DB
--   (where 002/011 already produced TEXT) does not error.
--
-- Refs: docs/audits/audit-2026-06-02.md PERM-02 (HIGH).

-- =============================================================
-- UP
-- =============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'permission_audit'
      AND column_name  = 'execution_id'
      AND data_type    = 'uuid'
  ) THEN
    EXECUTE 'ALTER TABLE public.permission_audit
             ALTER COLUMN execution_id TYPE TEXT USING execution_id::text';
  END IF;
END$$;

-- =============================================================
-- DOWN
-- =============================================================

-- Reverting requires every row's `execution_id` to be a valid UUID — MCP
-- rows of the form `mcp-<uuid>` would block the cast. Intentionally not
-- provided; restoring the UUID type would re-introduce the audit-loss bug.
