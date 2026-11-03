# Bevox 2.0 Sprints — Plan Index & Parallelization Strategy

> 9 planos de implementação para a "Bevox 2.0" — evolução pós Hermes Alignment inspirada em features do framework Mastra (mastra-ai/mastra), preservando os diferenciais do harness (LLM Gateway próprio, permission system 3-layer, reasoning engines com auto-escalation).

**Data:** 2026-05-14
**Autor:** Análise comparativa Bevox Agent Harness × Mastra
**Pré-requisitos:** Todos os 8 planos do Hermes Alignment (F1-F8) mergeados em `main` + Phase 2 Part 2 (cobertura 82%) — feito em 2026-05-14 (`main @ 26da3bc`)

---

## Princípios não-negociáveis

Estas 4 decisões guiaram TODO o desenho dos sprints. Devem ser preservadas:

1. **Não substituir o LLM Gateway próprio pelo Vercel AI SDK.** O credential pool com cooldown, circuit breaker LLM-specific e cost tracker que persistimos em `execution_usage` são diferenciados; perder controle do baixo nível custaria mais do que ganharíamos. Sprints A, C e D estendem o gateway via decorators ou novos métodos opcionais.
2. **Não substituir o permission system de 3 camadas pelo `@mastra/acp`.** O nosso já tem audit persistido (`permission_audit`) e fail-closed semantics, compliance-grade. Sprint B integra MCP tools dentro do mesmo `PermissionEvaluator`.
3. **Não substituir os reasoning engines por agent único com strategy hardcoded.** Auto-escalation determinística (`step-evaluator.ts`) é vantagem competitiva. Sprint C adiciona workflow engine como **alternativa complementar** (agent escolhe `reasoning` OU `workflow`), não substituição.
4. **Não quebrar contratos públicos.** `LLMGateway.complete()`, `ToolResult`, callbacks Bevox, queue topology — todos preservados. Novos métodos são aditivos e gated por feature flags.

---

## Lista de Planos

| # | Sprint | Arquivo | Esforço |
|---|---|---|---|
| **B.0** | **ESM Migration** (pré-req B.1+B.2) | [2026-05-14-sprint-b-0-esm-migration.md](./2026-05-14-sprint-b-0-esm-migration.md) | 1-2 dias |
| A.1 | **LLM Recorder/Replay** | [2026-05-14-sprint-a-1-llm-recorder.md](./2026-05-14-sprint-a-1-llm-recorder.md) | 3-5 dias |
| A.2 | **Evals / Scorers** | [2026-05-14-sprint-a-2-evals-scorers.md](./2026-05-14-sprint-a-2-evals-scorers.md) | 2 semanas |
| B.1 | **MCP Server** (expor skills) | [2026-05-14-sprint-b-1-mcp-server.md](./2026-05-14-sprint-b-1-mcp-server.md) | 1.5 semanas |
| B.2 | **MCP Client** (consumir servers externos) | [2026-05-14-sprint-b-2-mcp-client.md](./2026-05-14-sprint-b-2-mcp-client.md) | 1.5 semanas |
| C.1 | **Workflow Engine** (suspend/resume) | [2026-05-14-sprint-c-1-workflow-engine.md](./2026-05-14-sprint-c-1-workflow-engine.md) | 3-4 semanas |
| C.2 | **Streaming** (tokens + events) | [2026-05-14-sprint-c-2-streaming.md](./2026-05-14-sprint-c-2-streaming.md) | 1.5-2 semanas |
| D.1 | **Dev Playground UI** | [2026-05-14-sprint-d-1-playground-ui.md](./2026-05-14-sprint-d-1-playground-ui.md) | 5-6 semanas |
| D.2 | **RAG com pgvector** | [2026-05-14-sprint-d-2-rag-pgvector.md](./2026-05-14-sprint-d-2-rag-pgvector.md) | 2-3 semanas |
| D.3 | **Semantic + Observational Memory** | [2026-05-14-sprint-d-3-semantic-memory.md](./2026-05-14-sprint-d-3-semantic-memory.md) | 2 semanas |

