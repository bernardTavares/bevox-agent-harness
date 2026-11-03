# Sprint D.2: RAG com pgvector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir uma camada RAG (Retrieval-Augmented Generation) sobre o Postgres existente usando a extensão `pgvector`, com helpers de chunking, embedding, vector store e retriever. Primeiro caso de uso: `search-faq` evolui de SQL LIKE/trigram para vector similarity semântica. Inspirado em Mastra RAG, mas in-house e plugado no LLM Gateway existente.

**Architecture:** Extensão `pgvector` instalada no Postgres atual (mesmo cluster, schema `public`). Tabelas `rag_documents` (origem do conteúdo) e `rag_chunks` (chunks com coluna `embedding vector(1536)` + índice `ivfflat`). Embedder usa o `LLMGateway` estendido com método `embed()`, suportando `text-embedding-3-small` (OpenAI) e `gemini-embedding-001` (Gemini). Chunker recursivo (parágrafo → frase → tokens, máx 512 tokens/chunk). Retriever faz top-K por cosine similarity com filtros opcionais por `account_id` e `source`. CLI `npm run rag:ingest` para ingestar documentos.

**Tech Stack:** PostgreSQL 16 + pgvector ≥ 0.7, `pg` 8 (já no projeto), Zod 4 (validação CLI), Pino (logs). Sem dep nova de runtime — embeddings via providers já adaptados no LLM Gateway. Para CLI: `commander` ou flags manuais via `process.argv`.

---

## Dependencies

- **Hard:** Nenhuma. Constrói infra própria.
- **Soft:**
  - Fase 5 (LLM resilience) — `LLMGateway` ganhará método `embed()`; se F5 estiver mergeada, o decorator stack (retry/circuit/usage) cobre embeddings automaticamente.
  - Fase 4 (Observability) — spans `rag.retrieve`, `rag.embed`, `rag.ingest` enriquecem traces.
  - Skills/FAQ tool (já existe `search-faq.tool.ts`).
- **Blocks:** Sprint D.3 (Semantic Memory) depende **hard** desta fase — D.3 reusa `Embedder`, `VectorStore`, `Retriever`.
- **Conflitos potenciais:**
  - `src/integration/llm-gateway.ts` — adição de método `embed()` (extensão, não breaking)
  - `src/tools/knowledge/search-faq.tool.ts` — reescrita do SQL para usar `Retriever`
  - `migrations/` — novo número (006 assumindo 004 e 005 reservados; verificar antes)

## Files Touched

### Create
- `src/rag/types.ts` (interfaces `Chunker`, `Embedder`, `VectorStore`, `Retriever`, `RagDocument`, `RagChunk`, `RetrievedChunk`)
- `src/rag/chunker.ts` (recursive splitter)
- `src/rag/embedder.ts` (wrapper sobre `LLMGateway.embed()` com cache)
- `src/rag/vector-store.ts` (CRUD em `rag_documents`/`rag_chunks` + similarity search)
- `src/rag/retriever.ts` (orquestra: query → embed → search → format)
- `src/rag/cli/ingest.ts` (CLI: `npm run rag:ingest -- --source ... --account ...`)
- `src/rag/cli/reembed.ts` (CLI: re-gera embeddings com modelo novo)
- `src/integration/llm/adapters/openai-embed.ts` (extensão do adapter OpenAI)
- `src/integration/llm/adapters/gemini-embed.ts` (extensão do adapter Gemini)
- `migrations/006_rag_embeddings.sql`
- `tests/unit/rag/chunker.test.ts`
- `tests/unit/rag/embedder.test.ts`
- `tests/unit/rag/retriever.test.ts`
- `tests/integration/rag/vector-store.integration.test.ts` (precisa Postgres com pgvector)

### Modify
- ⚠️ `src/integration/llm-gateway.ts` — adicionar interface `EmbedRequest`, `EmbedResponse`, método `embed()`
- ⚠️ `src/integration/llm/adapters/openai.ts` e `gemini.ts` — implementar `embed()`
- ⚠️ `src/tools/knowledge/search-faq.tool.ts` — usar `Retriever` em vez de SQL LIKE/trigram (fallback se `rag_chunks` vazio)
- `src/config/env.ts` — vars `RAG_EMBEDDING_MODEL`, `RAG_EMBEDDING_DIM`, `RAG_TOP_K_DEFAULT`
- `package.json` — scripts `rag:ingest`, `rag:reembed`
- `README.md` — seção RAG

