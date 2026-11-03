-- Phase 4 (observability): track per-call LLM usage for cost + latency telemetry.
-- Phase 3 reserves 002_permission_audit.sql; this migration is 003.

-- UP
CREATE TABLE IF NOT EXISTS execution_usage (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL,
  account_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd_cents INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  call_purpose TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_usage_execution
  ON execution_usage(execution_id);

CREATE INDEX IF NOT EXISTS idx_execution_usage_account_day
  ON execution_usage(account_id, created_at);

-- DOWN
-- DROP TABLE IF EXISTS execution_usage;