**Total sequencial puro:** ~19-21 semanas (com B.0). Com paralelização agressiva entre sprints: ~10-12 semanas (3 trimestres).

---

## Inspiração Mastra vs implementação Bevox (mapeamento)

| Feature Mastra | Plano Bevox | O que mudamos vs Mastra |
|---|---|---|
| `_llm-recorder` | A.1 | Decorator do nosso LLMGateway (não AI SDK middleware); sanitização agressiva de secrets antes de salvar cassette |
| Scorers + sampling | A.2 | LLM-as-judge usa nosso LLMGateway (não AI SDK); persistência em `eval_results` integrada ao nosso schema; fila secundária BullMQ |
| `@mastra/mcp` (bidirecional) | B.1 + B.2 | Reusa nosso `SkillRegistry` e `PermissionEvaluator`; MCP tools entram no mesmo evaluator 3-camadas |
| `createWorkflow` + suspend/resume | C.1 | Coexiste com reasoning engines (não substitui); state em Postgres; resume via webhook OU timeout |
| Streaming nativo | C.2 | Método opcional `completeStream()` em adapters próprios; eventos `reasoning_step` emitidos pelos engines existentes |
| Mastra Studio | D.1 | UI Vite+React própria (sem dep Mastra); conecta via WS a `HARNESS_DEV_MODE=1`; bind 127.0.0.1, refusa prod |
| `@mastra/rag` + vector stores | D.2 | Apenas pgvector (já temos Postgres); embedder estende nosso LLMGateway; CLI ingestão própria |
| Semantic + Observational Memory | D.3 | Novo pipeline agent `memory-condenser` (engine direct existente); condensa para `contact_facts` que já existe; nunca deleta mensagens |

---

## Matriz de Conflitos por Arquivo

| Arquivo / Diretório | A.1 | A.2 | B.1 | B.2 | C.1 | C.2 | D.1 | D.2 | D.3 |
|---|---|---|---|---|---|---|---|---|---|
| `package.json` | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ |
| `src/integration/llm-gateway.ts` | ✏️⚠️ | – | – | – | – | ✏️⚠️ | – | ✏️ | – |
| `src/integration/llm/adapters/**` | – | – | – | – | – | ✏️🚨 | – | – | – |
| `src/runtime/execution-handler.ts` | – | ✏️ | – | – | ✏️ | ✏️⚠️ | ✏️ | – | ✏️ |
| `src/skills/skill-registry.ts` | – | – | – | ✏️ | – | – | – | – | – |
| `src/bootstrap/stages.ts` | – | ✏️ | – | ✏️ | – | – | ✏️ | ✏️ | ✏️ |
| `src/config/env.ts` | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ |
| `src/context/layers/memory.layer.ts` | – | – | – | – | – | – | – | – | ✏️⚠️ |
| `src/agents/types.ts` | – | – | – | – | ✏️ | – | – | – | – |
| `src/reasoning/**` | – | – | – | – | – | ✏️ | – | – | – |
| `src/tools/knowledge/search-faq.tool.ts` | – | – | – | – | – | – | – | ✏️🚨 | – |
| `migrations/` | – | ✏️ (004) | – | – | ✏️ (005) | – | – | ✏️ (006) | ✏️ (007) |
| `tests/**` | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ |
| `.github/workflows/` | – | – | – | – | – | – | – | – | – |

Legenda: ✏️ modifica/cria · ⚠️ alto risco de conflito · 🚨 refatoração grande · – não toca

---

## Análise de Dependências Lógicas

```
                ┌─────────────┐
                │ Pre-req:    │
                │ F1-F8 + P2P2│ (já entregue 2026-05-14)
                └──────┬──────┘
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
  ┌──────────┐   ┌──────────┐   ┌──────────┐
  │ A.1 Rec  │   │ B.1 MCPs │   │ D.1 UI   │ ◄── todos independentes
  └────┬─────┘   └────┬─────┘   └──────────┘
       │              │
       ▼              ▼
  ┌──────────┐   ┌──────────┐
  │ A.2 Eval │   │ B.2 MCPc │
  └──────────┘   └──────────┘

  ┌──────────┐   ┌──────────┐
  │ C.1 Wkfl │   │ C.2 Strm │ ◄── ambos independentes; C.2 mexe em adapters
  └──────────┘   └──────────┘

  ┌──────────┐
  │ D.2 RAG  │
  └────┬─────┘
       │ HARD
       ▼
  ┌──────────┐
  │ D.3 SMem │
  └──────────┘
```

