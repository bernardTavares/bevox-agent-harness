# Sprint D.3: Semantic Memory + Observational Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estender o memory layer do harness com dois novos comportamentos: (1) **Semantic Recall** — dado o contexto da execução atual, buscar mensagens históricas semanticamente similares do mesmo `contact_id` para enriquecer o prompt; (2) **Observational Memory** — pipeline agent novo (`memory-condenser`) que roda em background e condensa mensagens antigas em "memory summaries" persistidos em `contact_facts`, prevenindo context overflow em conversas longas. Inspirado em Mastra Memory (Working/Semantic/Observational).

**Architecture:** Reusa a infra RAG de D.2 (`Embedder`, `VectorStore`, `Retriever`) aplicada sobre tabela nova `message_embeddings` que indexa mensagens históricas por `account_id + contact_id`. O `MemoryLayer` ganha duas seções extras: "Memórias semanticamente relevantes" (top-K mensagens similares à query) e "Resumo de interações passadas" (`contact_facts` com `category='summary'`). O pipeline agent `memory-condenser` é enfileirado pelo `execution-handler` em uma fila BullMQ separada (`harness.memory.condense`) quando heurísticas indicam (N mensagens novas desde último condense, OU contexto excedeu M tokens). O agent usa `LLMGateway` direto com engine `direct` e prompt específico para extrair summary, depois grava em `contact_facts`.

**Tech Stack:** PostgreSQL 16 + pgvector (de D.2), BullMQ 5 (já no projeto), `LLMGateway` (existente), Pino. Sem dep nova.

---

## Dependencies

- **Hard:**
  - **Sprint D.2 (RAG com pgvector) MERGEADA** — D.3 reusa `Embedder`, `VectorStore`, `Retriever`, extensão pgvector, padrão de migration de embeddings, CLI de reembed.
  - Migration 001 (`contact_facts` existente).
- **Soft:**
  - Fase 4 (Observability) — spans `memory.semantic_recall`, `memory.condense.*` enriquecem traces.
  - Fase 5 (LLM resilience) — embeddings e LLM calls do condenser pegam retry/circuit grátis.
- **Blocks:** Nada.
- **Conflitos potenciais:**
  - `src/context/layers/memory.layer.ts` — adição de duas seções (extension, não breaking se cuidadoso com token budget)
  - `src/runtime/execution-handler.ts` — hook de enqueue do condenser (delta pequeno)
  - `src/bootstrap/stages.ts` — registrar pipeline agent novo + worker secundário (opcional)

## Files Touched

### Create
- `src/memory/semantic-recall.ts` (interface `SemanticRecall` + impl `RagSemanticRecall`)
- `src/memory/observational-condenser.ts` (orquestrador: decide quando condensar)
- `src/memory/message-embedding-indexer.ts` (indexa mensagens novas em `message_embeddings`)
- `src/memory/condense-heuristics.ts` (regras: N mensagens novas, M tokens, T tempo)
- `src/agents/pipeline/memory-condenser.agent.ts` (AgentDefinition + factory)
- `src/agents/pipeline/memory-condenser.prompt.ts` (system + user templates)
- `src/integration/condense-queue.ts` (BullMQ consumer secundário para `harness.memory.condense`)
- `migrations/007_message_embeddings.sql`
- `tests/unit/memory/semantic-recall.test.ts`
- `tests/unit/memory/observational-condenser.test.ts`
- `tests/unit/memory/condense-heuristics.test.ts`
- `tests/unit/agents/pipeline/memory-condenser.agent.test.ts`
- `tests/integration/memory/semantic-recall.integration.test.ts`

### Modify
- ⚠️ `src/context/layers/memory.layer.ts` — adicionar seções `## Memórias semanticamente relevantes` e `## Resumo de interações passadas`
- `src/memory/contact-facts.repository.ts` — método `findSummaries(accountId, contactId)` para retornar summaries (`category='summary'`)
- `src/runtime/execution-handler.ts` — após callback complete, enfileirar condense job (fire-and-forget)
- `src/bootstrap/stages.ts` — registrar `memory-condenser` agent, opcionalmente startar condense worker
- `src/config/env.ts` — vars `MEMORY_CONDENSE_THRESHOLD_MESSAGES`, `MEMORY_CONDENSE_THRESHOLD_TOKENS`, `MEMORY_SEMANTIC_RECALL_TOP_K`, `MEMORY_CONDENSE_ENABLED`
- `package.json` — script `worker:condense` (worker dedicado)

### High-conflict files
- ⚠️ `src/context/layers/memory.layer.ts` — coração desta entrega
- ⚠️ `src/runtime/execution-handler.ts` — toca o end-of-flow (após callback complete)

## Estimated Effort
2 semanas (~50-60 horas), sobre a base D.2 mergeada.

---

## Tasks

### Task 1: Migration — `message_embeddings`

**Files:**
- Create: `migrations/007_message_embeddings.sql`

