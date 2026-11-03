-- Sprint D.3 — Semantic + Observational Memory.
-- Migration slot 007 is reserved canonically. Do NOT renumber.
-- 001=memory/classifications, 002=permission_audit, 003=execution_usage,
-- 004=eval_results, 005=workflow_state, 006=rag_embeddings (D.2), 007=D.3,
-- 008=sdr_account_state.
--
-- Hard dependency: pgvector extension (created by 006). This migration
-- pre-flights and fails loudly if 006 has not been applied.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'D.3 (semantic memory) requires D.2 (RAG pgvector) to be merged and migration 006 applied first';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- message_embeddings: per-(account, contact) indexed messages with embeddings.
-- Same shape as rag_chunks but partitioned by contact for semantic recall.
-- Mensagens NÃO são deletadas; quando condensadas, marcadas via
-- superseded_by_summary_fact_id para retrieval ignorar.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_embeddings (
  id                              BIGSERIAL PRIMARY KEY,
  account_id                      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
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
  UNIQUE (account_id, contact_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_embeddings_contact
  ON message_embeddings(account_id, contact_id, message_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_embeddings_active
  ON message_embeddings(account_id, contact_id)
  WHERE superseded_by_summary_fact_id IS NULL;

-- HNSW (mirrors D.2 choice over IVFFlat): no training step, query O(log N),
-- recall >= 0.95 with default params. vector_cosine_ops matches `<=>` operator
-- used in semantic-recall.ts (score = 1 - distance).
CREATE INDEX IF NOT EXISTS idx_message_embeddings_embedding_hnsw
  ON message_embeddings USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- contact_facts.source_agent — marks summaries/facts emitted by memory-condenser
-- so audit + UI can distinguish them from MemoryExtractor or human-entered.
-- ---------------------------------------------------------------------------
ALTER TABLE contact_facts
  ADD COLUMN IF NOT EXISTS source_agent TEXT;

-- ---------------------------------------------------------------------------
-- DOWN (reference — append-only migrations):
--   ALTER TABLE contact_facts DROP COLUMN IF EXISTS source_agent;
--   DROP INDEX IF EXISTS idx_message_embeddings_embedding_hnsw;
--   DROP INDEX IF EXISTS idx_message_embeddings_active;
--   DROP INDEX IF EXISTS idx_message_embeddings_contact;
--   DROP TABLE IF EXISTS message_embeddings;
-- ---------------------------------------------------------------------------
