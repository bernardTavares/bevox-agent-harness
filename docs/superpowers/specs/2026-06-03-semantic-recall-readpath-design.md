# Semantic-Recall Read Path — Wiring `getSemanticRecall()` into the MemoryLayer at Build Time — Design

> **Spec ID:** `2026-06-03-semantic-recall-readpath-design`
> **Status:** Draft — pendente review pelo founder
> **Autor:** Claude (Opus 4.8) — 2026-06-03, AI Engineer. Pesquisa verificada contra o código de `main` + branch `origin/ctx-builder` (PR #61).
> **Escopo:** bevox-harness audit finding CTX-03 (read path do recall semântico D.3 morto — `getSemanticRecall()` sem consumidor de produção; `runtime-gap-audit-2026-06-02.md:254`)
> **Estimate:** se #61 mergeado → ~2–3h (verificar edge + Phase 3 testes). Se
> main-first sem #61 → ~6–9h (Phase 0 porta a reescrita do `ContextBuilder` de #61 +
> `context-wiring` + gating + testes). A estimativa original de ~4–6h pressupunha
> "fio fino", premissa invalidada pelo review adversarial (§8 risco 6).
> **Issue:** bernardTavares/bevox-harness#43 (D.3 / accountDeniedTools POC já landou; este é o follow-on de recall) — abrir issue dedicada CTX-03 se preferível

> **⚠️ Nota de compatibilidade com PR #61.** A ressurreição idiomática do
> read path é, por design, a **mesma** edge que o PR #61 (branch
> `ctx-builder`, CTX-01) já implementa: `createContextBuilder` em
> `src/context/builder-factory.ts:43` faz `semanticRecall:
> deps.memory?.semanticRecall ?? getSemanticRecall()` e o
> `execution-handler` instancia o builder atrás de `CONTEXT_BUILDER_ENABLED
> && contactId != null` (`ctx-builder` em `:250` e `:1059`). Esta spec
> **ramifica de `main`** e NÃO assume #61 mergeado, mas adota **a forma de #61
> para a edge de recall** (`semanticRecall: deps.memory?.semanticRecall ??
> getSemanticRecall()`) para que um pouso main-first e o merge posterior de #61
> **convirjam num único construction site** (o fallback `?? getSemanticRecall()`
> torna os dois idempotentes) em vez de produzir dois wires duplicados. Ver
> §4.4 e §8 risco 3.
>
> **⚠️ CORREÇÃO (review adversarial 2026-06-03).** A edge de recall **em si**
> (`semanticRecall: ... ?? getSemanticRecall()`) é idêntica em #61, mas o
> *restante* do main-first **NÃO é** "byte-for-byte #61" nem uma edge fina:
> #61 **reescreveu** o `ContextBuilder` órfão de `main` (adicionou `blocks` em
> `BuiltContext`, `layerTimeoutMs`+`Promise.race` por layer, `contactId?`
> opcional, tracking de falha por layer) e adicionou `context-wiring.ts`
> (`buildContextInput`/`foldContext` — este último lê `built.blocks`, que **não
> existe** no `BuiltContext` de `main`). Portanto um pouso main-first que reuse
> `foldContext`/o gating de #61 **precisa portar a reescrita inteira do
> `ContextBuilder`** — ou seja, é essencialmente landar #61, não "a fatia mínima
> de recall". Ver §4.4 (Contras revistos) e §8 riscos 1, 4 e 6.

## §1. Context

O subsistema D.3 (Sprint Semantic + Observational Memory) entregou a maquinaria de
recall **completa de ponta a ponta, exceto o gancho final de leitura**:

- **WRITE/QUERY infra existe e está testada.** `RagSemanticRecall.recall()`
  (`src/memory/semantic-recall.ts:62-130`) embeda a query via o `CachingEmbedder`
  compartilhado, roda um kNN cosine pgvector (`1 - (me.embedding <=> $3::vector)`,
  `:104,112`) sobre `message_embeddings` com uma CTE de `recency_rank` que pula os N
  mais recentes (`:91-99,111` — já presentes no History layer), filtra por `minScore`
  (`:117-118`), e é envelopado em `withSpan("memory.semantic_recall")`
  (`:72`, `src/observability/spans.ts`). Indexado por HNSW + `vector_cosine_ops`
  (`migrations/007_message_embeddings.sql:49-50`). Tenant-isolado em `organization_id`
  — `recall()` **lança** se ausente (`:64-66`).

- **CONSUMER existe no layer.** `MemoryLayer.build()` consome o recall em
  `src/context/layers/memory.layer.ts:138-162`, guardado por
  `this.opts.semanticRecall && input.userMessage && budgetOk` (`budgetOk`
  calculado em `:136-137`), com try/catch **fail-open** (`:159-161` — "recall
  failures must NEVER block execution"), renderizando um bloco
  `### Memorias semanticamente relevantes` (`:151`). O caminho irmão D.3 de
  facts/summary (`factsRepo.findSummaries`) está wired do mesmo jeito em `:114-132`.
  `semanticRecall?` é campo **opcional** em `MemoryLayerOptions`
  (`memory.layer.ts:35-45`).

- **BOOTSTRAP popula o registry singleton.** O stage `init-memory-d3`
  (`src/bootstrap/stages.ts:447-498`) constrói `new RagSemanticRecall(...)`
  (`:481-487`) com `topK/minScore/excludeRecent` do env e chama
  `setSemanticRecall(...)` no registry de processo (`src/memory/registry.ts:28-33`).
  Gated por `MEMORY_SEMANTIC_RECALL_ENABLED` (default **FALSE**, `src/config/env.ts:143-149`);
  o stage inteiro early-returns se todos os `MEMORY_*` estão off (`stages.ts:450-457`)
  e pré-checa pgvector (`stages.ts:460-467`).

Ou seja: o valor é **produzido** (bootstrap → registry) e **poderia ser consumido**
(MemoryLayer lê `opts.semanticRecall`), mas o fio **ENTRE** eles nunca foi conectado
em `main`.

## §2. Problem statement

**O elo morto é o getter do registry.** `getSemanticRecall()`
(`src/memory/registry.ts:31`) tem **ZERO call sites** em `src/` — `grep -rn
"getSemanticRecall" src/` retorna apenas a própria definição. Logo
`MemoryLayerOptions.semanticRecall` **nunca é populado em runtime**, e o branch de
recall em `MemoryLayer.build()` (`memory.layer.ts:138-162`) é **inalcançável em
produção**.

**A causa-raiz está um nível acima.** Não existe `new MemoryLayer(...)` nem
`new ContextBuilder(...)` fora de testes em `main` (`grep -rn "new MemoryLayer\|new
ContextBuilder" src/ --include="*.ts" | grep -v ".test.ts"` retorna vazio). O
subsistema ContextBuilder de 5 layers está **órfão** — é o audit finding **CTX-01**
(`runtime-gap-audit-2026-06-02.md:213`). O prompt vivo é montado ad-hoc por
`composeSystemPrompt(...)` (`src/runtime/execution-handler.ts:239,933,1266`;
def em `src/sdr/compose.ts:59`) + o helper CTX-02 `enforceBudget(...)`
(`execution-handler.ts:1312`), com o comentário explícito em
`execution-handler.ts:1303`: *"Full 5-layer `ContextBuilder` integration is a
follow-up."* `composeSystemPrompt` **NÃO** lê memória de contato nem recall
semântico.

**O `execution-handler` importa o registry mas NÃO o getter de recall.** A linha
`execution-handler.ts:45` importa `getCondenseQueue, getMessageIndexer` de
`../memory/registry.js` — `getSemanticRecall` está ausente.

**NET:** recall está implementado, embeddável, indexado e gated OFF por default —
mas **mesmo com `MEMORY_SEMANTIC_RECALL_ENABLED=true`** continua morto em `main`,
porque nada constrói um `MemoryLayer` que leia o registry. O audit captura a
intenção com precisão (`runtime-gap-audit-2026-06-02.md:254`): *"CTX-03 (read path
do recall semântico D.3 morto — `getSemanticRecall()` sem consumidor de
produção)"*.