- [ ] **Step 1: Decidir entre estender `message_classifications` ou tabela nova**

Decisão: **tabela nova** `message_embeddings`. Razão: `message_classifications` tem ciclo de vida diferente (gera só com pipeline analyzer), e embeddings podem ser regenerados independentemente.

- [ ] **Step 2: `migrations/007_message_embeddings.sql`**

```sql
-- UP
-- pgvector já criado pela migration 006

CREATE TABLE message_embeddings (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL,
  message_id TEXT NOT NULL,              -- id externo (vindo do Bevox payload)
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  embedding vector(1536),
  embedding_model TEXT,
  message_at TIMESTAMPTZ NOT NULL,        -- timestamp original da mensagem
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_by_summary_fact_id BIGINT REFERENCES contact_facts(id) ON DELETE SET NULL,
  UNIQUE (account_id, contact_id, message_id)
);

CREATE INDEX idx_message_embeddings_contact ON message_embeddings(account_id, contact_id, message_at DESC);
CREATE INDEX idx_message_embeddings_active ON message_embeddings(account_id, contact_id)
  WHERE superseded_by_summary_fact_id IS NULL;
CREATE INDEX idx_message_embeddings_embedding_cos
  ON message_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Coluna em contact_facts para marcar summaries gerados por condenser
-- (se ainda não existir; verificar migration 001)
-- Idempotente:
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contact_facts' AND column_name='source_agent'
  ) THEN
    ALTER TABLE contact_facts ADD COLUMN source_agent TEXT;
  END IF;
END $$;

-- DOWN
DROP INDEX IF EXISTS idx_message_embeddings_embedding_cos;
DROP INDEX IF EXISTS idx_message_embeddings_active;
DROP INDEX IF EXISTS idx_message_embeddings_contact;
DROP TABLE IF EXISTS message_embeddings;
-- NÃO reverter ALTER em contact_facts (pode quebrar dados)
```

⚠ `superseded_by_summary_fact_id` — quando condenser gera summary, marca mensagens cobertas para que retrieval futuro priorize o summary, não as mensagens cruas. Mantemos raw para auditoria.

- [ ] **Step 3: Rodar migration**

```bash
psql $DATABASE_URL -f migrations/007_message_embeddings.sql
```

- [ ] **Step 4: Commit**

---

### Task 2: Indexer de mensagens

**Files:**
- Create: `src/memory/message-embedding-indexer.ts`

- [ ] **Step 1: Implementar**