### High-conflict files
- ⚠️ `src/integration/llm-gateway.ts` — F5 também toca; coordenar sequência
- ⚠️ `migrations/` — verificar próximo número livre

## Estimated Effort
2-3 semanas (~60-80 horas).

---

## Tasks

### Task 1: Migration — pgvector + tabelas

**Files:**
- Create: `migrations/006_rag_embeddings.sql`

- [ ] **Step 1: Validar disponibilidade do pgvector**

```bash
psql $DATABASE_URL -c "SELECT * FROM pg_available_extensions WHERE name='vector';"
```

⚠ Se não aparecer, escalar ao DBA/infra. Em Postgres self-hosted basta `apt install postgresql-16-pgvector`. Em managed (Neon, Supabase, RDS) já vem disponível.

- [ ] **Step 2: `migrations/006_rag_embeddings.sql`**

```sql
-- UP
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rag_documents (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                  -- e.g. 'faq', 'kb-product', 'policy'
  external_id TEXT,                      -- opcional: id do doc no sistema origem
  title TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,            -- sha256 do content (detectar mudança)
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, source, external_id)
);

CREATE INDEX idx_rag_documents_account_source ON rag_documents(account_id, source);

CREATE TABLE rag_chunks (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  embedding vector(1536),                -- dimensão default OpenAI text-embedding-3-small
  embedding_model TEXT,                  -- 'text-embedding-3-small', 'gemini-embedding-001', etc.
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rag_chunks_document ON rag_chunks(document_id);
CREATE INDEX idx_rag_chunks_account ON rag_chunks(account_id);

-- IVFFlat: rápido para cosine; lists=100 é ok até ~100k chunks; escalar para sqrt(N) depois.
CREATE INDEX idx_rag_chunks_embedding_cos
  ON rag_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- DOWN
DROP INDEX IF EXISTS idx_rag_chunks_embedding_cos;
DROP TABLE IF EXISTS rag_chunks;
DROP TABLE IF EXISTS rag_documents;
-- NÃO dropar extension vector (pode ser usada por outras tabelas)
```

⚠ Dimensão `1536` é fixa por modelo. Se trocar para Gemini (`768`), exige migration nova (ALTER TYPE não suporta mudança de dim em vector). Estratégia: tabela única com `vector(1536)` e padronizar — Gemini retorna `768`, pad com zeros NÃO é correto. **Solução**: criar `rag_chunks_768` separada se Gemini virar default, OU normalizar para um modelo único. **Decisão deste plano**: single-model, default OpenAI `text-embedding-3-small` (1536), com flag de migração quando trocar.

- [ ] **Step 3: Rodar migration localmente**

```bash
psql $DATABASE_URL -f migrations/006_rag_embeddings.sql
```

- [ ] **Step 4: Smoke test SQL**

```sql
INSERT INTO rag_documents (account_id, source, content, content_hash)
VALUES (1, 'test', 'hello world', md5('hello world')) RETURNING id;
-- Verificar: idx_rag_chunks_embedding_cos criado
SELECT indexname FROM pg_indexes WHERE tablename = 'rag_chunks';
```

- [ ] **Step 5: Commit**

```bash
git commit -m "rag: add pgvector migration and schema for documents/chunks"
```

---

### Task 2: Tipos e contratos

**Files:**
- Create: `src/rag/types.ts`

- [ ] **Step 1: Definir interfaces**

```typescript
export interface RagDocument {
  id?: number;
  accountId: number;
  source: string;
  externalId?: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RagChunk {
  id?: number;
  documentId: number;
  accountId: number;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  embedding?: number[];
  embeddingModel?: string;
  metadata?: Record<string, unknown>;
}

export interface RetrievedChunk {
  chunkId: number;
  documentId: number;
  content: string;
  score: number;                  // cosine similarity em [0,1]
  source: string;
  title?: string;
  metadata: Record<string, unknown>;
}

export interface Chunker {
  chunk(content: string, opts?: { maxTokens?: number }): { content: string; tokenCount: number }[];
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  model: string;
  dim: number;
}

export interface VectorStore {
  upsertDocument(doc: RagDocument): Promise<number>;
  replaceChunks(documentId: number, chunks: RagChunk[]): Promise<void>;
  similaritySearch(opts: {
    queryEmbedding: number[];
    accountId: number;
    source?: string | string[];
    topK: number;
    minScore?: number;
  }): Promise<RetrievedChunk[]>;
}

export interface Retriever {
  retrieve(opts: {
    query: string;
    accountId: number;
    source?: string | string[];
    topK?: number;
    minScore?: number;
  }): Promise<RetrievedChunk[]>;
}
```

