-- Migration: 010_workflow_lock_version
-- Adds lock_version to workflow_executions for optimistic-concurrency control.
-- Enables guarded claims (resume vs cleanup race) via compare-and-increment.
-- Migration slot 010 is reserved canonically. Do NOT renumber.
-- 001=memory/classifications, 002=permission_audit, 003=execution_usage,
-- 004=eval_results, 005=workflow_state, 006=rag_embeddings (D.2), 007=D.3,
-- 008=sdr_account_state, 009=workflow_correlation, 010=workflow_lock_version.

-- ---------------------------------------------------------------------------
-- lock_version: integer counter, default 0.
-- Consumers increment it atomically (UPDATE … WHERE lock_version = $expected)
-- to implement optimistic locking without advisory locks.
-- ---------------------------------------------------------------------------
ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS lock_version INT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- DOWN (reference — append-only migrations):
--   ALTER TABLE workflow_executions DROP COLUMN IF EXISTS lock_version;
-- ---------------------------------------------------------------------------
