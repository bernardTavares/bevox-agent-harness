# Memory Architecture — Sprint D.3 (Semantic + Observational)

> **Status:** delivered Wave 4 (2026-05-14). Companion to existing
> `memoria-e-classificacao.md` which covers the pre-D.3 working memory
> (`contact_profiles`, `contact_facts`, `message_classifications`).
>
> **Authoritative knowledge:** per ADR-010/011 this file is a local mirror
> of the canonical artifact that lives in `bevox-knowledge` (slot
> `bevox-harness`). Promote with the `bevox-knowledge-contribute` skill.

## Three layers of memory

The harness now exposes three complementary memory tiers, inspired by Mastra
Memory:

| Tier             | Storage                                  | Refresh cadence              | Surfaced in MemoryLayer as              |
| ---------------- | ---------------------------------------- | ---------------------------- | --------------------------------------- |
| **Working**      | `messages[]` in the dispatch payload     | Per execution                | History layer (chronological)           |
| **Semantic**     | `message_embeddings` (D.3)               | Indexed post-execution       | "Memorias semanticamente relevantes"    |
| **Observational**| `contact_facts` rows with `category='summary'` (D.3) | Out-of-band (BullMQ worker)  | "Resumo de interacoes passadas"         |

Working memory predates D.3 and is untouched. Semantic and observational
memory are **opt-in** via feature flags (see below) — the default behaviour
of the harness is unchanged.

## Data model

`migrations/007_message_embeddings.sql` adds:

- **`message_embeddings`** — one row per message, indexed by
  `(account_id, contact_id, message_id)` UNIQUE. Stores the message body,
  a 1536-D embedding (pgvector + HNSW + `vector_cosine_ops`), token count,
  and a nullable FK `superseded_by_summary_fact_id → contact_facts(id)`.
- **`contact_facts.source_agent`** — column added so condenser-produced
  summaries and facts can be filtered/audited. Existing rows have
  `source_agent IS NULL`.

Messages are **never deleted**: when condensation runs, the rows are
marked supersededed so retrieval skips them while audit/regen pipelines
still see the raw text.

Tenant isolation lives in the SQL: every semantic-recall query filters by
`account_id`, mirroring the pattern enforced by `PgVectorStore` in D.2.

## Components

```
post-execution (fire-and-forget)
   ├── MessageEmbeddingIndexer.index(account, contact, msgs)
   │     ↳ skips duplicates by content_hash + UNIQUE (account, contact, message_id)
   │     ↳ writes vec + token_count + role + message_at
   └── enqueueCondense(queue, account, contact)
         ↳ jobId dedup: at most one pending condense per (account, contact)

worker:condense (separate process)
   └── ObservationalCondenser.maybeCondense(account, contact)
        ├── evaluateCondenseSignal({ messages, lastCondenseAt, config })
        │     ↳ Pure: triggers on (50 msgs) ∨ (8000 tokens) ∨ (7d + 5 msgs)
        └── runMemoryCondenser({ messages, deps })
             ├── LLMGateway.complete({ system, user, responseSchema, meta })
             ├── parse → Zod-validated { summary, facts[] }
             ├── ContactFactsRepository.insert(summary, source_agent='memory-condenser')
             ├── ContactFactsRepository.insert(...facts, source_agent='memory-condenser')
             └── UPDATE message_embeddings SET superseded_by_summary_fact_id = ...
                  WHERE message_id = ANY($ids) AND superseded_by_summary_fact_id IS NULL
                  (advisory_xact_lock on contact_id; same as MemoryExtractor)

context build (per execution)
   └── MemoryLayer.build(input)
        ├── existing: profile + facts (excludes category='summary')
        ├── D.3: factsRepo.findSummaries → "Resumo de interacoes passadas"
        └── D.3: semanticRecall.recall({ query=userMessage, excludeRecent: 10 })
              → "Memorias semanticamente relevantes"
```

## Feature flags

All defaults are **OFF**: zero behaviour change when D.3 is unused.