## §3. Goals & non-goals

**Goals:**

- Conectar o read path: um **único construction site** que lê `getSemanticRecall()`
  e o injeta em `MemoryLayerOptions.semanticRecall`, tornando o branch de recall de
  `MemoryLayer.build()` (`memory.layer.ts:138-162`) alcançável em produção.
- Passar os knobs do env (`MEMORY_SEMANTIC_RECALL_TOP_K`,
  `MEMORY_SEMANTIC_RECALL_MIN_SCORE`, `MEMORY_SEMANTIC_RECALL_EXCLUDE_RECENT`,
  `env.ts:147-149`) para o `MemoryLayer` — **mesmos** que o bootstrap já passa ao
  `RagSemanticRecall` (`stages.ts:483-485`), de modo que defaults batem.
- Manter recall **OFF por default** (`MEMORY_SEMANTIC_RECALL_ENABLED=false`): o read
  path só "acende" quando o flag liga (registry não-`undefined`) E o builder roda.
- **Fail-open** preservado: se o vector store/embedder estiver indisponível, o
  try/catch existente (`memory.layer.ts:159-161`) já garante que `build()` retorna o
  bloco de profile/facts sem lançar.
- Convergir com PR #61 sem assumi-lo: pousar a edge na **mesma forma** de
  `builder-factory.ts:43` + mesmos guards (`CONTEXT_BUILDER_ENABLED && contactId !=
  null`), tornando main-first e o merge de #61 idempotentes.
- Definir explicitamente o **contrato de recall**: o que vira query, top-k,
  similarity threshold, recall token budget cap, e como o conteúdo recuperado se
  dobra no bloco Memory (§4.1).
- Testes: unit do construction site (lê o getter, degrada a `undefined`), unit do
  render/truncate/skip do `MemoryLayer`, unit fail-open; integração RUN_INTEGRATION
  end-to-end (seed `message_embeddings` → `setSemanticRecall` → build → assert
  bloco com recency-exclusion).

**Non-goals:**

- **NÃO** implementar a CTX-01 inteira (5 layers + Calendar). Esta spec foca no elo de
  recall. **Ressalva (review adversarial):** se #61 ainda não mergeou, o pouso
  main-first **NÃO** é "apenas a fatia mínima" — porque o `ContextBuilder` órfão de
  `main` precede a reescrita de #61 (sem `blocks`/`layerTimeoutMs`). Portar essas
  capacidades para o builder de `main` é **pré-requisito** e, na prática, traz o grosso
  da CTX-01. Ver §4.4 Contras revistos e §8 risco 6.
- **NÃO** alterar `RagSemanticRecall.recall()` (`semantic-recall.ts`) — a SQL kNN, a
  CTE de recência, o filtro `minScore` e o span já estão completos e testados.
- **NÃO** reescrever `MemoryLayer.build()` (`memory.layer.ts`) — o branch de recall
  já existe; só precisa de `opts.semanticRecall` populado.
- **NÃO** alterar `RagSemanticRecall.recall()` — mas ATENÇÃO ao filtro `minScore`
  **pós-`LIMIT`** (`semantic-recall.ts:112-118`): o SQL faz `ORDER BY <=> LIMIT topK`
  e só DEPOIS o JS filtra `score >= minScore`, então o resultado pode vir com **menos
  que topK** itens mesmo quando há matches qualificados além do `LIMIT`. É uma questão
  de qualidade de recall, não de correção de wiring; documentada como open question
  §8.5. A afirmação "completo e testado" em §1/§2 se refere ao wiring + tenant
  isolation, não a esta característica de truncamento.
- **NÃO** introduzir um segundo caminho de retrieval (recência/keyword sem
  embeddings) — ver Option C rejeitada (§4.3); duplicaria a intenção de recall
  (audit CTX-06/08/09, `runtime-gap-audit-2026-06-02.md:325`) e descartaria a cosine
  kNN já testada.
- **NÃO** deixar o ContextBuilder comprimir internamente: a intenção é que o budget
  seja dono do `enforceBudget` (CTX-02) / fold marker-aware de #61. **Atenção:** isso
  exige passar `globalMaxTokens` sentinela na chamada de `createContextBuilder` —
  `maxContextTokens: undefined` no `ContextInput` **sozinho NÃO basta** (cai no
  `?? 8000`; §4.1 correção / §8 risco 4). `tokenBudget` em `ContextInput` só controla
  o **skip** de recall, não compressão.
- **NÃO** ligar o flag em produção como parte desta entrega; flipar
  `MEMORY_SEMANTIC_RECALL_ENABLED=true` é decisão operacional pós-validação de custo
  pgvector + embedder.

## §4. Architecture proposal

### 4.1 Contrato de recall (o que a pesquisa pediu para definir)

Tudo abaixo já está implementado no código — esta seção fixa os valores como
**contrato** desta entrega; não há código novo de retrieval.