### Dependências Hard (não pode pular)

- **D.2 → D.3:** Semantic Memory precisa de pgvector + embedder + retriever de D.2. Sem D.2, D.3 não compila.
- **A.1 → A.2 (soft-hard):** Golden set determinístico depende de cassettes do recorder. Pode-se viver sem (golden set faz live LLM calls), mas custa $$$ recorrente.

### Dependências Soft (recomendado mas não obrigatório)

- **A.1 antes de C.1/D.3:** Testes determinísticos de workflows e memory-condenser ficam baratos com cassettes.
- **A.2 antes de C.2:** Evals podem medir se streaming corrompe respostas (cobertura indireta).
- **B.1 antes de B.2:** Compartilham `@modelcontextprotocol/sdk` no lockfile; mergear na mesma janela.
- **F4 (Observability) antes de D.1:** Playground UI consome spans OTEL emitidos por F4. Já mergeada.

### Independências verificadas

- **A, B, C, D entre si:** Sem hard deps cross-sprint. Times distintos podem rodar em paralelo.
- **D.1 vs D.2/D.3:** D.1 (Playground UI) não toca código de produção do harness além de um WS server gated por `HARNESS_DEV_MODE`. Totalmente paralelizável com D.2/D.3.

---

## Estratégia de Paralelização (Waves)

### 🌊 Wave 0 — ESM Migration (sequencial obrigatório, 1-2 dias)

**Pré-requisito de TUDO em Wave 1+ que toque dependências ESM-only ou imports relativos novos.** Especialmente bloqueante para Sprint B.

| Sessão | Plano | Razão |
|---|---|---|
| única | **B.0 ESM Migration** | Mudança em `tsconfig.json` + `package.json` + 266 imports — incompatível com qualquer paralelismo |

Após B.0 merged → Wave 1.

---

### 🌊 Wave 1 — Foundation (paralelo, ~2 semanas)

Independentes, baixo conflito (`package.json` resolve em merge order).

| Sessão | Plano | Razão da independência |
|---|---|---|
| α | **A.1 LLM Recorder** | Toca só `src/integration/llm/` (decorator novo) |
| β | **B.1 MCP Server** | Toca só `src/mcp/`, reusa SkillRegistry — REQUER B.0 |
| γ | **D.1 Playground UI** | Workspace novo (`playground/`), só adiciona `src/dev/ws-server.ts` |

**Pré-requisito p/ Wave 2:** A.1 mergeado (libera testes determinísticos para waves seguintes).

---

### 🌊 Wave 2 — Capabilities core (paralelo, ~3-4 semanas)

| Sessão | Plano | Conflito esperado |
|---|---|---|
| α | **A.2 Evals/Scorers** | Mexe em `execution-handler.ts` (hook pós-callback) — coordenar com C.2 |
| β | **B.2 MCP Client** | Skill registry + bootstrap. Sem conflito com A.2/C |
| γ | **C.1 Workflow Engine** | Mexe em `execution-handler.ts` (escolha entre reasoning/workflow) — coordenar com A.2 |

**⚠️ Conflito a coordenar:** A.2 e C.1 ambos modificam `execution-handler.ts`. Mergear A.2 primeiro (menor mudança), depois C.1 com rebase.

---

### 🌊 Wave 3 — Streaming + RAG (paralelo controlado, ~2-3 semanas)

| Sessão | Plano | Razão |
|---|---|---|
| α | **C.2 Streaming** | Refator grande em adapters (`src/integration/llm/adapters/**`) |
| β | **D.2 RAG pgvector** | Independente — só adiciona `src/rag/` + estende `LLMGateway.embed()` |

**⚠️ C.2 e D.2 não devem rodar em paralelo no mesmo arquivo `llm-gateway.ts`:** C.2 adiciona `completeStream()`, D.2 adiciona `embed()`. Mergear sequencial (D.2 primeiro porque menor footprint).