- [ ] **Step 2: Commit**

---

### Task 3: Chunker recursivo

**Files:**
- Create: `src/rag/chunker.ts`, `tests/unit/rag/chunker.test.ts`

- [ ] **Step 1: Implementar splitter recursivo**

Ordem de split: `\n\n` (parágrafo) → `\n` (linha) → `. ` (frase) → tokens cru.

```typescript
import { estimateTokens } from "../context/tokenizer";
import type { Chunker } from "./types";

const SEPARATORS = ["\n\n", "\n", ". ", " "];
const DEFAULT_MAX_TOKENS = 512;
const OVERLAP_TOKENS = 50;

export class RecursiveChunker implements Chunker {
  chunk(content: string, opts: { maxTokens?: number } = {}): { content: string; tokenCount: number }[] {
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const result: { content: string; tokenCount: number }[] = [];
    this.split(content, maxTokens, 0, result);
    return this.applyOverlap(result, maxTokens);
  }

  private split(text: string, maxTokens: number, sepIndex: number, out: { content: string; tokenCount: number }[]) {
    const tokens = estimateTokens(text);
    if (tokens <= maxTokens) {
      if (text.trim()) out.push({ content: text.trim(), tokenCount: tokens });
      return;
    }
    const sep = SEPARATORS[sepIndex];
    if (!sep) {
      // último recurso: split por chars (proporcional)
      const ratio = maxTokens / tokens;
      const cut = Math.floor(text.length * ratio);
      out.push({ content: text.slice(0, cut), tokenCount: maxTokens });
      this.split(text.slice(cut), maxTokens, 0, out);
      return;
    }
    const parts = text.split(sep);
    let buffer = "";
    for (const p of parts) {
      const tryBuffer = buffer ? buffer + sep + p : p;
      if (estimateTokens(tryBuffer) > maxTokens) {
        if (buffer) {
          this.split(buffer, maxTokens, sepIndex + 1, out);
          buffer = p;
        } else {
          this.split(p, maxTokens, sepIndex + 1, out);
          buffer = "";
        }
      } else {
        buffer = tryBuffer;
      }
    }
    if (buffer) this.split(buffer, maxTokens, sepIndex + 1, out);
  }

  private applyOverlap(chunks: { content: string; tokenCount: number }[], maxTokens: number) {
    // Simples: cada chunk N > 0 ganha últimas ~OVERLAP_TOKENS chars do chunk N-1.
    // (Implementação real: trabalhar em palavras, garantir limite total ≤ maxTokens.)
    return chunks;
  }
}
```

⚠ `estimateTokens` já existe em `src/context/tokenizer.ts` — usa heurística char/4. Mantemos coerência com o resto do projeto.

- [ ] **Step 2: Testes**

```typescript
it("não excede maxTokens", () => {
  const chunks = new RecursiveChunker().chunk(longText, { maxTokens: 100 });
  for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(110); // margem heurística
});
it("preserva conteúdo (concat ≈ original)", () => { /* ... */ });
it("respeita fronteiras de parágrafo quando possível", () => { /* ... */ });
```

- [ ] **Step 3: Commit**

---

### Task 4: Embedder + adapters

**Files:**
- Create: `src/rag/embedder.ts`, `src/integration/llm/adapters/openai-embed.ts`, `src/integration/llm/adapters/gemini-embed.ts`
- Modify: `src/integration/llm-gateway.ts`

- [ ] **Step 1: Estender LLM Gateway**

```typescript
// src/integration/llm-gateway.ts
export interface EmbedRequest {
  inputs: string[];
  model: string;
  meta?: { executionId?: string; accountId?: number; purpose?: string };
}

export interface EmbedResponse {
  provider: string;
  model: string;
  embeddings: number[][];
  usage: { input_tokens: number };
  latency_ms: number;
}

export interface LLMProvider {
  // ... existentes
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}
```

