-- Migration: 002_permission_audit
-- Persists permission decisions emitted by src/permissions/evaluator.ts.
-- IMPORTANT: Apply this migration BEFORE deploying Phase 3 code. The audit
-- INSERT is fire-and-forget; without the table every deny logs a warning.

-- =============================================================
-- UP
-- =============================================================

CREATE TABLE IF NOT EXISTS public.permission_audit (
  id BIGSERIAL PRIMARY KEY,
  -- TEXT (not UUID) to admit synthetic ids from MCP tool invocations
  -- (format `mcp-<uuid>`). Regular harness executions still write UUIDs;
  -- the column accepts both. See src/mcp/execution-context.ts and
  -- audit-2026-06-02 finding PERM-02.
  execution_id TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason TEXT,
  layer TEXT NOT NULL CHECK (layer IN ('agent_static', 'execution_context', 'allow')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permission_audit_execution
  ON public.permission_audit(execution_id);

CREATE INDEX IF NOT EXISTS idx_permission_audit_account_recent
  ON public.permission_audit(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_permission_audit_deny
  ON public.permission_audit(decision, created_at DESC)
  WHERE decision = 'deny';

-- =============================================================
-- DOWN
-- =============================================================

-- DROP INDEX IF EXISTS public.idx_permission_audit_deny;
-- DROP INDEX IF EXISTS public.idx_permission_audit_account_recent;
-- DROP INDEX IF EXISTS public.idx_permission_audit_execution;
-- DROP TABLE IF EXISTS public.permission_audit;