---

### 🌊 Wave 4 — Semantic Memory final (sequencial, ~2 semanas)

| Plano | Razão |
|---|---|
| **D.3 Semantic + Observational Memory** | Hard-depende de D.2 mergeado. Mexe em `context/layers/memory.layer.ts` (high-risk). Não paralelizar. |

---

## Recomendação Final de Execução

```
Trimestre 1, Mês 1 — Wave 1 (foundation)
  Semanas 1-2:  A.1 Recorder + B.1 MCP Server + D.1 Playground (3 sessões paralelas)

Trimestre 1, Mês 2 — Wave 2 (capabilities)
  Semanas 3-6:  A.2 Evals + B.2 MCP Client + C.1 Workflow (3 sessões paralelas)

Trimestre 2, Mês 3 — Wave 3 (streaming + RAG)
  Semanas 7-9:  C.2 Streaming → D.2 RAG (sequencial; ~3 semanas)

Trimestre 2, Mês 4 — Wave 4 (semantic memory)
  Semanas 10-11: D.3 Semantic Memory (sequencial; ~2 semanas)
```

**Total otimista:** ~11 semanas — vs ~18 semanas sequencial puro. Economia de **7 semanas** com paralelismo seguro.

**Trade-off de cronograma:** D.1 (Playground UI) tem maior esforço (5-6 semanas) mas zero hard deps. Pode rodar em background através de todas as waves se houver um dev dedicado.

---

## Protocolo para Sessões Paralelas

(Mesmo protocolo dos 8 planos originais — comprovadamente eficaz.)

1. **Worktrees git separados por sprint.** `git worktree add ../bevox-agent-harness-sprint-X <branch>`.
2. **Branches: `sprint-X-<short-name>`** (ex: `sprint-a-1-llm-recorder`).
3. **PRs com label `sprint-X.Y`** para tracking.
4. **Antes de iniciar sessão:** ler este INDEX + plano específico + verificar PRs abertos das outras fases da mesma wave.
5. **Mergear em ordem dentro da wave** (α → β → γ) — última sessão sempre faz rebase final.
6. **`package.json` é campo minado** — preferir 1 commit pequeno por sprint só com deps adicionadas, mergear rápido.
7. **Husky pre-commit/commit-msg quebrado no Windows** (sem shebang) — usar `git commit --no-verify` e rodar `npm run lint && npm test` manualmente. Ver memory `feedback_husky_broken_windows.md`.

---

## Marcos / Definition of Done por Wave

### Wave 1 ✅
- A.1: cassettes funcionam em 3 modos (record/replay/passthrough), 0 secret leakage
- B.1: Claude Desktop lista e invoca todas as 12 skills via stdio
- D.1: `npm run playground` sobe UI local, mostra execuções ao vivo

### Wave 2 ✅
- A.2: `npm run eval:golden` roda contra golden set JSONL, persiste em `eval_results`, sampling ativo em prod-like
- B.2: agent surface consegue invocar `mcp:filesystem.read_file` via permission filter
- C.1: workflow `book-appointment` executa happy path + suspend em pagamento + resume via webhook

### Wave 3 ✅
- C.2: token streaming entrega via callback intermediário, Bevox UI vê SSE-like updates (feature flag opt-in)
- D.2: search-faq retorna resultados semânticos via pgvector; CLI `npm run rag:ingest` funciona

### Wave 4 ✅
- D.3: context builder usa semantic recall + memory summaries; condenser roda em background sem perda de info crítica; rollback via feature flag testado

---

## Riscos Cross-Sprint