- [ ] **Step 2: OpenAI embed adapter**

```typescript
// src/integration/llm/adapters/openai-embed.ts
export async function openaiEmbed(req: EmbedRequest, apiKey: string): Promise<EmbedResponse> {
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: req.inputs, model: req.model }),
  });
  if (!res.ok) throw new LLMProviderError(`OpenAI embed ${res.status}`, { statusCode: res.status });
  const json = await res.json();
  return {
    provider: "openai",
    model: req.model,
    embeddings: json.data.map((d: { embedding: number[] }) => d.embedding),
    usage: { input_tokens: json.usage.prompt_tokens ?? 0 },
    latency_ms: Date.now() - t0,
  };
}
```

- [ ] **Step 3: Gemini embed adapter** — análogo, endpoint `/v1beta/models/{model}:batchEmbedContents`

- [ ] **Step 4: `Embedder` em `src/rag/embedder.ts`** — fina camada sobre `LLMGateway.embed()` com **cache em DB** por `(model, content_hash)`

```typescript
export class CachingEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  constructor(private gateway: LLMGateway, private db: Pool, opts: { model: string; dim: number }) {
    this.model = opts.model;
    this.dim = opts.dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    // 1. lookup cache: SELECT embedding FROM rag_embedding_cache WHERE model=$1 AND content_hash=ANY($2)
    // 2. batch missing via gateway.embed (max 100 por request)
    // 3. INSERT na cache
    // 4. devolver array na ordem original
  }
}
```

⚠ Tabela `rag_embedding_cache (model TEXT, content_hash TEXT, embedding vector(1536), PRIMARY KEY (model, content_hash))` — adicionar à migration 006.

- [ ] **Step 5: Testes**

```typescript
it("cacheia: 2ª chamada com mesmo texto não chama provider", async () => {
  const provider = mockGateway();
  const emb = new CachingEmbedder(provider, db, { model: "x", dim: 4 });
  await emb.embed(["hello"]);
  await emb.embed(["hello"]);
  expect(provider.embedCalls).toBe(1);
});
```

- [ ] **Step 6: Commit**

---

### Task 5: VectorStore

**Files:**
- Create: `src/rag/vector-store.ts`, `tests/integration/rag/vector-store.integration.test.ts`

- [ ] **Step 1: Implementar**

```typescript
import type { Pool } from "pg";
import type { VectorStore, RagDocument, RagChunk, RetrievedChunk } from "./types";

export class PgVectorStore implements VectorStore {
  constructor(private pool: Pool) {}

  async upsertDocument(doc: RagDocument): Promise<number> {
    const contentHash = sha256(doc.content);
    const r = await this.pool.query<{ id: number }>(
      `INSERT INTO rag_documents (account_id, source, external_id, title, content, content_hash, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, source, external_id)
       DO UPDATE SET content=EXCLUDED.content, content_hash=EXCLUDED.content_hash,
                     title=EXCLUDED.title, metadata=EXCLUDED.metadata, updated_at=NOW()
       RETURNING id`,
      [doc.accountId, doc.source, doc.externalId ?? null, doc.title ?? null,
       doc.content, contentHash, doc.metadata ?? {}],
    );
    return r.rows[0].id;
  }

  async replaceChunks(documentId: number, chunks: RagChunk[]): Promise<void> {
    await this.pool.query("BEGIN");
    try {
      await this.pool.query("DELETE FROM rag_chunks WHERE document_id=$1", [documentId]);
      for (const c of chunks) {
        await this.pool.query(
          `INSERT INTO rag_chunks (document_id, account_id, chunk_index, content, token_count,
                                   embedding, embedding_model, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [documentId, c.accountId, c.chunkIndex, c.content, c.tokenCount,
           c.embedding ? toVectorLiteral(c.embedding) : null,
           c.embeddingModel ?? null, c.metadata ?? {}],
        );
      }
      await this.pool.query("COMMIT");
    } catch (e) {
      await this.pool.query("ROLLBACK");
      throw e;
    }
  }

  async similaritySearch(opts: {
    queryEmbedding: number[]; accountId: number; source?: string | string[];
    topK: number; minScore?: number;
  }): Promise<RetrievedChunk[]> {
    const sources = opts.source ? (Array.isArray(opts.source) ? opts.source : [opts.source]) : null;
    const r = await this.pool.query(
      `SELECT c.id AS chunk_id, c.document_id, c.content, c.metadata,
              d.source, d.title,
              1 - (c.embedding <=> $1::vector) AS score
       FROM rag_chunks c
       JOIN rag_documents d ON d.id = c.document_id
       WHERE c.account_id = $2
         AND ($3::text[] IS NULL OR d.source = ANY($3))
         AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector
       LIMIT $4`,
      [toVectorLiteral(opts.queryEmbedding), opts.accountId, sources, opts.topK],
    );
    const min = opts.minScore ?? 0;
    return r.rows
      .filter((row) => row.score >= min)
      .map((row) => ({
        chunkId: row.chunk_id, documentId: row.document_id,
        content: row.content, score: row.score, source: row.source,
        title: row.title ?? undefined, metadata: row.metadata,
      }));
  }
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
```

⚠ `<=>` é operador cosine distance do pgvector. Score = `1 - distance`.

- [ ] **Step 2: Teste de integração — requer Postgres com pgvector no CI**

```typescript
it("retorna top-K em ordem decrescente de score", async () => {
  // ingestar 5 chunks, query, validar ordem
});
it("filtra por source", async () => { /* ... */ });
it("respeita minScore", async () => { /* ... */ });
```

⚠ Adicionar imagem `pgvector/pgvector:pg16` ao service Postgres do CI (workflow F1).

- [ ] **Step 3: Commit**

---

### Task 6: Retriever (orquestração)

**Files:**
- Create: `src/rag/retriever.ts`, `tests/unit/rag/retriever.test.ts`

- [ ] **Step 1: Implementar**

```typescript
export class RagRetriever implements Retriever {
  constructor(private embedder: Embedder, private store: VectorStore) {}