| Parâmetro | Valor | Origem | Decisão |
|---|---|---|---|
| **Query embeddada** | a **última mensagem do usuário, verbatim** (`input.userMessage`) | `ContextInput.userMessage?` (`types.ts:17`); em #61 sourced como `payload.messages.filter(role==="user").map(content).at(-1)` (`ctx-builder execution-handler.ts:1061-1064,1072`); passado a `recall({ query: input.userMessage })` (`memory.layer.ts:140-141`) | **Estável** (determinístico por turno) e **barato de derivar** (`.at(-1)`). **Mas NÃO barato de embeddar:** o `CachingEmbedder` é keyed por `(model, sha256(text))` num cache DB-backed (`rag_embedding_cache`, `embedder.ts:4-5,60-69`); como cada turno traz uma mensagem nova, é tipicamente **cache MISS** → 1 chamada de provider + 1 lookup DB por turno. Rolling-window foi descartado (query mais longa/cara, e History já cobre a janela cronológica). |
| **top-k** | `5` (default) | `MEMORY_SEMANTIC_RECALL_TOP_K` (`env.ts:147`) → `RagSemanticRecall` defaults (`semantic-recall.ts:55-59`) | No caso padrão (instância do registry), o valor do env chega via os `defaults` da instância construída no bootstrap (`stages.ts:483`), NÃO via `opts.semanticRecallTopK` (que fica `undefined`; `recall()` faz `opts.topK ?? this.defaults.topK`, `:68`). |
| **similarity threshold (`minScore`)** | `0.6` (default) | `MEMORY_SEMANTIC_RECALL_MIN_SCORE` (`env.ts:148`) → `defaults` da instância | cosine score = `1 - (embedding <=> query)`; filtro `>= minScore` em `semantic-recall.ts:117-118` — **mas aplicado APÓS o `LIMIT topK`** (open question §8.5: pode retornar < topK itens). **Open question §8.4:** validar 0.6 contra embeddings PT-BR reais de SDR. |
| **excludeRecent** | `10` (default) | `MEMORY_SEMANTIC_RECALL_EXCLUDE_RECENT` (`env.ts:149`) | Pula os 10 mais recentes (CTE `recency_rank > $4`, `semantic-recall.ts:111`) — já no History layer. Deve permanecer alinhado com a janela do History (§8 risco 5). |
| **recall token budget cap** | skip se `estimateTokens(lines) >= tokenBudget - 200` | `budgetOk` em `memory.layer.ts:136-137`; `ContextInput.tokenBudget?` (`types.ts:22`) | Quando o bloco já-montado (profile + facts + summaries) está perto do `tokenBudget`, o recall é **pulado inteiro** (não comprimido). `tokenBudget` é um **hint de skip de tokens, NÃO um teto de latência** — não protege contra um `embed()` lento (§8 risco 1). |
| **truncation por mensagem recuperada** | `200` chars (default) | `recallContentTruncate` (`memory.layer.ts:42-44,149`) | Cada corpo recuperado > 200 chars é cortado com `...` (`:154-155`). |
| **dobra no bloco Memory** | append de `### Memorias semanticamente relevantes` ao mesmo `ContextBlock` (`section: "## Informacoes do contato"`, `compressible: true`, `priority: 40`) | `memory.layer.ts:150-157,175-181` | O recall NÃO é um layer separado; engrossa o bloco Memory existente, que é `compressible` — então o budget global (enforceBudget / fold) pode comprimi-lo por último. |