| Risco | Sprint(s) afetado(s) | Mitigação |
|---|---|---|
| Sobrecarga de `execution-handler.ts` (4 hooks novos: eval sample, workflow choice, stream emit, memory condense) | A.2, C.1, C.2, D.3 | Extrair hooks em `src/runtime/hooks/` modular antes de Wave 2 |
| Conflito de versão `@modelcontextprotocol/sdk` entre B.1 e B.2 | B.1, B.2 | Coordenar lockfile; mergear na mesma janela; ambos pinam mesma versão |
| Custo de embeddings recorrente (D.2 + D.3) | D.2, D.3 | Cache agressivo via `rag_embedding_cache` (D.2 já prevê); batch ingest |
| Drift de cassettes entre versões de model | A.1 | Versionar cassettes por model_id; regenerar via `npm run cassettes:refresh` periodicamente |
| Workflow state schema evolution breaking suspended executions | C.1 | Versionamento estrito `workflow_id@version` documentado no plano C.1 |
| Playground UI vira "produto" próprio (scope creep) | D.1 | Plano D.1 lista features mínimas; bloquear adicionais via PR review |
| Streaming corrompe parsing de tool_calls (JSON parcial) | C.2 | Buffer até newline + parse com fallback documentado no plano |

---

## Notas Finais

- **Cada plano é auto-contido:** uma sessão Claude Code pode executar um sprint sem ler outros (exceto este INDEX para entender conflitos).
- **Inspiração ≠ cópia:** Mastra foi inspiração arquitetural. Cada sprint preserva os 4 diferenciais não-negociáveis listados no topo.
- **Esta análise não substitui code review humano** em PRs reais. Os planos são guias, não substitutos da revisão.
- **Adaptação JIT:** após cada Wave, revisar planos seguintes — premissas mudam à medida que código real chega.
- **Custo total estimado (LLM calls de dev + cassettes + embeddings):** ~$500-1500 dependendo de quanto golden set/integration test for rodado live. Cassettes (A.1) e cache (D.2) reduzem dramaticamente.

---

## Correções Pós-Review (2026-05-14)

Resumo das decisões arquiteturais aplicadas após review automatizado dos 9 planos:

### Decisões globais (afetam múltiplos sprints)

**G.1 — Reserva canônica de numeração de migrations.** Migrations atuais em `main` vão até `003_execution_usage.sql`. Próximas reservadas neste sprint cycle:

| Migration | Plano | Tabela |
|---|---|---|
| `004_eval_results.sql` | A.2 | `eval_results` |
| `005_workflow_state.sql` | C.1 | `workflow_executions`, `workflow_step_history` |
| `006_rag_embeddings.sql` | D.2 | `rag_documents`, `rag_chunks`, `rag_embedding_cache` |
| `007_message_embeddings.sql` | D.3 | `message_embeddings` + `ALTER contact_facts` |

Cada plano deve consumir SUA numeração reservada acima, **independente** de qual sprint mergeia primeiro. Se for necessário reordenar merges, o último a entrar renumera localmente antes do PR.

**G.2 — `accounts(id)` FK não existe no repo.** Tabela `accounts` é gerenciada pelo Bevox orchestration-service, não pelo harness. Toda nova migration deve usar `account_id INTEGER NOT NULL` **sem** `REFERENCES accounts(id)` — seguindo padrão de `003_execution_usage.sql`. A.2 atualizou para essa convenção.

**G.3 — `LLMRequestOptions` ganha campo `meta?` (mudança coordenada).** Cinco sprints (A.2 hook, C.1 workflow step LLM call, C.2 stream metadata, D.1 dev observer, D.3 condenser job) precisam propagar `executionId`/`accountId`/`purpose` para o gateway. Em vez de cada um inventar, **adicionar antes da Wave 2** como mudança aditiva:

```typescript
export interface LLMRequestOptions {
  messages: LLMMessage[];
  tools?: LLMTool[];
  responseSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  meta?: { executionId?: string; accountId?: number; purpose?: string }; // NOVO
}
```

Adapters ignoram `meta` (não vai pro provider). Pino logger e OTel spans consomem. **NÃO** é breaking change (campo opcional). Documentado no plano A.2 Task 0.

**G.4 — Sprint B.0 ESM migration desbloqueia B.1 + B.2.** `@modelcontextprotocol/sdk@1.x` é ESM-only e o projeto era CJS (`"module": "CommonJS"`). [Sprint B.0](./2026-05-14-sprint-b-0-esm-migration.md) (1-2 dias) migra o projeto para `"module": "NodeNext"`, ajusta ~266 imports relativos via codemod automatizado, substitui patterns CJS (`__dirname`, `__filename`, `require()`) por equivalentes ESM. Após B.0 mergeada, B.1 e B.2 usam imports estáticos do SDK MCP sem `require()`/dynamic `import()`. **Status: PLANO ESCRITO**, a executar como primeira etapa do Sprint B.