  async retrieve(opts: {
    query: string; accountId: number; source?: string | string[];
    topK?: number; minScore?: number;
  }): Promise<RetrievedChunk[]> {
    const topK = opts.topK ?? 5;
    const [embedding] = await this.embedder.embed([opts.query]);
    return this.store.similaritySearch({
      queryEmbedding: embedding,
      accountId: opts.accountId,
      source: opts.source,
      topK,
      minScore: opts.minScore,
    });
  }
}
```

- [ ] **Step 2: Span OTEL (se F4 mergeada)**

```typescript
return withSpan("rag.retrieve", {
  "rag.account_id": opts.accountId,
  "rag.top_k": topK,
  "rag.source": Array.isArray(opts.source) ? opts.source.join(",") : opts.source,
}, async (span) => {
  const results = await /* ... */;
  span.setAttribute("rag.results_count", results.length);
  span.setAttribute("rag.top_score", results[0]?.score ?? 0);
  return results;
});
```

- [ ] **Step 3: Testes com mocks**

- [ ] **Step 4: Commit**

---

### Task 7: Refatorar `search-faq` para usar Retriever

**Files:**
- Modify: `src/tools/knowledge/search-faq.tool.ts`

- [ ] **Step 1: Substituir lógica trigram por Retriever**

```typescript
export const searchFaqTool: ToolDefinition = {
  name: "search-faq",
  description: "Search the FAQ using semantic vector similarity.",
  category: "knowledge",
  agentType: "surface",
  parameters: { /* ... mantido ... */ },
  async execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult> {
    const p = params as SearchFaqParams;
    if (!p.query) return { success: false, error: "INVALID_PARAMS", detail: "query is required" };
    const limit = Math.min(Math.max(p.limit ?? 5, 1), 20);

    try {
      const retriever = context.deps?.retriever as Retriever | undefined;
      if (!retriever) {
        // Fallback: degrade para empty se RAG não disponível
        return { success: true, data: { results: [], degraded: true } };
      }
      const chunks = await retriever.retrieve({
        query: p.query,
        accountId: context.accountId,
        source: "faq",
        topK: limit,
        minScore: 0.5,
      });
      return {
        success: true,
        data: {
          results: chunks.map((c) => ({
            id: c.chunkId,
            content: c.content,
            score: c.score,
            title: c.title,
          })),
        },
      };
    } catch (err) {
      return { success: false, error: "RAG_FAILURE", detail: (err as Error).message };
    }
  },
};
```

⚠ Injeção: `context.deps.retriever` é populado em bootstrap (`load-tools-permissions` stage). Sem `retriever`, tool retorna `degraded: true` em vez de quebrar.

- [ ] **Step 2: Atualizar bootstrap para injetar Retriever**

```typescript
// src/bootstrap/stages.ts no estágio load-tools-permissions ou stage novo init-rag
const embedder = new CachingEmbedder(gateway, db, {
  model: env.RAG_EMBEDDING_MODEL,
  dim: env.RAG_EMBEDDING_DIM,
});
const store = new PgVectorStore(db);
const retriever = new RagRetriever(embedder, store);
context.deps.retriever = retriever;
```

- [ ] **Step 3: Atualizar testes existentes de `search-faq`**

⚠ Testes atuais usam SQL real com tabela `faq`. Migrar para mock de `Retriever` ou criar fixtures em `rag_chunks`.

- [ ] **Step 4: Commit**

```bash
git commit -m "rag: migrate search-faq to vector retrieval"
```

---

### Task 8: CLI de ingestão

**Files:**
- Create: `src/rag/cli/ingest.ts`
- Modify: `package.json`

- [ ] **Step 1: Implementar CLI**

```typescript
// src/rag/cli/ingest.ts
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Pool } from "pg";
import { getEnv } from "../../config/env";
import { LLMGateway } from "../../integration/llm-gateway";
import { CachingEmbedder } from "../embedder";
import { PgVectorStore } from "../vector-store";
import { RecursiveChunker } from "../chunker";