| Flag                                | Default | Effect                                                                                |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `MEMORY_INDEXER_ENABLED`            | `false` | Wires the message indexer; post-execution hook indexes new messages.                  |
| `MEMORY_SEMANTIC_RECALL_ENABLED`    | `false` | Wires `RagSemanticRecall`; MemoryLayer (when constructed with the dep) appends recall section. |
| `MEMORY_CONDENSE_ENABLED`           | `false` | Wires the condense queue producer; post-execution hook enqueues condense jobs.        |
| `MEMORY_SEMANTIC_RECALL_TOP_K`      | `5`     | Max recalled messages per build.                                                      |
| `MEMORY_SEMANTIC_RECALL_MIN_SCORE`  | `0.6`   | Cosine threshold below which a match is discarded.                                    |
| `MEMORY_SEMANTIC_RECALL_EXCLUDE_RECENT` | `10` | Most-recent N messages skipped (already covered by History layer).                    |
| `MEMORY_CONDENSE_THRESHOLD_MESSAGES`| `50`    | Condense if >= N un-summarized messages.                                              |
| `MEMORY_CONDENSE_THRESHOLD_TOKENS`  | `8000`  | Condense if cumulative tokens >= N.                                                   |
| `MEMORY_CONDENSE_THRESHOLD_DAYS`    | `7`     | Condense if lastSummary older than N days AND >=5 messages exist.                     |
| `MEMORY_CONDENSE_QUEUE_NAME`        | `harness.memory.condense` | BullMQ queue name.                                                  |
| `MEMORY_CONDENSE_WORKER_CONCURRENCY`| `1`     | Job concurrency in `worker:condense`.                                                 |

To run the dedicated worker process:

```bash
MEMORY_CONDENSE_ENABLED=true npm run worker:condense
```

## Trade-offs and decisions

- **HNSW over IVFFlat** — mirrors D.2 choice. No training step required and
  recall remains ≥ 0.95 for the dataset sizes we expect per (account, contact).
- **Mensagens não são deletadas** — supersession (not deletion) preserves
  auditability and allows the condenser to be retrained / re-run with new
  prompts. Cost is monotonic growth; retention policies are noted in the
  "Post-review" section of the sprint plan and will be added in a follow-up.
- **Fire-and-forget at the call site** — `queueMicrotask` keeps the hot
  path free. Embedding latency does not block `/complete`. When latency
  budgets bite, the hook can move to a dedicated BullMQ queue
  (`harness.memory.index`).
- **Pipeline agent in registry, runner via BullMQ** — `MemoryCondenserAgent`
  is registered so operators can see it in `/admin` listings; the actual
  condense path is `runMemoryCondenser` called by the worker. The agent's
  `execute()` is a no-op shim that returns `{ skipped: true }`.
- **Summary persistence as a contact_fact** — reuses the existing supersede
  / confirmed semantics. No new table; the `source_agent` column lets
  consumers filter machine-generated summaries from user-confirmed facts.
- **No replacement of MemoryExtractor** — both pipeline agents coexist.
  Extractor handles structured fact extraction during the live execution;
  Condenser handles bulk summarization out-of-band.

## Constraints preserved

D.3 explicitly does NOT:

1. Replace `LLMGateway` with another SDK (Vercel AI / etc).
2. Touch `src/permissions/` or the three-layer permission evaluator.
3. Collapse or replace any of the 5 reasoning engines.

## Tests

- `tests/unit/memory/condense-heuristics.test.ts` — 8 cases covering each threshold.
- `tests/unit/memory/semantic-recall.test.ts` — 6 cases including tenant guard and superseded filter.
- `tests/unit/memory/message-embedding-indexer.test.ts` — 5 cases including dedup + empty-content filter.
- `tests/unit/memory/observational-condenser.test.ts` — 4 cases covering all signal branches.
- `tests/unit/agents/pipeline/memory-condenser.agent.test.ts` — 8 cases covering definition, registry shim, JSON parser (with code-fence stripping), Zod validation, and a happy-path end-to-end with mocked LLM/repo.
- `tests/unit/context/layers/memory.layer.d3.test.ts` — 8 cases covering the two new sections plus the zero-regression contract.
- `tests/integration/memory/semantic-recall.integration.test.ts` — pgvector E2E (RUN_INTEGRATION=1) using a deterministic stub embedder.
