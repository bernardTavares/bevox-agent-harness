# RAG (pgvector)

Sprint D.2 introduces a Retrieval-Augmented Generation layer on top of the
existing PostgreSQL cluster using the `pgvector` extension.

> Operational doc — sits alongside other `docs/architecture/*.md` files.
> Canonical PRD/ADR for this work lives in bevox-knowledge (slot
> `bevox-harness`).

## Overview

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  rag:ingest  │ →  │  Chunker     │ →  │  Embedder    │
│  (CLI)       │    │  (recursive) │    │  (caching)   │
└──────────────┘    └──────────────┘    └──────┬───────┘
                                               │
                                               ▼
                                       ┌──────────────┐
                                       │ VectorStore  │
                                       │ (pgvector)   │
                                       └──────┬───────┘
                                              │
                                              ▼
        ┌────────────┐   query    ┌──────────────────────┐
        │  search-faq│ ─────────► │  RagRetriever        │
        │  (tool)    │            │  (embed → search)    │
        └────────────┘            └──────────────────────┘
```

## Schema (migration `006_rag_embeddings.sql`)

- `rag_documents` — one row per logical document. `(account_id, source,
  external_id)` is unique so re-ingest is idempotent. `content_hash`
  (sha256) lets ingest detect "no change → skip embeddings".
- `rag_chunks` — chunked content with `embedding vector(1536)` column.
  `account_id` is denormalised onto each chunk so similarity queries can
  filter without joining `rag_documents`. Indexed with **HNSW** (chosen
  over IVFFlat — no training step, recall is dataset-size independent).
- `rag_embedding_cache` — content-addressed `(model, sha256(content)) →
  embedding` cache. Survives deployments; cleared manually if it grows.

### Why HNSW over IVFFlat

| Aspect            | IVFFlat                                | HNSW (chosen)                  |
| ----------------- | -------------------------------------- | ------------------------------ |
| Training          | Requires `ANALYZE` + tuning `lists`    | None                           |
| Quality at scale  | Degrades unless `lists ≈ sqrt(N)`      | Independent of N               |
| Build cost        | Low                                    | Higher (O(N log N))            |
| Query cost        | O(sqrt(N))                             | O(log N)                       |
| Recall ≥ 0.95     | Needs tuning                           | Default params                 |

Bevox dataset is multi-tenant with widely-varying chunk counts per account.
HNSW removes the operational burden of resizing `lists` per tenant.

### Why a fixed dimension (1536)

`vector(N)` is a hard schema constraint — `ALTER COLUMN ... TYPE
vector(M)` is unsupported. We pinned to OpenAI `text-embedding-3-small`
(1536). Switching to Gemini (768) or `text-embedding-3-large` (3072)
requires a follow-up migration and a full re-embed (the `rag:reembed` CLI
handles the second half).

A runtime guard in `init-rag` and `CachingEmbedder` rejects any other
dimension with a clear error, so a misconfigured `RAG_EMBEDDING_DIM`
fails at boot — never silently writes broken vectors.

## Pre-flight (DBA action required on managed Postgres)

`CREATE EXTENSION vector` requires superuser on most managed deployments
(RDS, Neon, Supabase). Run once per database:

```sql
CREATE EXTENSION vector;
```

Then apply the migration:

```bash
psql $DATABASE_URL -f migrations/006_rag_embeddings.sql
```

Pre-flight checks the bootstrap performs at the `init-rag` stage:

```sql
SELECT 1 FROM pg_extension WHERE extname = 'vector';
```

If the row is missing, bootstrap fails fast with a remediation message.

## Modules

| Module                                  | Responsibility                                        |
| --------------------------------------- | ----------------------------------------------------- |
| `src/rag/types.ts`                      | Public interfaces (`Chunker`, `Embedder`, `VectorStore`, `Retriever`) |
| `src/rag/chunker.ts`                    | Recursive splitter with word-level overlap            |
| `src/rag/embedder.ts`                   | `CachingEmbedder` (DB-cache + multi-dim guard)        |
| `src/rag/vector-store.ts`               | `PgVectorStore` — CRUD + cosine top-K                 |
| `src/rag/retriever.ts`                  | `RagRetriever` — query → embed → search (with span)   |
| `src/rag/registry.ts`                   | Module-level singleton — wired by bootstrap           |
| `src/rag/cli/{ingest,reembed}.ts`       | Standalone CLIs (sub-bootstrap; no consumer/calendar) |
| `src/integration/llm/embedder.ts`       | `LLMEmbedder` interface — separate from `LLMGateway`  |
| `src/integration/llm/adapters/*-embed*` | OpenAI + Gemini embed adapters                        |

### Why `LLMEmbedder` is separate from `LLMGateway`

- Completion and embedding endpoints have disjoint shapes (no tools, no
  streaming, no temperature for embeddings).
- Anthropic has **no first-party embedding API** (2026-05). Conflating
  would force every gateway consumer to handle "embed not supported".
- Decorators compose differently — embeddings batch (≤100 inputs/call),
  are idempotent, and benefit from a content-addressed cache that
  completions don't.

Factory `createLLMEmbedder()` is the parallel of `createLLMGateway()`.

## Tenant isolation

`PgVectorStore.similaritySearch` enforces `accountId` as mandatory:

- Null/undefined → throw with explicit error.
- Non-finite number → throw.
- Empty `queryEmbedding` → throw.

Regression test: `tests/unit/rag/vector-store.test.ts` (`tenant guard`
suite). Cross-account leakage cannot occur via the public API.

## Token estimator caveat

The chunker uses `estimateTokens` (`words * 1.3`) — a fast heuristic, not
provider-billing accurate. Overshoot of ~10–15% is normal; consumers
that need exact billing must call provider tokeniser APIs separately.

## CLI usage

```bash
# Ingest a single file
npm run rag:ingest -- --source ./fixtures/faq.md --account 1

# Ingest a directory of .md/.txt/.json under tag `kb-product`
npm run rag:ingest -- --source ./docs/kb --account 1 --tag kb-product

# Count without writing
npm run rag:ingest -- --source ./fixtures --account 1 --dry-run

# Re-embed everything with the current RAG_EMBEDDING_MODEL
npm run rag:reembed

# Limit to one account / source, batches of 50
npm run rag:reembed -- --account 1 --source faq --batch 50
```

The CLIs use a **sub-bootstrap**: env validation + pg.Pool + credential
pool + embedder. They do **not** start the BullMQ consumer, calendar
health check, or tool registry, so they can run safely from cron or CI.

## Bootstrap stage

`init-rag` runs after `load-tools-permissions` and before
`calendar-health`. It is **opt-in**:

```env
RAG_ENABLED=true
RAG_EMBEDDING_MODEL=text-embedding-3-small
RAG_EMBEDDING_DIM=1536
RAG_TOP_K_DEFAULT=5
RAG_MIN_SCORE=0.5
```

When `RAG_ENABLED=false` (default), the stage logs a skip and
`search-faq` returns `{ degraded: true, results: [] }` — surface agents
fall back to LLM-only answers.

## search-faq schema versioning

`search-faq` result schema bumped to `schema_version: 2`. Consumers can
discriminate on this field. v1 emitted `{ id, question, answer, score }`;
v2 emits `{ id, chunkId, documentId, content, title, score }` where `id`
is aliased to `chunkId` for backward compat.

When the RAG schema is not applied yet (partial deploy), the tool
catches the relation-does-not-exist error and returns `degraded: true`
instead of `RAG_FAILURE` — keeping surface agents alive.

## Observability

`RagRetriever.retrieve` opens an OTEL span `rag.retrieve` with:

- `rag.account_id`
- `rag.top_k`
- `rag.source`
- `rag.embedding_model`
- `rag.results_count`
- `rag.top_score`

Spans are no-op when `OTEL_ENABLED=false`.

## Troubleshooting

| Symptom                                          | Action                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `pgvector extension not installed` at boot       | DBA must `CREATE EXTENSION vector` (superuser required)                 |
| `RAG_EMBEDDING_DIM=… not supported`              | Schema is `vector(1536)`. Either change env back or add a new migration |
| `search-faq` always returns `degraded: true`     | `RAG_ENABLED=false`, or migration 006 not applied                       |
| Embeddings call returns 401/403                  | CredentialPool rotates the key; check `${PROVIDER}_API_KEY(S)` env      |
| Latency grows linearly with chunk count          | Confirm HNSW index built (`\d rag_chunks` shows `…_hnsw`)               |
| Duplicate embeddings cost                        | Confirm `rag_embedding_cache` has rows; consider lower `RAG_MIN_SCORE`  |