const argsSchema = z.object({
  source: z.string(),         // path ou URL
  account: z.coerce.number().int(),
  sourceTag: z.string().default("faq"),
  dryRun: z.coerce.boolean().default(false),
});

async function main() {
  const args = argsSchema.parse(parseArgs(process.argv));
  const env = getEnv();
  const db = new Pool({ connectionString: env.DATABASE_URL });
  const gateway = /* construir */;
  const embedder = new CachingEmbedder(gateway, db, { model: env.RAG_EMBEDDING_MODEL, dim: env.RAG_EMBEDDING_DIM });
  const store = new PgVectorStore(db);
  const chunker = new RecursiveChunker();

  const files = await loadFiles(args.source);
  for (const f of files) {
    const content = await fs.readFile(f, "utf8");
    const docId = await store.upsertDocument({
      accountId: args.account,
      source: args.sourceTag,
      externalId: path.basename(f),
      title: extractTitle(content),
      content,
    });
    const chunks = chunker.chunk(content);
    const embeddings = args.dryRun ? chunks.map(() => null) : await embedder.embed(chunks.map((c) => c.content));
    await store.replaceChunks(docId, chunks.map((c, i) => ({
      documentId: docId,
      accountId: args.account,
      chunkIndex: i,
      content: c.content,
      tokenCount: c.tokenCount,
      embedding: embeddings[i] ?? undefined,
      embeddingModel: env.RAG_EMBEDDING_MODEL,
    })));
    console.warn(`ingested ${f}: doc=${docId} chunks=${chunks.length}`);
  }
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Scripts**

```json
"rag:ingest": "tsx src/rag/cli/ingest.ts",
"rag:reembed": "tsx src/rag/cli/reembed.ts"
```

- [ ] **Step 3: Smoke**

```bash
npm run rag:ingest -- --source ./fixtures/faq.md --account 1 --sourceTag faq
psql $DATABASE_URL -c "SELECT count(*) FROM rag_chunks WHERE account_id=1;"
```

- [ ] **Step 4: Commit**

---

### Task 9: CLI de re-embed (model upgrade)

**Files:**
- Create: `src/rag/cli/reembed.ts`

- [ ] **Step 1: Implementar — re-gera embeddings para chunks com `embedding_model` diferente do default**

⚠ Útil quando troca o modelo de embedding (ex: `text-embedding-3-small` → `text-embedding-3-large`). Batching obrigatório (100 textos por chamada provider).

```typescript
async function reembed(accountId?: number, source?: string) {
  // SELECT id, content FROM rag_chunks
  //  WHERE (embedding IS NULL OR embedding_model != $target_model)
  //    AND (account_id = $accountId OR $accountId IS NULL)
  //    AND ($source IS NULL OR ...)
  //  ORDER BY id
  // process em batches de 100
  // UPDATE rag_chunks SET embedding=$1, embedding_model=$2 WHERE id=$3
}
```

- [ ] **Step 2: Flag `--dry-run`** — só conta quantos chunks seriam re-embedados

- [ ] **Step 3: Commit**

---

### Task 10: Env vars + bootstrap

**Files:**
- Modify: `src/config/env.ts`, `src/bootstrap/stages.ts`

- [ ] **Step 1: Env**

```typescript
RAG_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
RAG_EMBEDDING_DIM: z.coerce.number().int().default(1536),
RAG_TOP_K_DEFAULT: z.coerce.number().int().default(5),
RAG_MIN_SCORE: z.coerce.number().default(0.5),
```

- [ ] **Step 2: Stage `init-rag`** (opcional — pode inline em `load-tools-permissions`)

```typescript
export function initRagStage(): Stage {
  return {
    name: "init-rag",
    async run(ctx) {
      const env = getEnv();
      const embedder = new CachingEmbedder(ctx.deps.llmGateway, ctx.deps.db, {
        model: env.RAG_EMBEDDING_MODEL, dim: env.RAG_EMBEDDING_DIM,
      });
      const store = new PgVectorStore(ctx.deps.db);
      ctx.deps.retriever = new RagRetriever(embedder, store);
    },
  };
}
```

⚠ Validar dim contra modelo: se `RAG_EMBEDDING_MODEL=gemini-embedding-001` mas `RAG_EMBEDDING_DIM=1536`, falhar bootstrap.

- [ ] **Step 3: Health check** — opcional ping `SELECT 1::vector(3)` para validar pgvector

- [ ] **Step 4: Commit**

---

### Task 11: Documentação

**Files:**
- Create: `docs/architecture/rag.md`
- Modify: `README.md`

- [ ] **Step 1: `docs/architecture/rag.md`**

Conteúdo: visão geral, schema, fluxo (ingest → embed → store → retrieve), modelos suportados, decisão de dimensão única, custos por 1M tokens, troubleshooting (índice ivfflat lento → REINDEX, lists baixo demais).

- [ ] **Step 2: README** — seção "RAG" com exemplos de CLI

- [ ] **Step 3: Commit**

---

### Task 12: Validação E2E + PR

- [ ] **Step 1: Cenários**

1. `npm run rag:ingest -- --source fixtures/faq.md --account 1` → chunks aparecem no DB com embeddings
2. Disparar execução com query "como faço refund" → tool `search-faq` retorna chunks relevantes (score > 0.5)
3. Comparar antes/depois: query semântica ("retornar produto") encontra "refund" sem keyword match
4. `npm run rag:reembed --dry-run` mostra contagem correta
5. `OPENAI_API_KEY` inválida → erro classificado `auth` (com F4) ou erro genérico (sem F4)

- [ ] **Step 2: Performance**

```bash
# 10k chunks ingeridos, medir latência de retrieval
EXPLAIN ANALYZE SELECT ... ORDER BY embedding <=> $1::vector LIMIT 5;
```
Expected: < 50ms com IVFFlat lists=100. Se > 200ms, aumentar lists ou trocar para HNSW.

- [ ] **Step 3: PR**

```bash
git push origin HEAD:sprint-d-2-rag-pgvector
gh pr create --title "Sprint D.2: RAG with pgvector" --body-file docs/superpowers/plans/2026-05-14-sprint-d-2-rag-pgvector.md
```

---

## Definition of Done

- ✅ Extensão `pgvector` ativa; tabelas `rag_documents`, `rag_chunks`, `rag_embedding_cache` criadas
- ✅ Embedder funcional com cache (cache hit em 2ª chamada confirmado em teste)
- ✅ VectorStore retorna top-K com filtros (source, account, minScore)
- ✅ `search-faq` usa Retriever; fallback `degraded: true` se RAG indisponível
- ✅ CLI `rag:ingest` ingere markdown/txt com chunking + embedding
- ✅ CLI `rag:reembed` re-gera embeddings com dry-run
- ✅ Spans OTEL `rag.retrieve`/`rag.embed` aparecem (se F4 mergeada)
- ✅ Teste integração com pgvector roda no CI (imagem `pgvector/pgvector:pg16`)
- ✅ Docs publicados (`docs/architecture/rag.md` + README)

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| pgvector indisponível em Postgres do cliente | Validar com DBA antes de mergear; ter fallback em `search-faq` para `degraded: true`; documentar requisito |
| Custo recorrente de embeddings | Cache obrigatório por `(model, content_hash)`; batch em ingest (100 textos/chamada); evitar re-embed em conteúdo idêntico |
| Latência de retrieval com muitos chunks | IVFFlat com `lists=100` (escalar para `sqrt(N)`); considerar HNSW se Postgres ≥ 16 e pgvector ≥ 0.5; cap `topK ≤ 20` |
| Drift de embedding model | Coluna `embedding_model` em `rag_chunks` + CLI `reembed`; bloquear retrieval cross-model (filtro `embedding_model=$current`) |
| Dimensão fixa em schema (1536) | Decisão consciente: single-model. Troca de dim exige migration nova + reembed completo. Documentado |
| Vazamento cross-account em retrieval | `account_id` é cláusula obrigatória em `similaritySearch`; teste de regressão valida isolamento |
| Falha LLM em ingest CLI | CLI faz commit por documento (não em batch grande); retomar de onde parou via `external_id` UNIQUE |
| Conflito com F5 em `llm-gateway.ts` | Coordenar: D.2 adiciona `embed()` puro; F5 envolve em decorators (retry/circuit/usage) — composição linear sem reescrita |

---

## Correções Pós-Review (2026-05-14)

Aplicadas após review automatizado. Consultar [INDEX](./2026-05-14-INDEX-bevox-2.0-sprints.md#correções-pós-review-2026-05-14) para decisões globais.

### Critical
- **Task 0 (nova)** — Husky no-verify (G.6) prerequisito.
- **Migration `006_rag_embeddings.sql`** — Confirmada via G.1 (reserva canônica). NÃO renumerar para 004 (que vai pra A.2). 004 reservado para A.2 (eval_results), 005 para C.1 (workflow_state), 006 para D.2.
- **`rag_embedding_cache` na migration** — Adicionar SQL:
  ```sql
  CREATE TABLE rag_embedding_cache (
    model TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding vector(1536) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (model, content_hash)
  );
  ```
- **`LLMEmbedder` interface separada (G.10)** — NÃO estender `LLMGateway.complete()`. Criar `src/integration/llm/embedder.ts` com interface `LLMEmbedder { embed(text|texts): Promise<EmbedResponse> }` e adapters próprios para OpenAI/Gemini. Anthropic não tem embedding API (documentar explicitamente). Factory `createLLMEmbedder()` paralelo a `createLLMGateway()`.
- **HNSW em vez de IVFFlat (G.9)** — Substituir `CREATE INDEX ... USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)` por `USING hnsw (embedding vector_cosine_ops)`. Sem treino, qualidade independe de tamanho. pgvector ≥ 0.5 suporta.
- **CREATE EXTENSION privilege** — Pré-flight check `SELECT 1 FROM pg_extension WHERE extname='vector'` antes da migration. Documentar passo manual `CREATE EXTENSION vector` rodado por DBA (managed Postgres pode exigir aprovação).

### Important
- **`account_id` row-level security note** — `similaritySearch` é única API que toca `rag_chunks`, `accountId` obrigatório (não opcional). Adicionar `NOT NULL` check no início + teste de regressão "buscar sem accountId → throw".
- **Chunker `applyOverlap`** — Implementar (com bibliografia LangChain Recursive splitter) ou remover do escopo. Sem overlap, queries em fronteiras perdem contexto.
- **`estimateTokens` heurístico** — Documentar em `docs/architecture/rag.md` que char/4 é heurística, não billing-grade.
- **`search-faq` backward compat** — Tool result schema muda (`id` agora é chunkId). Adicionar Task: validar consumers downstream + versionar (`schema_version: 2`).
- **CLI sub-bootstrap mínimo** — `rag:ingest` NÃO inicia bootstrap completo (sem BullMQ consumer, sem Calendar health). Adicionar em Task 8: sub-bootstrap (env + db + embedder).
- **Multi-dim guard** — Runtime check em bootstrap: `if (embedDim !== 1536) throw` até migration multi-dim existir.

### Nitpick
- Task 5 `replaceChunks` — Usar `pool.connect()` explicitamente para transação consistente.
- CLI logging — Usar Pino em vez de `console.warn/error`.
- Task 11 doc — `docs/architecture/rag.md` vs bevox-knowledge SoT: verificar política (memory `project_bevox_knowledge_sot.md`).
