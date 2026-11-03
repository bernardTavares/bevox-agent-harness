-- Migration: 009_workflow_correlation
-- Creates the workflow_correlation projection index for the Model-C correlation
-- bridge: maps (account_id, contact_key) → suspended cadence execution.
-- Migration slot 009 is reserved canonically. Do NOT renumber.
-- 001=memory/classifications, 002=permission_audit, 003=execution_usage,
-- 004=eval_results, 005=workflow_state, 006=rag_embeddings (D.2), 007=D.3,
-- 008=sdr_account_state, 009=workflow_correlation.

-- ---------------------------------------------------------------------------
-- workflow_correlation: projection index — one row per active cadence per
-- (account, contact). Enables the resume bridge to look up the suspended
-- execution by account+contact key without a full workflow_executions scan.
--
-- status: mirrors workflow_executions.status ('suspended', 'completed', …)
-- resume_event: the event type the execution is waiting for (e.g. 'reply:inbound').
-- suspend_token: correlates to workflow_executions.suspend_token (nullable —
--   only set while the execution is suspended).
--
-- NOTE: the 'reply:inbound' literal below MUST stay in sync with the future
-- REPLY_RESUMABLE TypeScript constant (L4 — correlation bridge). If the event
-- name changes, update the partial index definition as well.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_correlation (
  account_id            BIGINT        NOT NULL,
  contact_key           TEXT          NOT NULL,
  workflow_execution_id UUID          NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  suspend_token         TEXT,
  resume_event          TEXT          NOT NULL,
  status                TEXT          NOT NULL,
  workflow_version      INTEGER       NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Partial unique index: enforces "≤1 reply-resumable cadence per contact" at
-- the DB level. Only one suspended+reply:inbound row is allowed per
-- (account_id, contact_key) pair at any time.
-- SYNC NOTE: 'reply:inbound' must match the REPLY_RESUMABLE TS const (L4).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf_corr_active
  ON workflow_correlation(account_id, contact_key)
  WHERE status = 'suspended' AND resume_event IN ('reply:inbound');

-- Unique constraint: one correlation row per workflow execution.
-- workflow_execution_id is the natural identity key for upsert
-- (ON CONFLICT (workflow_execution_id) in correlation-store.ts requires this).
ALTER TABLE workflow_correlation
  ADD CONSTRAINT uq_wf_corr_exec_id UNIQUE (workflow_execution_id);

-- Probe index for fast lookups by (account_id, contact_key, status).
CREATE INDEX IF NOT EXISTS idx_wf_corr_probe
  ON workflow_correlation(account_id, contact_key, status);

-- ---------------------------------------------------------------------------
-- DOWN (reference — append-only migrations):
--   DROP INDEX IF EXISTS idx_wf_corr_probe;
--   ALTER TABLE workflow_correlation DROP CONSTRAINT IF EXISTS uq_wf_corr_exec_id;
--   DROP INDEX IF EXISTS uq_wf_corr_active;
--   DROP TABLE IF EXISTS workflow_correlation;
-- ---------------------------------------------------------------------------
