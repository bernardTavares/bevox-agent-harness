-- Migration: 008_sdr_account_state
-- Creates flat per-(account,contact) SDR state snapshot table.
-- Backs the L3 sales-state seam (B.8) and the read in enrich-3c (B.5).
-- Migration slot 008 is reserved canonically. Do NOT renumber.
-- 001=memory/classifications, 002=permission_audit, 003=execution_usage,
-- 004=eval_results, 005=workflow_state, 006=rag_embeddings (D.2), 007=D.3,
-- 008=sdr_account_state, 009=workflow_correlation, 010=workflow_lock_version.

-- ---------------------------------------------------------------------------
-- sdr_account_state: flat per-(account, contact) SDR sales-state snapshot.
-- One row per contact per account. NOT a cadence/FSM (that is Phase C).
-- status: cold → working → nurture → disqualified lifecycle stages.
-- pact_snapshot: last PACT framework JSON (Pain, Authority, Consequence, Timeline).
-- last_touch_at: timestamp of last SDR interaction with this contact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sdr_account_state (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      BIGINT      NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'cold'
                    CHECK (status IN ('cold', 'working', 'nurture', 'disqualified')),
  pact_snapshot   JSONB,
  last_touch_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_sdr_account_state_lookup
  ON sdr_account_state(account_id, contact_id);

-- ---------------------------------------------------------------------------
-- DOWN (reference — append-only migrations):
--   DROP INDEX IF EXISTS idx_sdr_account_state_lookup;
--   DROP TABLE IF EXISTS sdr_account_state;
-- ---------------------------------------------------------------------------