```typescript
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import type { Embedder } from "../rag/types";
import { estimateTokens } from "../context/tokenizer";

export interface IndexableMessage {
  messageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  messageAt: Date;
}

export class MessageEmbeddingIndexer {
  constructor(private db: Pool, private embedder: Embedder) {}

  async index(accountId: number, contactId: number, messages: IndexableMessage[]): Promise<number> {
    if (messages.length === 0) return 0;

    // 1. Filtrar mensagens já indexadas (por content_hash)
    const hashes = messages.map((m) => sha256(m.content));
    const existing = await this.db.query<{ message_id: string }>(
      `SELECT message_id FROM message_embeddings
       WHERE account_id=$1 AND contact_id=$2 AND content_hash = ANY($3)`,
      [accountId, contactId, hashes],
    );
    const existingIds = new Set(existing.rows.map((r) => r.message_id));
    const toIndex = messages.filter((m) => !existingIds.has(m.messageId));
    if (toIndex.length === 0) return 0;

    // 2. Embed em batch
    const embeddings = await this.embedder.embed(toIndex.map((m) => m.content));

    // 3. Insert
    for (let i = 0; i < toIndex.length; i++) {
      const m = toIndex[i];
      await this.db.query(
        `INSERT INTO message_embeddings
           (account_id, contact_id, message_id, role, content, content_hash,
            token_count, embedding, embedding_model, message_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (account_id, contact_id, message_id) DO NOTHING`,
        [accountId, contactId, m.messageId, m.role, m.content, sha256(m.content),
         estimateTokens(m.content), toVectorLiteral(embeddings[i]),
         this.embedder.model, m.messageAt],
      );
    }
    return toIndex.length;
  }
}
```

- [ ] **Step 2: Hook no `execution-handler.ts`**

Após callback complete (assíncrono, fire-and-forget):

```typescript
// no fim de handleExecution, após callback success:
queueMicrotask(async () => {
  try {
    await ctx.deps.messageIndexer.index(accountId, contactId, payload.messages.map((m) => ({
      messageId: m.id ?? generateId(m),
      role: m.role,
      content: m.content,
      messageAt: new Date(m.timestamp ?? Date.now()),
    })));
  } catch (e) {
    log.warn({ err: e }, "message indexer failed (non-fatal)");
  }
});
```

⚠ Importante: **non-fatal**. Falha de indexação não bloqueia execução. Considerar mover para BullMQ se latência impactar.

- [ ] **Step 3: Testes**

```typescript
it("não re-indexa conteúdo idêntico", async () => { /* ... */ });
it("respeita unique (account, contact, message_id)", async () => { /* ... */ });
```

- [ ] **Step 4: Commit**

---

### Task 3: Semantic Recall

**Files:**
- Create: `src/memory/semantic-recall.ts`, `tests/unit/memory/semantic-recall.test.ts`

- [ ] **Step 1: Interface e impl**

```typescript
import type { Pool } from "pg";
import type { Embedder } from "../rag/types";

export interface RecalledMessage {
  messageId: string;
  role: string;
  content: string;
  score: number;
  messageAt: Date;
}

export interface SemanticRecall {
  recall(opts: {
    query: string;
    accountId: number;
    contactId: number;
    topK?: number;
    minScore?: number;
    excludeRecent?: number;     // skip últimas N (já no histórico cronológico)
  }): Promise<RecalledMessage[]>;
}

export class RagSemanticRecall implements SemanticRecall {
  constructor(private db: Pool, private embedder: Embedder) {}

  async recall(opts: {
    query: string; accountId: number; contactId: number;
    topK?: number; minScore?: number; excludeRecent?: number;
  }): Promise<RecalledMessage[]> {
    const topK = opts.topK ?? 5;
    const minScore = opts.minScore ?? 0.6;
    const [emb] = await this.embedder.embed([opts.query]);

    const r = await this.db.query<{
      message_id: string; role: string; content: string;
      score: number; message_at: Date;
    }>(
      `WITH ranked AS (
         SELECT message_id, role, content, message_at,
                ROW_NUMBER() OVER (ORDER BY message_at DESC) AS recency_rank
         FROM message_embeddings
         WHERE account_id=$1 AND contact_id=$2 AND superseded_by_summary_fact_id IS NULL
       )
       SELECT me.message_id, me.role, me.content, me.message_at,
              1 - (me.embedding <=> $3::vector) AS score
       FROM message_embeddings me
       JOIN ranked r USING (message_id)
       WHERE me.account_id=$1 AND me.contact_id=$2
         AND me.superseded_by_summary_fact_id IS NULL
         AND r.recency_rank > $4
         AND me.embedding IS NOT NULL
       ORDER BY me.embedding <=> $3::vector
       LIMIT $5`,
      [opts.accountId, opts.contactId, toVectorLiteral(emb),
       opts.excludeRecent ?? 10, topK],
    );

    return r.rows
      .filter((row) => row.score >= minScore)
      .map((row) => ({
        messageId: row.message_id,
        role: row.role,
        content: row.content,
        score: row.score,
        messageAt: row.message_at,
      }));
  }
}
```

⚠ `excludeRecent` evita duplicar com o histórico cronológico que já está em outra layer.

- [ ] **Step 2: Span OTEL**

```typescript
return withSpan("memory.semantic_recall", {
  "memory.account_id": opts.accountId,
  "memory.contact_id": opts.contactId,
  "memory.top_k": topK,
}, async (span) => {
  // ...
  span.setAttribute("memory.recalled_count", results.length);
  return results;
});
```

- [ ] **Step 3: Testes**

```typescript
it("retorna mensagens semanticamente similares acima de minScore", async () => {});
it("exclui mensagens recentes (excludeRecent)", async () => {});
it("ignora mensagens superseded_by_summary_fact_id IS NOT NULL", async () => {});
```

- [ ] **Step 4: Commit**

---

### Task 4: Estender `MemoryLayer`

**Files:**
- Modify: `src/context/layers/memory.layer.ts`, `src/memory/contact-facts.repository.ts`

- [ ] **Step 1: Adicionar dep injection**

```typescript
export class MemoryLayer implements ContextLayer {
  constructor(
    private readonly db: Pool,
    private readonly semanticRecall?: SemanticRecall,    // opcional: degrade se ausente
    private readonly factsRepo?: ContactFactsRepository,
  ) {}
}
```

- [ ] **Step 2: Em `build()`, adicionar duas seções após as existentes**

⚠ Respeitar token budget: ler `input.tokenBudget` (já existe no `ContextInput`). Se budget restante < 200 tokens, pular semantic recall.

```typescript
async build(input: ContextInput): Promise<ContextBlock> {
  // ... lógica existente: profile + facts → seções "Informações do contato" e "Fatos"
  const sections: string[] = [profileSection, factsSection];

  // Nova seção 1: Resumo de interações passadas (summaries de contact_facts)
  if (this.factsRepo) {
    const summaries = await this.factsRepo.findSummaries(input.accountId, input.contactId);
    if (summaries.length > 0) {
      sections.push("## Resumo de interações passadas");
      for (const s of summaries) {
        sections.push(`- (${s.coversPeriod ?? "período"}) ${s.fact_value}`);
      }
    }
  }

  // Nova seção 2: Memórias semanticamente relevantes
  if (this.semanticRecall && input.userMessage) {
    const recalled = await this.semanticRecall.recall({
      query: input.userMessage,
      accountId: input.accountId,
      contactId: input.contactId,
      topK: 5,
      minScore: 0.6,
      excludeRecent: 10,
    });
    if (recalled.length > 0) {
      sections.push("## Memórias semanticamente relevantes");
      for (const m of recalled) {
        sections.push(`- [${m.messageAt.toISOString().slice(0,10)}] (${m.role}, score ${m.score.toFixed(2)}): ${truncate(m.content, 200)}`);
      }
    }
  }

  const content = sections.join("\n\n");
  return {
    section: "## Informações do contato",
    content,
    tokenEstimate: estimateTokens(content),
    priority: this.priority,
    compressible: this.compressible,
  };
}
```

⚠ `input.userMessage` — verificar se `ContextInput` já tem; se não, adicionar (compatível, opcional).

- [ ] **Step 3: `contact-facts.repository.ts`** — método `findSummaries`

```typescript
async findSummaries(accountId: number, contactId: number): Promise<ContactFact[]> {
  const r = await this.pool.query<ContactFactRow>(
    `SELECT * FROM contact_facts
     WHERE account_id=$1 AND contact_id=$2 AND category='summary'
       AND superseded_by IS NULL
     ORDER BY extracted_at DESC
     LIMIT 5`,
    [accountId, contactId],
  );
  return r.rows.map(mapRow);
}
```

- [ ] **Step 4: Testes atualizados**

⚠ Testes existentes de `memory.layer.test.ts` precisam de mocks para `semanticRecall` e `factsRepo`. Quando `undefined`, comportamento idêntico ao atual (regressão zero).

- [ ] **Step 5: Commit**

---

### Task 5: Heurísticas de condensação

**Files:**
- Create: `src/memory/condense-heuristics.ts`, `tests/unit/memory/condense-heuristics.test.ts`

- [ ] **Step 1: Lógica pura**

```typescript
export interface CondenseSignal {
  shouldCondense: boolean;
  reason?: "messages_threshold" | "tokens_threshold" | "time_threshold";
  messageIdsToCondense: string[];
}

export interface CondenseHeuristicInput {
  accountId: number;
  contactId: number;
  newMessagesSinceLastCondense: { messageId: string; tokenCount: number; messageAt: Date }[];
  lastCondenseAt?: Date;
  config: {
    thresholdMessages: number;       // e.g. 50
    thresholdTokens: number;         // e.g. 8000
    thresholdDays?: number;          // e.g. 7
  };
}

export function evaluateCondenseSignal(input: CondenseHeuristicInput): CondenseSignal {
  const { newMessagesSinceLastCondense: msgs, config, lastCondenseAt } = input;

  if (msgs.length >= config.thresholdMessages) {
    return { shouldCondense: true, reason: "messages_threshold",
             messageIdsToCondense: msgs.map((m) => m.messageId) };
  }

  const totalTokens = msgs.reduce((acc, m) => acc + m.tokenCount, 0);
  if (totalTokens >= config.thresholdTokens) {
    return { shouldCondense: true, reason: "tokens_threshold",
             messageIdsToCondense: msgs.map((m) => m.messageId) };
  }

  if (config.thresholdDays && lastCondenseAt) {
    const daysAgo = (Date.now() - lastCondenseAt.getTime()) / 86400000;
    if (daysAgo >= config.thresholdDays && msgs.length > 5) {
      return { shouldCondense: true, reason: "time_threshold",
               messageIdsToCondense: msgs.map((m) => m.messageId) };
    }
  }

  return { shouldCondense: false, messageIdsToCondense: [] };
}
```

- [ ] **Step 2: Testes exaustivos**

```typescript
describe("evaluateCondenseSignal", () => {
  it("triggers on messages threshold", () => {});
  it("triggers on tokens threshold", () => {});
  it("triggers on time threshold but only with min 5 msgs", () => {});
  it("does not trigger when below all thresholds", () => {});
});
```

- [ ] **Step 3: Commit**

---

### Task 6: Pipeline agent `memory-condenser`

**Files:**
- Create: `src/agents/pipeline/memory-condenser.agent.ts`, `src/agents/pipeline/memory-condenser.prompt.ts`

- [ ] **Step 1: Prompt template**

```typescript
// src/agents/pipeline/memory-condenser.prompt.ts
export const SYSTEM_PROMPT = `Você é um agente de condensação de memória. Sua tarefa é ler N mensagens entre um cliente e um assistente, e extrair:

1. RESUMO factual conciso (≤ 300 caracteres) cobrindo o período
2. FATOS chave novos sobre o contato (preferências, restrições, decisões tomadas, datas importantes)

Regras:
- Preserve TODOS os fatos críticos (datas, valores, decisões, compromissos)
- Não invente. Se não souber, omita.
- Linguagem: mesma do diálogo (PT-BR default).
- Devolva JSON estrito: { "summary": "...", "facts": [{ "key": "...", "value": "...", "category": "..." }] }
- categoria ∈ {personal, preference, restriction, history, decision, contact}.`;

export function buildUserPrompt(messages: { role: string; content: string; messageAt: Date }[]): string {
  return `Mensagens (${messages.length}, ${messages[0].messageAt.toISOString().slice(0,10)} → ${messages.at(-1)!.messageAt.toISOString().slice(0,10)}):\n\n` +
    messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
}
```

- [ ] **Step 2: AgentDefinition**

```typescript
// src/agents/pipeline/memory-condenser.agent.ts
import { z } from "zod";
import type { AgentDefinition } from "../types";

const condenseOutputSchema = z.object({
  summary: z.string().max(500),
  facts: z.array(z.object({
    key: z.string(),
    value: z.string(),
    category: z.enum(["personal", "preference", "restriction", "history", "decision", "contact"]),
  })).max(20),
});

export const memoryCondenserAgent: AgentDefinition = {
  name: "memory-condenser",
  type: "pipeline",
  description: "Condensa mensagens antigas em summary + facts; popula contact_facts.",
  reasoning: { default: "direct" },
  permissions: { required: [], denied: [] },
};

export async function runMemoryCondenser(input: {
  accountId: number;
  contactId: number;
  messages: { messageId: string; role: string; content: string; messageAt: Date }[];
  deps: {
    llmGateway: LLMGateway;
    factsRepo: ContactFactsRepository;
    db: Pool;
  };
}): Promise<{ summaryFactId: number; factsCreated: number }> {
  const res = await input.deps.llmGateway.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input.messages) },
    ],
    model: getEnv().DEFAULT_LLM_MODEL,
    responseFormat: "json_object",
    meta: { accountId: input.accountId, purpose: "memory-condenser" },
  });
  const parsed = condenseOutputSchema.parse(JSON.parse(res.content!));

  // 1. Persistir summary como contact_fact category='summary'
  const summaryFact = await input.deps.factsRepo.create({
    accountId: input.accountId,
    contactId: input.contactId,
    factKey: `summary:${input.messages[0].messageAt.toISOString().slice(0,10)}_${input.messages.at(-1)!.messageAt.toISOString().slice(0,10)}`,
    factValue: parsed.summary,
    category: "summary",
    confidence: "high",
    confirmed: false,
    sourceAgent: "memory-condenser",
  });

  // 2. Persistir facts extraídos
  let count = 0;
  for (const f of parsed.facts) {
    await input.deps.factsRepo.create({
      accountId: input.accountId,
      contactId: input.contactId,
      factKey: f.key,
      factValue: f.value,
      category: f.category,
      confidence: "medium",
      confirmed: false,
      sourceAgent: "memory-condenser",
    });
    count++;
  }

  // 3. Marcar mensagens cobertas com superseded_by_summary_fact_id
  await input.deps.db.query(
    `UPDATE message_embeddings
     SET superseded_by_summary_fact_id=$1
     WHERE account_id=$2 AND contact_id=$3 AND message_id = ANY($4)`,
    [summaryFact.id, input.accountId, input.contactId, input.messages.map((m) => m.messageId)],
  );

  return { summaryFactId: summaryFact.id, factsCreated: count };
}
```

⚠ Mensagens **não são deletadas**. Apenas marcadas como "supersedidas" — retrieval semântico passa a ignorá-las, mas auditoria preserva tudo.

- [ ] **Step 3: Testes com LLMGateway mock**

```typescript
it("parseia output JSON e persiste summary + facts", async () => {});
it("marca message_embeddings.superseded_by_summary_fact_id", async () => {});
it("falha gracioso se LLM retorna JSON inválido", async () => {});
```

- [ ] **Step 4: Commit**

---

### Task 7: Observational Condenser orchestrator

**Files:**
- Create: `src/memory/observational-condenser.ts`

- [ ] **Step 1: Implementar**

```typescript
export class ObservationalCondenser {
  constructor(
    private db: Pool,
    private heuristicConfig: { thresholdMessages: number; thresholdTokens: number; thresholdDays?: number },
    private runner: typeof runMemoryCondenser,
    private deps: { llmGateway: LLMGateway; factsRepo: ContactFactsRepository; db: Pool },
  ) {}

  async maybeCondense(accountId: number, contactId: number): Promise<{ ran: boolean; reason?: string }> {
    // 1. Buscar último summary para esse contact
    const lastSummary = await this.db.query<{ extracted_at: Date }>(
      `SELECT extracted_at FROM contact_facts
       WHERE account_id=$1 AND contact_id=$2 AND category='summary'
       ORDER BY extracted_at DESC LIMIT 1`,
      [accountId, contactId],
    );
    const lastCondenseAt = lastSummary.rows[0]?.extracted_at;

    // 2. Buscar mensagens não-condensadas
    const msgs = await this.db.query<{ message_id: string; token_count: number; message_at: Date; role: string; content: string }>(
      `SELECT message_id, token_count, message_at, role, content
       FROM message_embeddings
       WHERE account_id=$1 AND contact_id=$2 AND superseded_by_summary_fact_id IS NULL
       ORDER BY message_at ASC`,
      [accountId, contactId],
    );

    // 3. Avaliar
    const signal = evaluateCondenseSignal({
      accountId, contactId,
      newMessagesSinceLastCondense: msgs.rows.map((m) => ({
        messageId: m.message_id, tokenCount: m.token_count, messageAt: m.message_at,
      })),
      lastCondenseAt,
      config: this.heuristicConfig,
    });

    if (!signal.shouldCondense) return { ran: false };

    // 4. Filtrar para apenas mensagens no signal
    const selected = msgs.rows.filter((m) => signal.messageIdsToCondense.includes(m.message_id));

    // 5. Rodar agente
    await this.runner({
      accountId, contactId,
      messages: selected.map((m) => ({
        messageId: m.message_id, role: m.role, content: m.content, messageAt: m.message_at,
      })),
      deps: this.deps,
    });

    return { ran: true, reason: signal.reason };
  }
}
```

- [ ] **Step 2: Span OTEL**

`memory.condense.evaluate`, `memory.condense.run`.

- [ ] **Step 3: Testes**

- [ ] **Step 4: Commit**

---

### Task 8: BullMQ queue `harness.memory.condense`

**Files:**
- Create: `src/integration/condense-queue.ts`
- Modify: `src/runtime/execution-handler.ts`, `package.json`

- [ ] **Step 1: Producer — enqueue após cada execução**

```typescript
// src/integration/condense-queue.ts
import { Queue, Worker } from "bullmq";

export function getCondenseQueue(connection: RedisOptions): Queue {
  return new Queue("harness.memory.condense", { connection });
}

export async function enqueueCondense(queue: Queue, accountId: number, contactId: number) {
  // dedup por job id: 1 job pendente por (account, contact) basta
  const jobId = `condense:${accountId}:${contactId}`;
  await queue.add("condense", { accountId, contactId }, {
    jobId,
    removeOnComplete: true,
    removeOnFail: { age: 3600 },
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });
}
```

⚠ `jobId` dedup: se já há job pendente para o mesmo contato, o `add` é no-op (BullMQ ignora). Resultado: no máximo 1 condense em fila por contato.

- [ ] **Step 2: Hook no `execution-handler.ts`**

```typescript
// fim de handleExecution, após indexação:
if (ctx.deps.condenseQueue && getEnv().MEMORY_CONDENSE_ENABLED) {
  await enqueueCondense(ctx.deps.condenseQueue, accountId, contactId);
}
```

- [ ] **Step 3: Worker dedicado**

```typescript
// processo separado: src/workers/condense-worker.ts
import { Worker } from "bullmq";
import { ObservationalCondenser } from "../memory/observational-condenser";

const worker = new Worker("harness.memory.condense", async (job) => {
  const condenser = /* construir via DI singleton */;
  await condenser.maybeCondense(job.data.accountId, job.data.contactId);
}, { connection, concurrency: 2 });
```

Script: `"worker:condense": "tsx src/workers/condense-worker.ts"`.

⚠ Decisão: worker separado evita competir CPU com worker principal. Em dev, pode rodar inline (concurrency 1 no worker principal).

- [ ] **Step 4: Testes integração**

```typescript
it("enqueue dedup: 2 chamadas seguidas geram 1 job", async () => {});
it("worker executa condense quando heurística dispara", async () => {});
```

- [ ] **Step 5: Commit**

---

### Task 9: Env vars + bootstrap wiring

**Files:**
- Modify: `src/config/env.ts`, `src/bootstrap/stages.ts`

- [ ] **Step 1: Env**

```typescript
MEMORY_SEMANTIC_RECALL_ENABLED: z.coerce.boolean().default(true),
MEMORY_SEMANTIC_RECALL_TOP_K: z.coerce.number().int().default(5),
MEMORY_SEMANTIC_RECALL_MIN_SCORE: z.coerce.number().default(0.6),
MEMORY_CONDENSE_ENABLED: z.coerce.boolean().default(true),
MEMORY_CONDENSE_THRESHOLD_MESSAGES: z.coerce.number().int().default(50),
MEMORY_CONDENSE_THRESHOLD_TOKENS: z.coerce.number().int().default(8000),
MEMORY_CONDENSE_THRESHOLD_DAYS: z.coerce.number().int().default(7),
```

- [ ] **Step 2: Bootstrap wiring**

```typescript
// stages.ts, após init-rag
const indexer = new MessageEmbeddingIndexer(db, embedder);
const semanticRecall = new RagSemanticRecall(db, embedder);
const condenser = new ObservationalCondenser(db, {
  thresholdMessages: env.MEMORY_CONDENSE_THRESHOLD_MESSAGES,
  thresholdTokens: env.MEMORY_CONDENSE_THRESHOLD_TOKENS,
  thresholdDays: env.MEMORY_CONDENSE_THRESHOLD_DAYS,
}, runMemoryCondenser, { llmGateway, factsRepo, db });
const condenseQueue = getCondenseQueue(redisConnection);

ctx.deps.messageIndexer = indexer;
ctx.deps.semanticRecall = env.MEMORY_SEMANTIC_RECALL_ENABLED ? semanticRecall : undefined;
ctx.deps.condenseQueue = env.MEMORY_CONDENSE_ENABLED ? condenseQueue : undefined;

// Registrar agent
agentRegistry.register(memoryCondenserAgent);
```

- [ ] **Step 3: Atualizar `MemoryLayer` construction** para receber `semanticRecall` e `factsRepo`

- [ ] **Step 4: Commit**

---

### Task 10: Documentação + validação E2E

**Files:**
- Create: `docs/architecture/memory.md` (novo) ou estender existente
- Modify: `README.md`

- [ ] **Step 1: Doc**

Conteúdo: diagrama dos 3 níveis (working = histórico cronológico, semantic = recall, observational = condense), fluxo de condense (signal → enqueue → worker → LLM → facts), trade-offs, knobs de tuning (thresholds), troubleshooting (condense não roda → conferir `MEMORY_CONDENSE_ENABLED` + worker rodando).

- [ ] **Step 2: README — seção "Memory Architecture"**

- [ ] **Step 3: Cenários E2E**

1. Disparar 60 mensagens para um contato → condense dispara → `contact_facts` ganha 1 summary + N facts
2. Disparar query relacionada a tópico antigo → `MemoryLayer` retorna summary + recall semântico
3. Verificar que mensagens supersedidas NÃO aparecem em recall
4. Desabilitar `MEMORY_CONDENSE_ENABLED=false` → enqueue não acontece
5. Desabilitar `MEMORY_SEMANTIC_RECALL_ENABLED=false` → MemoryLayer só mostra profile + facts (comportamento pré-D.3)
6. Worker condense crasha → execução principal não afetada (queue retenta)

- [ ] **Step 4: Performance**

```bash
# Medir overhead no context build
# Antes (sem semantic recall): X ms
# Depois: X + ~50-100ms (embed query + similarity search)
```

Expected: overhead < 150ms p95. Se maior, considerar embed cache de query (mesma query em janela curta → reuse).

- [ ] **Step 5: PR**

```bash
git push origin HEAD:sprint-d-3-semantic-memory
gh pr create --title "Sprint D.3: Semantic + Observational Memory" \
  --body-file docs/superpowers/plans/2026-05-14-sprint-d-3-semantic-memory.md
```

---

## Definition of Done

- ✅ Migration 007 aplicada; `message_embeddings` indexada
- ✅ Indexer roda assíncrono após cada execução; mensagens novas ficam embedadas em < 5s
- ✅ `MemoryLayer` exibe seção "Memórias semanticamente relevantes" quando há recall acima de minScore
- ✅ `MemoryLayer` exibe seção "Resumo de interações passadas" quando há summaries
- ✅ Pipeline agent `memory-condenser` registrado e funcional (testes passam)
- ✅ Worker dedicado `worker:condense` consome fila `harness.memory.condense`
- ✅ Heurísticas testadas: dispara em 50 msgs / 8k tokens / 7 dias
- ✅ Mensagens supersedidas não aparecem em recall (testado)
- ✅ Feature flags (`MEMORY_SEMANTIC_RECALL_ENABLED`, `MEMORY_CONDENSE_ENABLED`) permitem rollback total
- ✅ Spans OTEL `memory.semantic_recall`, `memory.condense.*` visíveis (com F4)
- ✅ Docs em `docs/architecture/memory.md` + README

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Perda de detalhes críticos na condensação | (1) Mensagens **não deletadas**, apenas marcadas como supersedidas — auditoria preserva raw; (2) prompt explícito instrui a preservar fatos críticos; (3) `confirmed=false` em facts gerados — pipeline humano pode confirmar/rejeitar depois |
| Embedding cost recorrente para indexar todas as mensagens | Cache `(model, content_hash)` reutiliza embedding entre mensagens idênticas; mensagens não-textuais (anexos) não embedadas; opt-out por account possível via flag futura |
| Latência adicional no context build (semantic recall) | Token budget respeitado; cap `topK=5`; embed da query pode ser cached em Redis com TTL curto; flag `MEMORY_SEMANTIC_RECALL_ENABLED` permite desligar |
| Condense agent alucina facts errados | `confidence=medium`, `confirmed=false` — facts não aparecem como verdade dura; pipeline de revisão futuro pode promover; `source_agent='memory-condenser'` permite filtrar/auditar |
| Worker condense competir com worker principal | Worker dedicado (`worker:condense`); concurrency baixa (2); pode rodar em pod separado em prod |
| Re-condense duplicado (jobs concorrentes) | `jobId` dedup BullMQ; consultas usam `superseded_by_summary_fact_id IS NULL` que é monotônica |
| Falha em D.2 propaga para D.3 | Hard dependency declarada; CI bloqueia merge se D.2 não estiver presente (testes de integração falham sem `pgvector`) |
| Privacy: summaries em texto livre podem conter PII sensível | Mesma classificação de dados de `contact_facts` existente; herda políticas de retenção; documentado em `docs/architecture/memory.md` |
| Memory layer existente quebra com adição de seções | Construtor backward-compatible (`semanticRecall` e `factsRepo` opcionais); quando ausentes, comportamento idêntico ao anterior; regressão coberta por testes existentes |

---

## Correções Pós-Review (2026-05-14)

Aplicadas após review automatizado. Consultar [INDEX](./2026-05-14-INDEX-bevox-2.0-sprints.md#correções-pós-review-2026-05-14) para decisões globais.

### Critical
- **Task 0 (nova)** — Husky no-verify (G.6) + Extensão `LLMRequestOptions.meta` (G.3) prerequisito.
- **`LLMGateway.complete()` signature** — Plano usa `responseFormat`, `meta`, `model` no call. Interface real só tem `{ messages, tools?, responseSchema?, maxTokens?, temperature? }`. Corrigir Task 6 Step 2:
  - `responseFormat: "json_object"` → `responseSchema: condenseOutputSchemaJSONSchema`
  - Remover `model:` (resolvido no factory)
  - `meta:` só após G.3 aplicado
- **Migration `007_message_embeddings.sql`** — Confirmada via G.1. NÃO renumerar para 005 (que vai pra C.1).
- **Worker file em Files Touched** — Adicionar `src/workers/condense-worker.ts` à seção Create. Decidir: workers em `src/workers/` (novo dir) ou `src/integration/` (existente). Recomendação: novo `src/workers/` para isolar concerns.
- **Hard dep gate D.2** — Task 1 inclui pré-flight: `SELECT 1 FROM pg_extension WHERE extname='vector'`, falha migration 007 com mensagem clara "D.2 (RAG pgvector) deve estar mergeada e migration 006 aplicada".
- **`contact_facts.category` constraint** — Ler `migrations/001_memory_and_classifications.sql`. Se há CHECK enumerando categorias, adicionar a migration 007: `ALTER TABLE contact_facts DROP CONSTRAINT ... ADD CONSTRAINT ... CHECK (category IN ('personal','preference','restriction','history','decision','contact','summary'))`. Sem isso, INSERT de summary falha.
- **`ContextInput.userMessage`** — Adicionar como Task explícita: estender `src/context/types.ts` e validar todos os call sites de `MemoryLayer.build()`. Sem query, semantic recall não funciona.

### Important
- **`memory-condenser` framework alignment** — Reaproveitar `DirectEngine` em vez de chamar `llmGateway.complete()` direto. Pipeline agents existentes (MessageAnalyzer, MemoryExtractor) seguem esse padrão. Mantém circuit breaker / retry / observability uniforme.
- **Heurística state cache** — `ObservationalCondenser.maybeCondense` re-lê DB a cada exec. Cache em Redis `harness:condense:lastrun:{account}:{contact}` com TTL=thresholdDays. Reduz queries.
- **Retention policy** — `message_embeddings` cresce monotonicamente. Definir: drop por `message_at` (>2 anos), hard cap por contato (10k FIFO), compactação após N condenses. Adicionar coluna `retention_class`.
- **Token budget enforcement** — Implementar de fato no `MemoryLayer.build()`: `if (input.tokenBudget && estimatedSoFar > input.tokenBudget - 200) return early`.
- **Worker concurrency env-driven** — `MEMORY_CONDENSE_WORKER_CONCURRENCY` default 1 até load-test. Concurrency=2 hardcoded sobrecarrega LLM provider.
- **Indexer fire-and-forget** — Mover `queueMicrotask` em execution-handler para job BullMQ separado `harness.memory.index` com worker dedicado. Embedding batch de 50 msgs leva 200-500ms, bloqueia execution worker.
- **Feature flag granular** — Considerar `MEMORY_FEATURES_ALLOWLIST_ACCOUNTS=1,5,10` para rollout gradual ou marcar explicitamente out-of-scope.

### Nitpick
- `ROW_NUMBER() OVER` — Validar com EXPLAIN ANALYZE; alternativa simpler (subquery min).
- Prompt multi-lang — Passar `preferred_language` do profile.
- `confidence` matrix documentada.
- Doc `docs/architecture/memory.md` vs bevox-knowledge SoT — verificar política.
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS source_agent TEXT` (sem DO block).
