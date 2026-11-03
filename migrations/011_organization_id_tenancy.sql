-- Migration: 011_organization_id_tenancy
-- SP-3 harness tenancy convergence — big-bang Phase 1, Task 3 (schema).
--
-- Canon: 30_adr/bevox-harness/ADR-019 (organization_id UUIDv7 is the sole
-- tenant identifier; legacy INT/BIGINT account_id retired),
-- _shared/ADR-021 (organizationId as canonical tenant term, supersedes
-- hub-ADR-003), _shared/ADR-016 (UUIDv7).
--
-- bevox-harness is PRE-PRODUCTION: the DB stores empty/disposable data, so
-- this migration DROPs & RECREATEs each tenant-keyed table with the tenant
-- column re-typed `account_id INTEGER|BIGINT` → `organization_id UUID NOT NULL`.
-- NO backfill, NO INT→UUID value mapping, NO INSERT … SELECT.
--
-- The legacy `accounts` table is retired and was never created by any harness
-- migration; the 5 `REFERENCES accounts(id)` foreign keys are therefore
-- DROPPED here (they would fail to recreate — the parent table is gone).
--
-- ALTERs from later migrations are folded inline into the recreated tables:
--   - 007: contact_facts.source_agent (TEXT)
--   - 010: workflow_executions.lock_version (INT NOT NULL DEFAULT 0)
--   - 009: workflow_correlation uq_wf_corr_exec_id constraint + probe index
--
-- Tables ordered so surviving FK parents precede children:
--   contact_facts  → message_embeddings (superseded_by_summary_fact_id)
--   rag_documents  → rag_chunks (document_id)
--   workflow_executions → workflow_correlation (workflow_execution_id)
--
-- The `vector` extension is preserved (re-asserted IF NOT EXISTS); it is
-- NEVER dropped — rag_chunks / message_embeddings depend on it.
--
-- Migration slot 011 is reserved canonically. Do NOT renumber.
-- 001=memory/classifications, 002=permission_audit, 003=execution_usage,
-- 004=eval_results, 005=workflow_state, 006=rag_embeddings (D.2), 007=D.3,
-- 008=sdr_account_state, 009=workflow_correlation, 010=workflow_lock_version,
-- 011=organization_id_tenancy (SP-3).

-- =============================================================
-- UP
-- =============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- contact_profiles (source 001) — tenant: account_id INTEGER → organization_id UUID
-- FK REFERENCES accounts(id) DROPPED (legacy accounts retired).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.contact_profiles CASCADE;

CREATE TABLE public.contact_profiles (
  id SERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  contact_id BIGINT NOT NULL,

  -- Personal data
  full_name TEXT,
  preferred_name TEXT,
  birth_date DATE,
  gender TEXT,
  document_number TEXT,

  -- Contact
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  state TEXT,

  -- Preferences
  preferred_language TEXT DEFAULT 'pt-BR',
  preferred_contact_channel TEXT,
  preferred_time_from TIME,
  preferred_time_to TIME,

  -- Metadata
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_interaction_at TIMESTAMPTZ,
  total_interactions INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(organization_id, contact_id)
);

CREATE INDEX idx_contact_profiles_account ON contact_profiles(organization_id);
CREATE INDEX idx_contact_profiles_contact ON contact_profiles(contact_id);

-- ---------------------------------------------------------------------------
-- contact_facts (source 001 + 007 source_agent) — tenant: account_id INTEGER → organization_id UUID
-- FK REFERENCES accounts(id) DROPPED. Self-FK superseded_by → contact_facts(id) preserved.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.contact_facts CASCADE;

CREATE TABLE public.contact_facts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL,
  contact_id BIGINT NOT NULL,

  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  category TEXT,

  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_conversation_key TEXT,
  source_execution_id UUID,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  confirmed BOOLEAN NOT NULL DEFAULT false,
  superseded_by BIGINT REFERENCES contact_facts(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- folded inline from 007_message_embeddings.sql
  source_agent TEXT
);

CREATE INDEX idx_contact_facts_lookup ON contact_facts(organization_id, contact_id, fact_key);
CREATE INDEX idx_contact_facts_category ON contact_facts(organization_id, contact_id, category);
CREATE INDEX idx_contact_facts_active ON contact_facts(organization_id, contact_id)
  WHERE superseded_by IS NULL;

-- ---------------------------------------------------------------------------
-- message_classifications (source 001) — tenant: account_id INTEGER → organization_id UUID
-- FK REFERENCES accounts(id) DROPPED.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.message_classifications CASCADE;