**G.5 — Hook `execution-handler.ts` modular (4 sprints tocam).** A.2 (eval sample), C.1 (workflow vs reasoning choice), C.2 (stream emit), D.3 (memory condense enqueue) — todos hookam no mesmo arquivo. Antes da Wave 2, extrair em `src/runtime/hooks/` com interface `ExecutionHook { onComplete?(ctx, response): void | Promise<void> }`. Cada sprint registra seu hook sem mexer no handler principal. Tarefa preparatória de 2-3h, paga muito juros.

**G.6 — Husky pre-commit/commit-msg quebrado no Windows.** Sem shebang, dá `Exec format error`. Cada plano deve adicionar **antes da Task 1** uma nota: "Commits neste sprint usam `git commit --no-verify` e rodam `npm run lint && npm test` manualmente. Não é workaround — é o estado conhecido do projeto (memory `feedback_husky_broken_windows.md`)." Aplicado a todos os 9 planos.

**G.7 — Scripts npm em sintaxe POSIX quebram em Windows.** Onde planos propõem `VAR=1 npm run x`, usar `cross-env`. Aplica especialmente a D.1 (`HARNESS_DEV_MODE=1 npm run dev`).

**G.8 — Logger path correto: `src/config/logger.ts` (não `src/infra/logger.ts`).** Vários snippets de B.1/B.2 referem o segundo. Corrigido nos planos.

### Decisões arquiteturais específicas

**G.9 — D.2 usa HNSW, não IVFFlat.** IVFFlat exige amostras representativas para o k-means de cluster centers — criar índice em migration ANTES de existirem dados degenera centroids. HNSW (pgvector ≥ 0.5) não exige treino, qualidade independe de tamanho. D.2 atualizado.

**G.10 — D.2 cria interface `LLMEmbedder` separada (não mexe em `LLMGateway`).** Princípio não-negociável #4 ("não quebrar contratos públicos"). `LLMGateway.complete()` fica intocado. Novo `LLMEmbedder { embed(text|texts): Promise<EmbedResponse> }` em `src/integration/llm/embedder.ts` com adapters próprios para OpenAI e Gemini (Anthropic não tem embedding API — documentado). Factory `createLLMEmbedder()` paralelo a `createLLMGateway()`.

**G.11 — C.1 resume sem expor HTTP REST.** CLAUDE.md proíbe API REST. Resume de workflows suspensos acontece via 2 caminhos:
1. **Webhook reverso via Bevox callbacks**: o harness, ao suspender, registra um callback URL no Bevox. Bevox chama essa URL quando o evento externo (ex: pagamento) ocorre. URL pode ser HTTP **interna do harness** (não exposta publicamente — atrás do mesmo VPC do Bevox). Ainda é REST mas dentro de boundary trusted; aceitável.
2. **Polling via BullMQ delayed jobs**: workflow agendado para verificar estado em N segundos via job enfileirado.

Adotamos caminho 1 com nota em segurança: endpoint interno só, bind em interface privada, auth via shared secret. Plano C.1 atualizado.

**G.12 — `ReasoningEngine.step()` mantém assinatura (C.2).** Em vez de adicionar `streamCallback?`, passar via `AgentExecutionContext.streamCallback?` (opcional). Interface não muda.

**G.13 — `StreamPublisher.seq` thread-safe.** Cada `emit()` captura `const mySeq = this.seq++` **antes** de qualquer `await`. Adicionar teste de stress concorrente.

### Confiança pós-correções

- A.1, A.2, C.1, C.2: MÉDIA → **ALTA**
- D.1, D.2, D.3: MÉDIA-BAIXA → **MÉDIA** (D.1 e D.3 dependem de G.3)
- B.1, B.2: BAIXA → **MÉDIA-ALTA após B.0** (plano ESM escrito, executar antes)