**Como evita estourar o budget do layer:** três camadas, todas já no código.
(1) **Skip pré-recall** via `budgetOk` (`:136-137`): se o bloco já está apertado, o
recall nem roda. (2) **Truncate por item** (`:149,154-155`): teto por mensagem.
(3) **Compressibilidade do bloco** (`compressible: true`, `:50`): o gate de budget
externo (CTX-02 `enforceBudget` / fold marker-aware de #61) trata o bloco Memory
como comprimível e o reduz por último se o total ainda estourar.

> **⚠️ CORREÇÃO (review adversarial).** A afirmação anterior de que "**não é** o
> ContextBuilder que comprime internamente" é **enganosa**. O
> `ContextBuilder.build()` (`context-builder.ts:21-29` em `main`; `:89-96` em #61)
> usa `limit = input.agentConfig.maxContextTokens ?? this.globalMaxTokens`, e
> `globalMaxTokens` faz `?? 8000` no construtor (`context-builder.ts:14` em `main`;
> `:64` em #61). Logo, mesmo com `maxContextTokens: undefined` (como #61 deixa de
> propósito), o builder **comprime internamente** assim que o total cruzar **8000
> tokens** — `compress()` (`:32-63`) roda. Isso significa que existe um **caminho
> real de compressão dupla**: o ContextBuilder pode comprimir o bloco Memory a
> 8000, e depois `enforceBudget` (CTX-02) comprime de novo no seu próprio budget.
> O único jeito de o builder NÃO comprimir é passar `globalMaxTokens: undefined`
> ao `createContextBuilder` (e não há override de `agentConfig`), garantindo o
> fallback `?? 8000` NÃO ser atingido — o que é **impossível** com a forma atual.
> Para a Option B ser correta, `createContextBuilder` DEVE ser chamado com um
> `globalMaxTokens` deliberadamente alto/sentinela ou o `?? 8000` removido. Ver
> §8 risco 4 (revisto).

### 4.2 Design option A — Deixar PR #61 fechar (do nothing novo em `main`)

`createContextBuilder` em `builder-factory.ts:43` **já** faz
`semanticRecall: deps.memory?.semanticRecall ?? getSemanticRecall()`, e o
`execution-handler` de #61 instancia o builder gated por `CONTEXT_BUILDER_ENABLED
&& contactId != null` (`:250` Model-C, `:1059` surface).

- **Prós:** zero código net-new; é o caminho idiomático e pretendido; sem lógica de
  recall duplicada; sem divergência no hot path.
- **Contras:** só dispara quando `CONTEXT_BUILDER_ENABLED` **E** `contactId != null`
  **E** `MEMORY_SEMANTIC_RECALL_ENABLED` (três gates independentes alinhados). Nada
  faz pelo fallback não-ContextBuilder (`composeSystemPrompt`, que o audit diz
  receber o primeiro job SDR real). E uma spec ramificada de `main` **não pode
  assumir** #61 mergeado, então "do nothing" não é um deliverable em `main`.

### 4.3 Design option C — Caminho de recall mais barato (recência/keyword, sem embeddings) por default

Query de recência/`ILIKE`-keyword sobre `message_embeddings.content` (ou
`contact_facts`) como default; embeddings atrás do flag existente.

- **Prós:** contorna disponibilidade de pgvector + latência da chamada de embed no
  hot path; funciona mesmo com `MEMORY_SEMANTIC_RECALL_ENABLED=false`.
- **Contras (decisivos):** **duplica a intenção de retrieval** num segundo code path
  — exatamente o smell "recall dobrado na MemoryLayer" que o audit já sinaliza
  (CTX-06/08/09, `runtime-gap-audit-2026-06-02.md:325`); relevância keyword é muito
  pior que cosine kNN (o ponto inteiro do D.3); diverge de #61 (que wired o caminho
  de embeddings) → conflito de merge garantido e um `MemoryLayer` confuso de dois
  modos; **joga fora** a SQL de recall já funcionando e testada
  (`semantic-recall.ts`). **Rejeitada.**

### 4.4 Design option B — Wire em `main` alinhado a #61 (recomendada SÓ se #61 bloqueado — ver §4.5 revisto)

Menor mudança que torna o read path alcançável: **um único construction site** que
lê `getSemanticRecall()` e passa os knobs do env ao `MemoryLayer`, consumido por
quem instancia layers em runtime. Reusa verbatim a lógica de recall + fail-open +
budget-skip já completa.

**Forma canônica — a edge de recall é idêntica à de #61 (`builder-factory.ts:38-49`);
o passthrough de knobs e a chamada de `new ContextBuilder` foram CORRIGIDOS no review:**

```typescript
// src/context/builder-factory.ts — createContextBuilder (a edge que conecta CTX-03)
import { ContactFactsRepository } from "../memory/contact-facts.repository.js";
import { getSemanticRecall } from "../memory/registry.js";
import type { MemoryLayerOptions } from "./layers/memory.layer.js";

const memoryOpts: MemoryLayerOptions = {
  // spread FIRST: defaults abaixo só preenchem o que o caller omitiu
  ...deps.memory,
  factsRepo: deps.memory?.factsRepo ?? new ContactFactsRepository(deps.db),
  // ESTA é a edge morta do CTX-03 — lê o registry singleton populado no bootstrap.
  // É EXATAMENTE a linha de #61 (builder-factory.ts:43), sem mais nada:
  semanticRecall: deps.memory?.semanticRecall ?? getSemanticRecall(),
};

const layers = [
  new BaseConfigLayer(),
  new RulesLayer(deps.db),
  new MemoryLayer(deps.db, memoryOpts),  // ← read path agora alcançável
  new HistoryLayer(deps.db),
];
// CUIDADO: globalMaxTokens faz `?? 8000` no construtor — passar um sentinela
// alto (ou Number.POSITIVE_INFINITY) para DESLIGAR a compressão interna e deixar
// o budget único ao enforceBudget/fold (ver §4.1 correção + §8 risco 4).
return new ContextBuilder(layers, {
  globalMaxTokens: Number.POSITIVE_INFINITY, // ou remover o `?? 8000` no builder
  // layerTimeoutMs: ... (NÃO existe em main — ver §8 risco 1; precisa portar de #61)
});
```

> **CORREÇÃO (review adversarial).** A versão anterior desta spec adicionava
> `semanticRecallTopK/MinScore/ExcludeRecent: deps.memory?.semanticRecall…` ao
> `memoryOpts` e chamava isso de "byte-for-byte #61" + "passa os knobs do env".
> **Ambas as afirmações eram falsas:**
> 1. O `builder-factory.ts:38-49` REAL de #61 **NÃO tem** esse passthrough (verificado
>    em `origin/ctx-builder`). Adicioná-lo produziria um diff de merge — quebrando
>    a própria idempotência que a spec prometia.
> 2. As três linhas eram **no-ops funcionais**: liam de `deps.memory?.…`, que o
>    `...deps.memory` (spread) **já copiou**. Reatribuir um campo a si mesmo não faz
>    nada. E **não tocam em env** — `createContextBuilder` não recebe env.
> 3. Os knobs do env **só** chegam ao `RagSemanticRecall` pelos `defaults` da
>    instância construída no bootstrap (`stages.ts:481-487` → `semantic-recall.ts:55-60`);
>    `recall()` usa `opts.topK ?? this.defaults.topK` (`:68-70`). Com `semanticRecallTopK`
>    `undefined` no `MemoryLayer` (caso default, registry-instance), o `recall()` cai
>    nos `defaults` corretos. Logo o passthrough é **desnecessário** no caso padrão.
> Conclusão: a edge correta é **só** `semanticRecall: deps.memory?.semanticRecall ??
> getSemanticRecall()` (idêntica a #61). Se um caller (teste/fake) quiser sobrepor
> topK/minScore sem usar `defaults`, ele passa via `deps.memory` e o spread já cobre.

**Gating (mesma forma de #61, `execution-handler.ts:250/1059` em `ctx-builder`):**

```typescript
if (env.CONTEXT_BUILDER_ENABLED && agentContext.contactId != null) {
  const contextInput = buildContextInput({ /* ... userMessage, tokenBudget ... */ });
  // layerTimeoutMs e globalMaxTokens só existem se o ContextBuilder de #61 foi portado;
  // num main-first, ambos PRECISAM ser adicionados ao builder órfão (ver §8 riscos 1 e 4):
  const builder = createContextBuilder(
    { db },
    {
      layerTimeoutMs: env.CONTEXT_BUILDER_LAYER_TIMEOUT_MS,  // NÃO existe em main — portar
      globalMaxTokens: Number.POSITIVE_INFINITY,             // desliga compressão interna
    },
  );
  const built = await builder.build(contextInput);
  // foldContext lê built.blocks — campo que NÃO existe no BuiltContext de main; portar:
  agentContext.systemPrompt = foldContext(built, doctrineTail, { withMarker: true });
}
// else: fallback composeSystemPrompt + enforceBudget (status quo) permanece intacto
```

**Prós:** a edge de recall (`?? getSemanticRecall()`) é exatamente a de
`builder-factory.ts:43` em #61, então essa linha específica converge idempotente no
merge; reusa recall + fail-open + budget-skip verbatim; hot-path safe **apenas** se o
timeout por layer for portado (ver Contras).

**Contras (REVISTOS — não tão "mitigados" quanto a versão anterior dizia):** em
`main` não há instância runtime do ContextBuilder (CTX-01 unmerged), **e o
`ContextBuilder` órfão de `main` é uma versão ANTERIOR à de #61**. Verificação em
`origin/ctx-builder`: #61 **reescreveu** o builder — adicionou
`blocks: ContextBlock[]` ao `BuiltContext` (`types.ts`), `layerTimeoutMs`+`Promise.race`
por layer (`context-builder.ts:60,65,104`), `contactId?` opcional, e tracking de falha
por layer. O `foldContext` de #61 (`context-wiring.ts:67`) **lê `built.blocks`**, que
**NÃO existe** no `BuiltContext` de `main` (`types.ts:33-38` só tem `systemPrompt/
totalTokens/layersUsed/compressed`). **Consequência:** um pouso main-first que reuse
`foldContext`/o gating de #61 **NÃO é "a fatia mínima de recall"** — exige portar a
reescrita inteira do `ContextBuilder` + criar `context-wiring.ts`. Isso é,
materialmente, **landar o grosso de #61**, não conectar um fio. Portanto a vantagem de
"menor mudança" da Option B sobre a Option A (aguardar #61) **encolhe muito**. Some-se:
adiciona uma dependência de pgvector + embedder ao request path vivo (latência: um
`embed()` + um query HNSW por turno) onde hoje não há — gated OFF por default e coberto
pelo `budgetOk` skip, **mas** sem o `layerTimeoutMs` de #61, o `await` do `embed()` em
`main` não tem teto (§8 risco 1 revisto).

### 4.5 Recomendação e justificativa (founder review)

**Recomendação (REVISTA pelo review adversarial).** A pilha de recall já está
implementada, testada e tenant-isolada (`semantic-recall.ts:62-130`, índice HNSW
`007:49-50`, fail-open + budget-skip em `memory.layer.ts:136-162`); a **única** borda
de recall ausente é `getSemanticRecall()` → `MemoryLayerOptions.semanticRecall`, e essa
linha é idêntica à de `builder-factory.ts:43` em #61. **MAS** a Option B main-first
**não é** o "wire fino" que a versão anterior vendia: o `ContextBuilder` de `main`
precede a reescrita de #61, então um pouso main-first que use `foldContext`/gating de
#61 precisa **portar `blocks`, `layerTimeoutMs` e `globalMaxTokens`-sentinela** ao
builder órfão — isso é, na prática, landar o grosso de CTX-01.

**Implicação para a decisão (§8.1):** o delta de esforço entre "Option B main-first"
e "Option A (aguardar #61)" é **muito menor** do que parecia, porque B essencialmente
reimplementa #61. Se #61 tem previsão de merge curta, **Option A é preferível** (zero
risco de divergência, e o follow-on de recall vira só o teste de integração faltante).
Só fazer B main-first se #61 estiver **bloqueado/sem previsão** — e, nesse caso, tratar
explicitamente como "portar CTX-01 + conectar recall", não como "conectar um fio".

**Independente da opção:** a edge correta de recall é **só** `semanticRecall:
deps.memory?.semanticRecall ?? getSemanticRecall()` (sem o passthrough de knobs
redundante da versão anterior — ver §4.4 correção). **Não** tomar Option C: duplica
retrieval (audit CTX-06/08/09) e descarta a cosine kNN funcionando. Manter recall OFF
por default para o piloto SDR ficar inalterado até custo pgvector + embedder ser
validado; e garantir que `globalMaxTokens` NÃO caia no `?? 8000` (senão dupla
compressão — §4.1 correção / §8 risco 4).

A spec chama explicitamente o **alinhamento de três gates**
(`CONTEXT_BUILDER_ENABLED`, `contactId`, `MEMORY_SEMANTIC_RECALL_ENABLED`). A intenção
de budget é deixar o CTX-02 `enforceBudget` / fold marker-aware de #61
(`context-wiring.ts` `foldContext` + `COMPRESSIBLE_MARKER`) como gate único — **mas
isso só se concretiza se `globalMaxTokens` NÃO cair no `?? 8000`** do `ContextBuilder`
(deixar `maxContextTokens: undefined` NÃO basta — ver §4.1 correção e §8 risco 4). Caso
contrário há compressão dupla (builder a 8000 + enforceBudget depois).

## §5. Implementation plan

> A divisão depende da **open question §8.1** (main-first vs aguardar #61). O plano
> abaixo cobre o pouso **main-first escopado** (Option B); se #61 mergear antes,
> Phase 1 colapsa em "verificar que a edge já existe" e o trabalho net-new vira só os
> testes (Phase 3) + a fatia de fallback Model-C (Phase 2, condicional à §8.2).

### Phase 0 — (só main-first) Portar a reescrita do `ContextBuilder` de #61 (~2h)

Pré-requisito quando #61 NÃO mergeou (§8 risco 6). O `ContextBuilder` de `main` é
anterior à reescrita de #61. Portar de `ctx-builder`:
- `BuiltContext.blocks: ContextBlock[]` (`types.ts:44`) — `foldContext` depende disso.
- `layerTimeoutMs` + `Promise.race(layer.build, timeout)` por layer
  (`context-builder.ts:60,65,104`) — teto de latência no hot path (§8 risco 1).
- `ContextInput.contactId?` opcional + tracking de falha por layer.
Se #61 mergeou, **Phase 0 some** (já está em `main`).

### Phase 1 — Construction site + import do getter (~1h)

**Files:**

- `src/context/builder-factory.ts` — **CRIAR** (se #61 não presente) ou
  **verificar** (se presente): `createContextBuilder(deps, options)` com
  **exatamente** `semanticRecall: deps.memory?.semanticRecall ?? getSemanticRecall()`
  — **SEM** passthrough de `semanticRecallTopK/MinScore/ExcludeRecent` (eram no-ops
  redundantes cobertos pelo `...deps.memory`, e NÃO estão no `builder-factory.ts:38-49`
  REAL de #61; ver §4.4 correção). Importar `getSemanticRecall` de
  `../memory/registry.js`, `ContactFactsRepository`, `MemoryLayer`. Chamar o builder
  com `globalMaxTokens` sentinela (não cair no `?? 8000` — §8 risco 4).
- `src/context/context-builder.ts` — usar a classe (reescrita na Phase 0 se main-first;
  já reescrita em #61).
- `src/config/env.ts` — **adicionar** `CONTEXT_BUILDER_ENABLED` (enum true/false,
  default `false`) e `CONTEXT_BUILDER_LAYER_TIMEOUT_MS` (default `800`) **somente se
  #61 ausente**; se #61 presente, já existem (`ctx-builder env.ts:173,178`). Mesmos
  nomes/defaults para idempotência no merge.

**Result:** `getSemanticRecall()` ganha seu primeiro (e único) consumidor de
produção; `MemoryLayerOptions.semanticRecall` passa a ser populável.

### Phase 2 — Gating no execution-handler (~1.5h)

**Files:**

- `src/runtime/execution-handler.ts`:
  - Adicionar `getSemanticRecall` **não** é necessário aqui — o handler chama
    `createContextBuilder`, que lê o registry. (Hoje o import em `:45` traz só
    `getCondenseQueue, getMessageIndexer`; **não** adicionar `getSemanticRecall` ao
    handler — manter a leitura encapsulada no factory, como em #61.)
  - Surface path (~`:1043-1074` no shape de #61): após resolver `contactId` (bigint),
    se `env.CONTEXT_BUILDER_ENABLED && contactId != null`, chamar `buildContextInput`
    (`userMessage` = última mensagem do usuário; `tokenBudget` = hint, NÃO
    `maxContextTokens`), `createContextBuilder({ db }, { layerTimeoutMs, globalMaxTokens: <sentinela> })`,
    `builder.build(...)`, e `foldContext(built, doctrineTail, { withMarker: true })`.
    Fail-open: qualquer erro → manter `composeSystemPrompt` (`:933`) + `enforceBudget`
    (`:1312`).
  - Model-C path (~`:227-267` no shape de #61): mesmo gating, se aplicável. **Mas ver
    §8.2** — se o piloto SDR vai pelo Model-C/`composeSystemPrompt` e este bypassa o
    builder, conectar recall só aqui pode deixar o piloto SEM recall.
- `src/runtime/context-wiring.ts` — **CRIAR** (se #61 ausente) `buildContextInput` +
  `foldContext`. Deixar `agentConfig.maxContextTokens: undefined` **não basta** para
  evitar compressão interna — o gate único é garantido pelo `globalMaxTokens` sentinela
  na chamada de `createContextBuilder` (§4.1 correção / §8 risco 4), não por aqui.
  **Se #61 presente, NÃO recriar** — reusar (e confirmar o sentinela de `globalMaxTokens`).

**Result:** o builder (e portanto o read path de recall) roda no hot path atrás dos
três gates; fallback `composeSystemPrompt` intacto.

### Phase 3 — Testes (~2h) — ver §6

**Files (sob `tests/**` — NUNCA co-localizar em `src/`):**

- `tests/unit/context/builder-factory.test.ts` (NOVO)
- `tests/unit/context/memory-layer.recall.test.ts` (NOVO)
- `tests/integration/memory/semantic-recall.integration.test.ts` (ESTENDER existente)

## §6. Testing strategy

> **CI note (load-bearing):** `vitest.config.ts` `include` é `tests/**/*.test.ts`. Os
> arquivos unit existentes em `src/context/*.test.ts` **NÃO** são pegos por esse
> include — toda cobertura nova **DEVE** viver sob `tests/unit/**` para realmente
> rodar. (Constraint do projeto: nunca co-localizar testes em `src/`.)

### Unit (sem DB, sempre roda)

1. **`tests/unit/context/builder-factory.test.ts`** — o construction site:
   - assert que `createContextBuilder({ db })` lê `getSemanticRecall()` e injeta no
     `MemoryLayer` (set via `setSemanticRecall(fake)` antes; inspecionar via build com
     fake recall que retorna `RecalledMessage[]` fixo).
   - assert que degrada a `undefined` (sem bloco de recall, **sem throw**) quando o
     registry está unset — usar `resetMemoryRegistryForTests()` (`registry.ts:43`).
   - assert passthrough dos knobs `topK/minScore/excludeRecent`.
2. **`tests/unit/context/memory-layer.recall.test.ts`** — `MemoryLayer.build()` com
   `semanticRecall` fake (stub `recall()` → `RecalledMessage[]` fixo):
   - assert que o bloco `### Memorias semanticamente relevantes` renderiza
     (`memory.layer.ts:151`).
   - assert truncate em `recallContentTruncate` (default 200, `:149,154-155`).
   - assert **skip** quando `userMessage` ausente ou `budgetOk=false`
     (`:136-138`) — passar `tokenBudget` pequeno para forçar skip.
   - **fail-open:** stub `recall()` que lança → `build()` ainda retorna o bloco
     profile/facts (cobre `:159-161`).
   - Usar `tests/fakes/` (dir já existe no repo).

### Integration (RUN_INTEGRATION=1, Postgres+pgvector real)

- **ESTENDER** `tests/integration/memory/semantic-recall.integration.test.ts`
  (já gated `const RUN = process.env.RUN_INTEGRATION === '1'; describe.skipIf(!RUN)`,
  convenção do repo — 16 arquivos assim). Adicionar caso que:
  1. semeia `message_embeddings` (com `embedding` real, vários `message_at`);
  2. `setSemanticRecall(new RagSemanticRecall(db, embedder, { topK, minScore, excludeRecent }))`;
  3. constrói um `MemoryLayer` (ou o builder via `createContextBuilder`) e
     `build(input)` com `userMessage`;
  4. **asserts:** o bloco de recall aparece; a **recency-exclusion** é honrada (os N
     mais recentes NÃO reaparecem); itens abaixo de `minScore` são filtrados.
  - É o teste end-to-end faltante que o audit implica.
- Manter SQL pura de vetor atrás de `RUN_INTEGRATION` — `postgres:16-alpine` no CI
  **não** tem pgvector (CLAUDE.md prod note: precisa da imagem `bevox-postgres`).

### Regression

- Com `CONTEXT_BUILDER_ENABLED=false` (default): comportamento idêntico ao status quo
  (`composeSystemPrompt` + `enforceBudget`); nenhum query a `message_embeddings`.
- Com `MEMORY_SEMANTIC_RECALL_ENABLED=false`: registry `undefined` → `MemoryLayer`
  não renderiza recall (mesmo que o builder rode).

## §7. Migration & rollback

**Sem migração de schema.** `message_embeddings` + índice HNSW já existem (migration
007). pgvector é dependência de boot já pré-checada (`stages.ts:460-467`).

**Ativação gradual (três gates independentes):**

1. **Merge desta entrega:** read path **conectado** mas **inerte** —
   `CONTEXT_BUILDER_ENABLED=false` e `MEMORY_SEMANTIC_RECALL_ENABLED=false` (defaults).
   Zero mudança observável.
2. **Ligar o builder** (`CONTEXT_BUILDER_ENABLED=true`) com recall ainda OFF: o
   ContextBuilder monta o prompt (profile/facts/summaries via MemoryLayer), recall
   permanece undefined (sem bloco). Valida o builder isolado do recall.
3. **Ligar recall** (`MEMORY_SEMANTIC_RECALL_ENABLED=true`): bootstrap pré-checa
   pgvector e popula o registry; o read path agora conectado acende. Validar latência
   (`memory.semantic_recall` span) e custo de embedder antes de prod.

**Rollback:** flipar qualquer flag para `false` desativa sem perda de dados. Reverter
o código volta ao `composeSystemPrompt`/`enforceBudget` (status quo). Nenhum rollback
é destrutivo. **Convergência com #61:** se #61 mergar depois, o `?? getSemanticRecall()`
e o reuso do mesmo `builder-factory.ts`/`context-wiring.ts` tornam o merge um no-op
estrutural (resolver conflitos preferindo a forma de #61).

## §8. Risks & open questions

### Risks

1. **Latência/custo no hot path — SEM teto em `main`.** Ligar recall adiciona um
   `embedder.embed([query])` (chamada de rede ao provider LLM) + um query HNSW por
   turno ao request path vivo, que hoje não tem nenhum. **O `embed()` é `await`ado
   dentro do `MemoryLayer.build()` sem timeout** (`memory.layer.ts:140`), e o
   `ContextBuilder` de `main` faz um bare `Promise.all` sem teto por layer
   (`context-builder.ts:19`). Portanto, num pouso main-first, **um provider de embedding
   lento/pendurado trava o turno inteiro** — o `budgetOk` skip NÃO protege contra
   latência (só contra estouro de tokens), e o `CachingEmbedder` só ajuda em hits de
   cache (a query é a última mensagem do usuário, frequentemente nova → cache miss).
   #61 resolve isso com `CONTEXT_BUILDER_LAYER_TIMEOUT_MS` (default 800ms,
   `ctx-builder env.ts:178`) + `Promise.race(layer.build, timeout)`
   (`ctx-builder context-builder.ts:104`). **Num pouso main-first, isto NÃO é
   opcional:** Phase 1 DEVE portar o `layerTimeoutMs`+`Promise.race` do builder de #61
   (não basta adicionar a env var — o `ContextBuilder.build` de `main` precisa do
   `Promise.race`). Sem isso, recall on é um risco de disponibilidade no hot path.

2. **Disponibilidade de pgvector.** O recall usa `<=>` + HNSW (`007:49-50`); o
   `postgres:16-alpine` do CI (CLAUDE.md / `j-build-04`) não tem a extensão. Bootstrap
   pré-checa pgvector (`stages.ts:460-467`) e aborta o stage D.3 se ausente — então um
   prod mal-configurado com o flag on mas sem pgvector **falha no boot, não por
   request** (aceitável). Manter testes de vetor RUN_INTEGRATION-gated.

3. **Colisão de merge com PR #61.** #61 já cria o exato construction site
   (`builder-factory.ts:43`) e o gating (`execution-handler.ts:250/1059`). Um wire
   main-first divergente arrisca construção dupla de `MemoryLayer` / flags
   conflitantes. Mitigação: pousar com a forma de #61 e os mesmos guards, de modo que
   o `?? getSemanticRecall()` os torne idempotentes; resolver merge preferindo #61.

4. **Double-counting de budget — pior do que a versão anterior reconhecia.**
   `buildContextInput` de #61 deixa `maxContextTokens: undefined`
   (`context-wiring.ts:34`) achando que isso desliga a compressão interna. **Mas NÃO
   desliga:** `ContextBuilder.build` usa `limit = maxContextTokens ?? globalMaxTokens`,
   e `globalMaxTokens` cai em `?? 8000` no construtor (`context-builder.ts:14` em main,
   `:64` em #61). Logo, com `maxContextTokens: undefined`, o limite vira **8000** e o
   `compress()` roda assim que o total cruzar isso — **antes** do `enforceBudget`
   (CTX-02), criando um caminho real de **compressão dupla**. Mitigação CORRIGIDA:
   passar `globalMaxTokens: Number.POSITIVE_INFINITY` (ou um sentinela alto) ao
   `createContextBuilder`, OU remover o `?? 8000` do builder, para que `enforceBudget`/
   fold marker-aware seja de fato o gate único. `tokenBudget` em `ContextInput` segue
   controlando só o **skip** de recall, não compressão. (Nota: isto vale **também** para
   #61 — a spec de CTX-01 deveria verificar se #61 já passa um `globalMaxTokens` que
   evita o `?? 8000`; pelo que se vê em `builder-factory.ts`, `createContextBuilder`
   propaga `options.globalMaxTokens`, que vem `undefined` dos call-sites → `?? 8000`
   ativo. Flag para o review de #61.)

5. **Duplicação de recall com History.** O recall exclui os N mais recentes
   (`excludeRecent` default 10, `semantic-recall.ts:111`), mas se a janela do History
   layer e o `excludeRecent` derivarem, mensagens recuperadas podem reaparecer — audit
   CTX-06/08/09 já sinaliza "recall dobrado". Manter `excludeRecent` alinhado com a
   janela do History. **Nota adversarial:** `excludeRecent` é por **mensagem**
   (`recency_rank > N` sobre `message_embeddings`), enquanto a janela do History layer
   pode ser medida em **turnos/tokens** ou só nas mensagens que cabem no budget — os
   dois eixos não são comensuráveis. "Manter alinhado" não é trivial; antes de ligar,
   verificar empiricamente quantas mensagens o History de fato inclui vs. `excludeRecent`,
   senão o recall pode re-emitir mensagens que o History já mostrou (ou pular mensagens
   relevantes que o History NÃO mostrou).

6. **`ContextBuilder` de `main` ≠ `ContextBuilder` de #61 (descoberta do review).**
   Verificado em `origin/ctx-builder`: #61 reescreveu o builder órfão — `BuiltContext`
   ganhou `blocks: ContextBlock[]` (`types.ts:44`), o `build()` ganhou
   `layerTimeoutMs`+`Promise.race` por layer e tracking de falha por layer
   (`context-builder.ts:60,65,104`), e `ContextInput.contactId` virou opcional. O
   `foldContext` de #61 **depende** de `built.blocks`. Logo, qualquer reuso main-first
   de `foldContext`/gating de #61 exige **portar essa reescrita** — não é compatível
   com o `ContextBuilder` atual de `main`. Isto é o que dissolve a premissa "fatia
   mínima" da Option B (§4.4). Mitigação: ou aguardar #61 (Option A), ou aceitar
   explicitamente que main-first = portar CTX-01.

### Open questions

1. **Main-first (Option B) vs aguardar #61 (Option A)?** Decide se a spec entrega um
   construction site em `main` ou só uma nota de alinhamento + o teste de integração
   faltante. **Recomendação REVISTA:** dado que main-first ⇒ portar o grosso da CTX-01
   (risco 6), **Option A (aguardar #61) é preferível salvo se #61 estiver bloqueado**.
   Se #61 não tem previsão, fazer B **mas escopar honestamente** como "portar CTX-01 +
   conectar recall", com o esforço (§7 estimate) ajustado para cima — não as ~4–6h da
   versão original (essa estimativa pressupunha "fio fino", agora invalidado).
2. **Caminho do piloto SDR é Model-C ou o builder?** Quando #61 está ativo, recall só
   dispara com `contactId != null`. O audit diz que **Model-C contorna CTX-01** — se
   o piloto SDR roda pelo Model-C e este bypassa o ContextBuilder, CTX-03 pode
   precisar de wiring **também** no `composeSystemPrompt` (`src/sdr/compose.ts:59`).
   Confirmar antes de prometer recall no piloto. **Isto é
   provavelmente o caminho mais relevante:** o audit diz que `composeSystemPrompt` (não
   o ContextBuilder) recebe o primeiro job SDR real — então conectar recall só no
   builder pode deixar o piloto SDR **sem recall**, derrotando o propósito.
3. **Registry singleton visível ao worker que monta o contexto?** Bootstrap seta via
   `setSemanticRecall` no singleton de processo; CLAUDE.md diz que tudo roda
   in-process, mas verificar que não há fronteira de worker separada entre bootstrap e
   o execution-handler.
4. **`minScore=0.6` validado?** Default em `env.ts:148` — é placeholder ou validado
   contra embeddings PT-BR reais de SDR? Calibrar com dados reais antes de ligar em
   prod (afeta precision/recall do bloco).
5. **Filtro `minScore` pós-`LIMIT` é aceitável?** Em `semantic-recall.ts:112-118` o SQL
   faz `ORDER BY embedding <=> query LIMIT topK` e **só então** o JS filtra
   `score >= minScore`. Consequência: se entre os topK vizinhos mais próximos alguns
   ficarem abaixo de `minScore`, eles são descartados e o bloco vem com **menos que
   topK** itens — mesmo que existam matches qualificados além do `LIMIT`. Para um topK
   pequeno (5) e `minScore` alto (0.6), é fácil o recall retornar 0–2 itens quando
   havia mais relevantes logo após a posição 5. Não é bug de wiring (escopo desta spec),
   mas afeta a utilidade do recall. **Decisão necessária:** aceitar como está, ou
   mover o filtro `minScore` para dentro do SQL (`WHERE 1 - (embedding <=> q) >= minScore`
   antes do `LIMIT`) — uma mudança de 1 linha em `semantic-recall.ts` que requer relaxar
   o non-goal "NÃO alterar `recall()`". Recomendo abrir como item separado e NÃO afirmar
   "recall completo e correto" sem esta calibração.

## §9. Definition of done

- [ ] **Phase 0 (NOVO — só main-first):** Portar a reescrita do `ContextBuilder` de #61
  para o builder órfão de `main` — `blocks: ContextBlock[]` em `BuiltContext`,
  `layerTimeoutMs`+`Promise.race` por layer, `contactId?` opcional. **Pré-requisito**
  para reusar `foldContext`/gating de #61 (§8 risco 6). Se #61 mergeou, Phase 0 some.
- [ ] **Phase 1:**
  - [ ] `src/context/builder-factory.ts` — `createContextBuilder` com **exatamente**
    `semanticRecall: deps.memory?.semanticRecall ?? getSemanticRecall()` (idêntico a #61,
    **SEM** passthrough de `semanticRecallTopK/MinScore/ExcludeRecent` — eram no-ops
    redundantes e divergiam de #61; ver §4.4 correção). `getSemanticRecall` ganha seu
    único consumidor de produção.
  - [ ] `createContextBuilder` chamado com `globalMaxTokens` que NÃO caia no `?? 8000`
    (sentinela alto/∞), para não comprimir internamente (§4.1 correção / §8 risco 4).
  - [ ] `env.ts` — `CONTEXT_BUILDER_ENABLED` (default false) +
    `CONTEXT_BUILDER_LAYER_TIMEOUT_MS` (default 800), idempotentes com #61 (somente se
    #61 ausente).
- [ ] **Phase 2:**
  - [ ] `execution-handler.ts` — gating `CONTEXT_BUILDER_ENABLED && contactId != null`
    no surface path (e Model-C, condicional à §8.2); fallback `composeSystemPrompt` +
    `enforceBudget` intacto.
  - [ ] `context-wiring.ts` — `buildContextInput`/`foldContext` (reusar de #61 se
    presente; senão criar — depende de Phase 0 ter exposto `built.blocks`).
  - [ ] Timeout de recall efetivo (Phase 0 já portou o `Promise.race`; confirmar que
    cobre o `embed()` do MemoryLayer — §8 risco 1).
- [ ] **Phase 3:**
  - [ ] `tests/unit/context/builder-factory.test.ts` — lê getter, degrada a undefined
    (`resetMemoryRegistryForTests`), e que NÃO injeta knobs espúrios.
  - [ ] `tests/unit/context/memory-layer.recall.test.ts` — render/truncate/skip/fail-open.
  - [ ] `tests/integration/memory/semantic-recall.integration.test.ts` ESTENDIDO —
    seed → setSemanticRecall → build → assert bloco + recency-exclusion (RUN_INTEGRATION).
- [ ] Recall OFF por default validado (defaults dos três flags = inerte).
- [ ] Audit finding CTX-03 validado como closed (`getSemanticRecall()` com consumidor).
- [ ] Sem regressões (unit + integration); `CONTEXT_BUILDER_ENABLED=false` = status quo.
- [ ] Code review aprovado (AI Engineer + verificação de compatibilidade com #61).

## §10. References

- **Audit finding:** `runtime-gap-audit-2026-06-02.md:254` (CTX-03), `:213` (CTX-01
  builder órfão), `:325` (CTX-06/08/09 recall dobrado).
- **Issue:** bernardTavares/bevox-harness#43 (D.3 / accountDeniedTools POC); abrir
  issue CTX-03 dedicada se preferível.
- **PR #61 / `origin/ctx-builder` (CTX-01, não assumir mergeado) — verificado neste review:**
  - `src/context/builder-factory.ts:38-49` — `createContextBuilder` com
    `semanticRecall: deps.memory?.semanticRecall ?? getSemanticRecall()` (`:43`).
    **CONFIRMADO: NÃO tem passthrough de `semanticRecallTopK/MinScore/ExcludeRecent`** —
    o `memoryOpts` é só `...deps.memory` + `factsRepo` + `semanticRecall`.
  - `src/context/context-builder.ts` (#61 — **reescrito** vs `main`): `:60,65`
    (`layerTimeoutMs ?? 800`), `:104` (`Promise.race(layer.build, timeout)`), `:64`
    (`globalMaxTokens ?? 8000` — compressão interna ATIVA), `:144,151` (`blocks` no
    assemble). `src/context/types.ts:44` (#61) — `BuiltContext.blocks: ContextBlock[]`
    (NÃO existe no `main`).
  - `src/runtime/context-wiring.ts:34` (`maxContextTokens: undefined` — NÃO desliga
    compressão por si só), `:26` (`buildContextInput`), `:61,67` (`foldContext` lê
    `built.blocks`), `:3,79` (`COMPRESSIBLE_MARKER`).
  - `src/runtime/execution-handler.ts:250` (Model-C gating), `:1059` (surface gating)
    — `CONTEXT_BUILDER_ENABLED && contactId != null`; `:1061-1064,1072` (`lastUserMsg`
    = `messages.filter(role==="user").map(content).at(-1)` → `userMessage`).
  - `src/config/env.ts:173` (`CONTEXT_BUILDER_ENABLED`), `:178`
    (`CONTEXT_BUILDER_LAYER_TIMEOUT_MS` default 800).
- **Código fonte em `main` (verificado):**
  - `src/memory/registry.ts:31` (`getSemanticRecall` — ZERO consumidores), `:28-33`
    (`setSemanticRecall`/getter), `:43` (`resetMemoryRegistryForTests`), `:1-9`
    (docstring que assume o consumidor).
  - `src/memory/semantic-recall.ts:62-130` (`RagSemanticRecall.recall`),
    `:55-60` (defaults topK=5/minScore=0.6/excludeRecent=10), `:64-66` (tenant
    isolation throw), `:104,112` (`<=>` cosine), `:111` (`recency_rank > $4`),
    `:112-118` (`ORDER BY <=> LIMIT topK` e SÓ DEPOIS filtro `minScore` em JS —
    pode retornar < topK; ver §8.5). `:82-83` (`embed([query])` — chamada de provider).
  - `src/rag/embedder.ts:4-5,60-69` (`CachingEmbedder` keyed por `(model, sha256(text))`,
    cache DB-backed `rag_embedding_cache`), `:139` (`sha256`).
  - `src/context/layers/memory.layer.ts:35-45` (`MemoryLayerOptions`), `:114-132`
    (sibling facts/summary path), `:136-137` (`budgetOk`), `:138-162` (branch de
    recall), `:149,154-155` (truncate), `:159-161` (fail-open).
  - `src/context/types.ts:17` (`userMessage?`), `:22` (`tokenBudget?`),
    `:8` (`ContextInput.agentConfig.maxContextTokens?`), `:4` (`contactId: bigint` —
    **obrigatório** em `main`; #61 relaxa para opcional). `:33-38` (`BuiltContext` em
    `main` — SEM `blocks`).
  - `src/bootstrap/stages.ts:447-498` (`init-memory-d3`), `:450-457` (early-return),
    `:460-467` (pré-flight pgvector), `:471` (CachingEmbedder), `:481-487`
    (`setSemanticRecall` + knobs do env).
  - `src/config/env.ts:143-149` (`MEMORY_SEMANTIC_RECALL_*`).
  - `src/runtime/execution-handler.ts:45` (import registry SEM `getSemanticRecall`),
    `:239,933,1266` (`composeSystemPrompt`), `:1303` (comentário "Full 5-layer
    ContextBuilder integration is a follow-up"), `:1312` (`enforceBudget`).
  - `src/sdr/compose.ts:59` (`composeSystemPrompt` — NÃO lê memória/recall).
  - `src/context/context-builder.ts` (builder órfão em `main`, nunca instanciado em src
    non-test): `:14` (`globalMaxTokens ?? 8000` — compressão interna ativa), `:19`
    (`Promise.all` SEM timeout por layer), `:21,24,28` (`compress` quando total > limit),
    `:32-63` (`compress`). **Precede a reescrita de #61** (sem `blocks`, sem
    `layerTimeoutMs`/`Promise.race`).
  - `migrations/007_message_embeddings.sql:49-50` (índice HNSW `vector_cosine_ops`).
  - `tests/integration/memory/semantic-recall.integration.test.ts` (teste de recall
    existente, RUN_INTEGRATION-gated — a ESTENDER).
  - `vitest.config.ts` (`include: tests/**/*.test.ts` — testes em `src/` não rodam).
- **Specs relacionadas:**
  - `2026-06-02-context-builder-runtime-instantiation-design.md` (CTX-01 — o builder
    runtime que possui o construction site; esta spec é a fatia de recall).
  - `2026-06-02-idempotency-key-full-threading-design.md` (formato de header desta
    casa).