CREATE TABLE public.message_classifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL,
  conversation_key TEXT NOT NULL,
  message_id BIGINT,
  execution_id UUID,

  sentiment TEXT NOT NULL CHECK (sentiment IN (
    'positive', 'neutral', 'negative', 'frustrated', 'angry', 'confused'
  )),
  sentiment_confidence NUMERIC(4,3) NOT NULL CHECK (sentiment_confidence >= 0 AND sentiment_confidence <= 1),

  intent TEXT,
  intent_confidence NUMERIC(4,3) CHECK (intent_confidence >= 0 AND intent_confidence <= 1),

  topics TEXT[],

  urgency TEXT CHECK (urgency IN ('low', 'medium', 'high', 'critical')),

  model_used TEXT,
  processing_ms INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_msg_class_account_conv ON message_classifications(organization_id, conversation_key);
CREATE INDEX idx_msg_class_sentiment ON message_classifications(organization_id, sentiment);
CREATE INDEX idx_msg_class_intent ON message_classifications(organization_id, intent);
CREATE INDEX idx_msg_class_created ON message_classifications(organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- permission_audit (source 002) — tenant: account_id INTEGER → organization_id UUID
-- No FK to accounts in source.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.permission_audit CASCADE;

CREATE TABLE IF NOT EXISTS public.permission_audit (
  id BIGSERIAL PRIMARY KEY,
  -- TEXT (not UUID) to admit synthetic ids from MCP tool invocations
  -- (format `mcp-<uuid>`). Regular harness executions still write UUIDs;
  -- the column accepts both. See src/mcp/execution-context.ts and
  -- audit-2026-06-02 finding PERM-02.
  execution_id TEXT NOT NULL,
  organization_id UUID NOT NULL,
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
  ON public.permission_audit(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_permission_audit_deny
  ON public.permission_audit(decision, created_at DESC)
  WHERE decision = 'deny';

-- ---------------------------------------------------------------------------
-- execution_usage (source 003) — tenant: account_id INTEGER → organization_id UUID
-- No FK to accounts in source.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS execution_usage CASCADE;

CREATE TABLE IF NOT EXISTS execution_usage (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL,
  organization_id UUID NOT NULL,
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
  ON execution_usage(organization_id, created_at);

-- ---------------------------------------------------------------------------
-- eval_results (source 004) — tenant: account_id INTEGER → organization_id UUID
-- No FK to accounts in source.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS eval_results CASCADE;

CREATE TABLE IF NOT EXISTS eval_results (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  scorer_name TEXT NOT NULL,
  scorer_kind TEXT NOT NULL CHECK (scorer_kind IN ('llm-judge', 'rule', 'statistical')),
  score NUMERIC(4, 3) CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  reasoning TEXT NOT NULL,
  model_used TEXT,
  sampling_reason TEXT NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_results_execution
  ON eval_results(execution_id);

CREATE INDEX IF NOT EXISTS idx_eval_results_scorer_day
  ON eval_results(scorer_name, created_at);

CREATE INDEX IF NOT EXISTS idx_eval_results_account_score
  ON eval_results(organization_id, score);

-- ---------------------------------------------------------------------------
-- workflow_executions (source 005 + 010 lock_version) — tenant: account_id BIGINT → organization_id UUID
-- No FK to accounts in source. Parent of workflow_correlation.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS workflow_executions CASCADE;

CREATE TABLE IF NOT EXISTS workflow_executions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      UUID NOT NULL,
  workflow_id       TEXT NOT NULL,
  workflow_version  INTEGER NOT NULL DEFAULT 1,
  organization_id   UUID NOT NULL,
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
  error             JSONB,

  -- folded inline from 010_workflow_lock_version.sql
  lock_version      INT NOT NULL DEFAULT 0
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
  ON workflow_executions(organization_id, status);

-- ---------------------------------------------------------------------------
-- rag_documents (source 006) — tenant: account_id INTEGER → organization_id UUID
-- No FK to accounts in source. Parent of rag_chunks.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS rag_documents CASCADE;

CREATE TABLE IF NOT EXISTS rag_documents (
  id            BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  source        TEXT NOT NULL,
  external_id   TEXT,
  title         TEXT,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_account_source
  ON rag_documents(organization_id, source);

-- ---------------------------------------------------------------------------
-- rag_chunks (source 006) — tenant: account_id INTEGER → organization_id UUID
-- FK document_id → rag_documents(id) preserved. embedding vector(1536) intact.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS rag_chunks CASCADE;

CREATE TABLE IF NOT EXISTS rag_chunks (
  id               BIGSERIAL PRIMARY KEY,
  document_id      BIGINT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL,
  chunk_index      INTEGER NOT NULL,
  content          TEXT NOT NULL,
  token_count      INTEGER NOT NULL,
  embedding        vector(1536),
  embedding_model  TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_document
  ON rag_chunks(document_id);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_account
  ON rag_chunks(organization_id);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding_hnsw
  ON rag_chunks USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- message_embeddings (source 007) — tenant: account_id INTEGER → organization_id UUID
-- FK REFERENCES accounts(id) DROPPED. Self-ref FK
-- superseded_by_summary_fact_id → contact_facts(id) preserved.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS message_embeddings CASCADE;

CREATE TABLE IF NOT EXISTS message_embeddings (
  id                              BIGSERIAL PRIMARY KEY,
  organization_id                 UUID NOT NULL,
  contact_id                      BIGINT NOT NULL,
  message_id                      TEXT NOT NULL,
  role                            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content                         TEXT NOT NULL,
  content_hash                    TEXT NOT NULL,
  token_count                     INTEGER NOT NULL,
  embedding                       vector(1536),
  embedding_model                 TEXT,
  message_at                      TIMESTAMPTZ NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_by_summary_fact_id   BIGINT REFERENCES contact_facts(id) ON DELETE SET NULL,
  UNIQUE (organization_id, contact_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_embeddings_contact
  ON message_embeddings(organization_id, contact_id, message_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_embeddings_active
  ON message_embeddings(organization_id, contact_id)
  WHERE superseded_by_summary_fact_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_message_embeddings_embedding_hnsw
  ON message_embeddings USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- sdr_account_state (source 008) — tenant: account_id INTEGER → organization_id UUID
-- FK REFERENCES accounts(id) DROPPED.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS sdr_account_state CASCADE;

CREATE TABLE IF NOT EXISTS sdr_account_state (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID        NOT NULL,
  contact_id      BIGINT      NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'cold'
                    CHECK (status IN ('cold', 'working', 'nurture', 'disqualified')),
  pact_snapshot   JSONB,
  last_touch_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_sdr_account_state_lookup
  ON sdr_account_state(organization_id, contact_id);

-- ---------------------------------------------------------------------------
-- workflow_correlation (source 009 + folded uq_wf_corr_exec_id) —
-- tenant: account_id BIGINT → organization_id UUID
-- FK workflow_execution_id → workflow_executions(id) preserved.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS workflow_correlation CASCADE;

CREATE TABLE IF NOT EXISTS workflow_correlation (
  organization_id       UUID          NOT NULL,
  contact_key           TEXT          NOT NULL,
  workflow_execution_id UUID          NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  suspend_token         TEXT,
  resume_event          TEXT          NOT NULL,
  status                TEXT          NOT NULL,
  workflow_version      INTEGER       NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- folded inline from 009_workflow_correlation.sql
  CONSTRAINT uq_wf_corr_exec_id UNIQUE (workflow_execution_id)
);

-- Partial unique index: enforces "<=1 reply-resumable cadence per contact".
-- SYNC NOTE: 'reply:inbound' must match the REPLY_RESUMABLE TS const (L4).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf_corr_active
  ON workflow_correlation(organization_id, contact_key)
  WHERE status = 'suspended' AND resume_event IN ('reply:inbound');

-- Probe index for fast lookups by (organization_id, contact_key, status).
CREATE INDEX IF NOT EXISTS idx_wf_corr_probe
  ON workflow_correlation(organization_id, contact_key, status);

-- =============================================================
-- DOWN (reference — Bevox migrations are append-only, no auto-rollback):
--   DROP TABLE IF EXISTS workflow_correlation CASCADE;
--   DROP TABLE IF EXISTS sdr_account_state CASCADE;
--   DROP TABLE IF EXISTS message_embeddings CASCADE;
--   DROP TABLE IF EXISTS rag_chunks CASCADE;
--   DROP TABLE IF EXISTS rag_documents CASCADE;
--   DROP TABLE IF EXISTS workflow_executions CASCADE;
--   DROP TABLE IF EXISTS eval_results CASCADE;
--   DROP TABLE IF EXISTS execution_usage CASCADE;
--   DROP TABLE IF EXISTS public.permission_audit CASCADE;
--   DROP TABLE IF EXISTS public.message_classifications CASCADE;
--   DROP TABLE IF EXISTS public.contact_facts CASCADE;
--   DROP TABLE IF EXISTS public.contact_profiles CASCADE;
--   -- Do NOT drop the `vector` extension; other features depend on it.
--   -- Pre-prod recreate has no prior account_id data to restore.
-- =============================================================
