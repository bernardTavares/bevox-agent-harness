-- Sprint C.1 — Workflow Engine state persistence.
-- Migration slot 005 is reserved canonically (G.1). Do NOT renumber.

CREATE TABLE IF NOT EXISTS workflow_executions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      UUID NOT NULL,
  workflow_id       TEXT NOT NULL,
  workflow_version  INTEGER NOT NULL DEFAULT 1,
  account_id        BIGINT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('running','suspended','completed','failed','cancelled')),
  state             JSONB NOT NULL,
  current_step      TEXT,
  suspend_token     TEXT UNIQUE,
  suspend_reason    TEXT,
  resume_event      TEXT,
  resume_payload    JSONB,
  timeout_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  error             JSONB
);

CREATE INDEX IF NOT EXISTS idx_wf_exec_status
  ON workflow_executions(status);

CREATE INDEX IF NOT EXISTS idx_wf_exec_suspend_token
  ON workflow_executions(suspend_token) WHERE suspend_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wf_exec_timeout
  ON workflow_executions(timeout_at) WHERE status = 'suspended';

CREATE INDEX IF NOT EXISTS idx_wf_exec_execution_id
  ON workflow_executions(execution_id);

-- Composite index for `listSuspended` per account (correção pós-review).
CREATE INDEX IF NOT EXISTS idx_wf_exec_account_status
  ON workflow_executions(account_id, status);
