-- Sprint D.2 — RAG with pgvector.
-- Migration slot 006 is reserved canonically (G.1). Do NOT renumber.
-- 004 = A.2 (eval_results), 005 = C.1 (workflow_state), 006 = D.2.
--
-- Prerequisites:
--   `CREATE EXTENSION vector` requires superuser privilege on most managed
--   Postgres deployments (RDS, Neon, Supabase). If running under a low-priv
--   role, ask DBA to run the CREATE EXTENSION manually, then re-run this
--   migration (the IF NOT EXISTS makes it idempotent).
--
-- Pre-flight check before running:
--   psql $DATABASE_URL -c "SELECT 1 FROM pg_available_extensions WHERE name='vector';"
--   psql $DATABASE_URL -c "SELECT 1 FROM pg_extension WHERE extname='vector';"

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- rag_documents: source-of-truth for ingested content (markdown/txt/etc).
-- One row per logical document; chunks are derived in `rag_chunks`.
-- `content_hash` lets re-ingest detect "no change → skip embeddings".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag_documents (
  id            BIGSERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL,
  source        TEXT NOT NULL,
  external_id   TEXT,
  title         TEXT,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_account_source
  ON rag_documents(account_id, source);

-- ---------------------------------------------------------------------------
-- rag_chunks: chunked content with embeddings for similarity search.
-- Dimension fixed at 1536 (OpenAI text-embedding-3-small). Changing model
-- to one with different dimensionality (e.g. Gemini 768) requires a new
-- migration + re-embed (ALTER TYPE on vector(N) is not supported).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag_chunks (
  id               BIGSERIAL PRIMARY KEY,
  document_id      BIGINT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  account_id       INTEGER NOT NULL,
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
  ON rag_chunks(account_id);

-- HNSW (G.9) — picked over IVFFlat: no training step required, quality is
-- independent of dataset size, recall ≥ 0.95 with default params.
-- pgvector ≥ 0.5.0 supports HNSW. Build cost scales O(N log N); query O(log N).
-- Operator class `vector_cosine_ops` matches the `<=>` cosine distance used
-- in similaritySearch (score = 1 - distance).
CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding_hnsw
  ON rag_chunks USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- rag_embedding_cache: content-addressed cache to avoid re-embedding
-- identical text across runs. Keyed by (model, sha256(content)).
-- Survives across deployments; trimmed manually if it grows too large.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag_embedding_cache (
  model         TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  embedding     vector(1536) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (model, content_hash)
);

-- ---------------------------------------------------------------------------
-- DOWN (reference — Bevox migrations are append-only, no auto-rollback):
--   DROP TABLE IF EXISTS rag_embedding_cache;
--   DROP INDEX IF EXISTS idx_rag_chunks_embedding_hnsw;
--   DROP TABLE IF EXISTS rag_chunks;
--   DROP TABLE IF EXISTS rag_documents;
--   -- Do NOT drop the `vector` extension; other features may depend on it.
-- ---------------------------------------------------------------------------
