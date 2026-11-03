# SDR Fase C — Correlation Bridge Design (Resposta → Cadência Suspensa)

- **Data:** 2026-05-16
- **Status:** Design only (somente desenho — nenhuma implementação autorizada).
- **Relação:** detalha o item §6.3.1 ("elo de correlação resposta→workflow") de `2026-05-16-sdr-intelligence-module-design.md`. É gate de início da Fase C.
- **Decisão registrada:** **Modelo C (Híbrido)** como modelo de dono do turno (§3).
- **Origem:** counsel do Backend Architect, aterrado e verificado contra a árvore atual do harness.

---

## 1. O gap, preciso

Existem dois caminhos de entrada **disjuntos** hoje:

| Caminho | Entrada | Sabe | Resolve workflow como |
|---|---|---|---|
| Raciocínio | `bullmq-consumer.ts:24` → `handleExecution()` (`execution-handler.ts:385`) | identidade conta/contato, messages, `agent_config` | `agentDef.workflow` estático em `execution-handler.ts:611` |
| Resume | `resume-server.ts:110` / `subscriber.ts:75` → `loadBySuspendToken(token, accountId)` | **suspendToken + accountId** | linha exata por token |

A resposta do prospect é um job BullMQ normal: chega no caminho de **raciocínio**, sem `suspendToken`. O caminho de resume é inalcançável a partir dela. `agentDef.workflow` (linha 611) é estático por *definição de agente* ("este agente roda o workflow X do zero"), nunca "a instância #N do workflow X está suspensa esperando ESTE contato". `listSuspended(accountId, limit)` (`state-store.ts:156`) é o único lookup account-scoped e é grosso demais (várias cadências por conta, sem coluna de contato).

**O elo é a função que falta:** `(account_id, contact_key, message) → resolver a linha workflow_executions suspensa certa → conduzi-la`.

---

## 2. Chave de correlação e multiplicidade

### 2.1 Chave real

`workflow_executions` tem `account_id` mas **nenhuma coluna de contato**. Uma conta SDR roda muitas cadências concorrentes (uma por prospect). Chave natural:

```
(account_id, contact_key) → a instância de cadência suspensa ativa
```

`contact_key` é a identidade estável por-prospect já presente no payload (`payload.conversation.id` é usado hoje como `conversationKey` em `execution-handler.ts:465-468`). Esse binding **não é persistido em lugar nenhum hoje** — é o gap central de dados (§5).

> **Forward-compat (atenção da spec de implementação):** o caminho runtime usa o schema local `executionPayloadSchema` (`execution-handler.ts:88-118`: `account`/`account_id`/`conversation`/`agent_config`/`messages`); `contact` **não** é campo declarado (só via passthrough). Existe um segundo schema ADR-governado em `src/integration/execution-payload.schema.ts` (`workspace_id` UUID canônico / `conversation_id` flat / `account_id` deprecado) que **não** é o usado por `handleExecution`. A spec de implementação deve (a) cravar o campo concreto exato que produz `contact_key` e assertar presença na sonda; (b) registrar que uma migração futura para o schema ADR (`account_id`→`workspace_id`, `conversation` objeto→`conversation_id` flat) muda diretamente os campos da chave de correlação.

`(account, contact)` não é único no tempo (re-enrollment após cadência anterior terminar). O alvo deve ser filtrado por `status='suspended'` **E** canal resumível por reply: `resume_event`/`suspend_reason` ∈ `REPLY_RESUMABLE` ("aguardando resposta inbound"), **nunca** uma cadência suspensa só em timer (essa é trabalho do `cleanup.ts`, não do caminho de reply) nem aguardando re-qualificação do AE.

**Chave final:** `(account_id, contact_key, resume_event ∈ REPLY_RESUMABLE)` → no máximo uma linha ativa por política de seleção.

> `REPLY_RESUMABLE` é vocabulário **introduzido por esta spec** (não herdado da spec principal), ancorado nas colunas reais `resume_event`/`suspend_reason`. A spec de implementação deve **enumerar o conjunto exato** de valores de `resume_event` que o compõem e confirmar que nenhum é timer-only ou aguardando re-qualificação do AE (exclusões de §2.1).

### 2.2 Política de seleção: 0, 1, N

- **0 matches** — nenhuma cadência suspensa para o contato. **Fall-through ao caminho de raciocínio existente, inalterado.** Caso dominante de todo tráfego não-SDR; no-op com custo de um SELECT indexado.
- **1 match** — caso pretendido. Handoff conforme Modelo C (§3).
- **N matches** — raro por construção (contato em duas cadências reply-awaiting simultâneas = erro de modelagem), mas determinístico, **nunca por juízo de LLM**:
  - **Tie-break determinístico:** maior `workflow_version` → `created_at` mais recente (enrollment mais novo vence) → `id` lexicográfico. Escolhe exatamente um alvo de resume.
  - Perdedores → **alarme operacional** (`onCorrelationAmbiguity` → telemetria, classe `bad-data`). Não auto-resumidos, não auto-falhados; ambiguidade é defeito de integridade para humanos, não algo a mascarar.
  - Razão: resumir todos corrompe múltiplas FSMs de uma mensagem; falhar todos perde engajamento. Pick-one-newest + alarme é a única opção que preserva fidelidade e expõe o defeito.

### 2.3 Onde vive o índice de correlação

**Decisão: nova tabela dedicada `workflow_correlation`** — não coluna em `workflow_executions`, não reuso de `listSuspended`.

Rejeitados: (a) coluna `contact_key` + índice parcial em `workflow_executions` — acopla roteamento cross-cutting na linha de estado durável, força migration na tabela quente, sem lar para a semântica de binding (qual `resume_event` o contato pode satisfazer). Aceitável só como fallback. (b) reuso de `listSuspended` + filtro em app — scan O(suspensas-por-conta) + match de contato em dado que não existe na linha; non-starter.

A tabela é **índice/projeção, não fonte de verdade** — `workflow_executions` permanece autoritativa para status. Mapeia `(account_id, contact_key)` → `workflow_execution_id` + `suspend_token` corrente + `resume_event` aguardado, **mantida pelos hooks de ciclo de vida já emitidos**: `onSuspended` (`engine.ts:284`), `onResumed` (`engine.ts:127`), `onWorkflowTerminal` (`engine.ts:241`). Lookup do elo = uma query point-indexed; blast radius isolado do state store.

### 2.4 Novo ponto de decisão — inserção concreta

Roda **após validação de payload + dedup + criação de sessão, antes do pipeline (MessageAnalyzer) e do roteamento** — inserido entre `execution-handler.ts:447` (sessão criada) e `:519` (`withSpan("execution.pipeline")`).

```
447  sessão criada
448  ── 2.5 SONDA DE CORRELAÇÃO (novo) ───────────────────────
       se agent_config.sdr_profile presente:
         row = correlationStore.resolveActive(accountId, contactKey, REPLY_RESUMABLE)
         se row:  → dispatch Modelo C (§3), depois RETURN
       (senão fall-through inalterado)
     ─────────────────────────────────────────────────────────
519  withSpan("execution.pipeline") ... MessageAnalyzer
571  router.resolve
604  agentRegistry.resolve
611  precedência estática de workflow (INALTERADA — só caminho from-scratch)
```

Por que antes do pipeline/router e não no bloco `:611`: o `:611` é keyed no `agentDef.workflow` do agente *estaticamente resolvido* e roda `runWorkflow()` **do zero** (`engine.ts:50`, cria nova linha em `engine.ts:70`) — estruturalmente não retoma instância existente. O fato de correlação ("este contato é dono da instância suspensa X") independe de classificação de intenção e deve curto-circuitar **antes** de gastar uma chamada LLM do MessageAnalyzer. Decisão por identidade só (barata, determinística) — coerente com "juízo procedural → guard determinístico, não LLM".

---

## 3. Modelo de dono do turno — Modelo C (Híbrido) [DECIDIDO]

Primitiva de resume compartilhada: `resumeWorkflow(store, suspendToken, accountId, payload, {definition, context, toolExecutor})` (`engine.ts:94`) — já idempotente em linhas não-suspensas (`engine.ts:110-117`), version-checked (`engine.ts:118-125`), com contextFactory+toolExecutor já cabeados (reuso do resume-server/subscriber).

### 3.1 Fluxo do Modelo C

O elo resolve a linha suspensa mas **não** retoma imediatamente:

1. Carrega `row.state` (estado FSM via `loadBySuspendToken`, JSONB, parseado/validado no mapeamento de linha — confirmar o símbolo exato de validação/migração de estado na spec de implementação).
2. Injeta projeção compacta do estado FSM (Account Status atual, step de cadência, transições próximas permitidas) no contexto de raciocínio como a `ContextLayer` sales-state (spec §5.3, **não-compressível**).
3. O loop de raciocínio existente (`runSurfaceAgentLoop`, `execution-handler.ts:196`) produz a resposta governada pela doutrina **com o estado FSM como contexto vinculante**.
4. **Após** a resposta confirmada enviada, o elo retoma o workflow com `resumePayload = {inboundMessage, reasoningOutcome, observedSignals}`; o **guard determinístico** da FSM (spec §6.4 — score PACT / presença de evidência, nunca LLM) consome esse payload, escolhe a transição e re-suspende.

### 3.2 Por que C (justificativa da decisão)

1. **Único consistente com o resto da spec.** O valor da Fase A — doutrina L0, anti-over-claim, os 4 certification gates — vive no loop de raciocínio, governado por evals L5 sobre `traceCallback`. Modelo A descartaria tudo isso (workflow produz a resposta). C preserva.
2. **Honra o §6.4 não-negociável.** Transições da FSM continuam dirigidas por guard determinístico; o LLM informa a *resposta*, nunca a *transição*. Injetar estado como contexto não enfraquece o guard (payload carrega *evidência observada*; guard é determinístico).
3. **Fonte única de verdade, blast radius contido.** `workflow_executions` continua autoritativa; única mudança no caminho de raciocínio é uma `ContextLayer` não-compressível **já planejada** (spec §5.3), sem editar engines (respeita §3.2). Índice de correlação é projeção derivada por hooks que já disparam.
4. **Latência aceitável.** Latência percebida ≈ Modelo B (raciocínio vivo + 2 reads baratos: um SELECT indexado + um read JSONB pequeno). O avanço da FSM é pós-resposta, mas *awaited antes do ack do job BullMQ* — paga o custo fora do caminho crítico percebido.

### 3.3 Modelos descartados (registro)

- **A — Workflow assume:** máxima fidelidade FSM e zero blast no raciocínio, mas a resposta sai do workflow (não do surface agent) → **descarta doutrina/eval da Fase A** para prospects que responderam; pior latência. Falha de resume = perda silenciosa de resposta.
- **B — Responde + sinaliza assíncrono:** melhor latência, mas dois escritores independentes (raciocínio responde sem saber estado FSM; sinal fire-and-forget em canal **não-durável** `subscriber.ts:34` "mensagens publicadas sem subscriber são perdidas") → **split-brain**, FSM dessincroniza; sinal perdido → cleanup **mata cadência viva já respondida** (pior falha). Viola §6.4.

---

## 4. Corridas e concorrência

### 4.1 Camadas de idempotência

1. **Execução (existe):** `harness:dedup:${execution_id}` SET NX 1h (`execution-handler.ts:407-417`). Protege entrega duplicada do *mesmo* execution; **não** protege duas execuções distintas (duas respostas rápidas) competindo a mesma linha suspensa.
2. **Resume (existe, implícita):** `resumeWorkflow` early-return em linha não-`suspended` (`engine.ts:110-117`). Idempotente mas *lossy* — segundo chamador recebe no-op e a mensagem que carregava não é aplicada.
3. **Elo (novo, obrigatória):** antes de resumir, reivindicar a linha com **UPDATE condicional atômico** (§4.3). Camada 2 evita corrupção; Camada 3 evita *perda silenciosa* tornando o perdedor observavelmente falho (→ retry) em vez de no-op.

### 4.2 Resume vs reativação por timeout (a colisão perigosa)

`WorkflowCleanupJob.tick()` (`cleanup.ts:43-60`) faz `listExpired()` então `store.update(row.id,{status:'failed',suspendToken:null,...})`. `resumeWorkflow` faz `loadBySuspendToken` então `store.update(row.id,{status:'running',...})`. São **dois read-then-write não atômicos na mesma linha sem lock** (`state-store.ts:113 update` é `UPDATE ... WHERE id`, sem predicado de versão). Interleaving perigoso: cleanup lê como expirada → elo resume (running, limpa `timeout_at`) → cleanup escreve `failed` → **cadência viva recém-respondida marcada como falha**.

**Mitigação:** toda transição mutadora vira **UPDATE condicional guardado** com pré-condição no `WHERE`:
- Expiração do cleanup: `UPDATE ... SET status='failed' WHERE id=$ AND status='suspended' AND timeout_at<=$now`. 0 linhas afetadas ⇒ foi resumida; skip silencioso.
- Claim do elo/resume: `UPDATE ... SET status='running', suspend_token=null WHERE id=$ AND status='suspended' AND suspend_token=$token`. 0 linhas ⇒ outro venceu; o elo trata como "perdi o claim", **não** produz resposta duplicada, reporta status terminal à telemetria ou re-enfileira.

Implementação recomendada: métodos explícitos `claimForResume(id, token)` e `claimForExpiry(id)` (não adicionar predicados ao `update()` genérico — manteria o contrato de concorrência otimista legível e não arrisca todos os callers de `update()`).

### 4.3 Concorrência otimista em `workflow_executions`

Sem coluna de versão/lock hoje. Adicionar `lock_version int NOT NULL DEFAULT 0`, bumpado em todo `update()`; métodos de claim assertam `AND lock_version=$expected`. Converte os dois hazards de §4.2 em winner-takes-all determinístico com perdedor observável (0 linhas afetadas → aprende que perdeu → retry/alarme, nunca no-op silencioso em mutação de estado).

### 4.4 Ordenação de respostas rápidas

Prospect manda "sim" e 3s depois "na verdade me liga terça" → dois jobs, duas execuções, ambas correlacionam a mesma linha. `execution_id`s distintos ⇒ dedup de execução **não** dedupa. Com o claim (§4.3): reply 1 reivindica `suspended→running`; reply 2 acha `running` → 0 linhas, perde. Reply 2 **não** pode ser dropado:
- **Rejeita + requeue com backoff:** reply 2 throws → BullMQ retry; no retry o workflow já re-suspendeu no próximo step, claim de reply 2 sucede como *próximo* inbound. Preserva ordem causal se o workflow re-suspende reply-awaiting; aceitável para semântica de cadência multi-dia (spec §6.3.2 já aceita fidelidade temporal poll-driven).
- Requisito do elo: contenção de respostas rápidas **observavelmente serializada** (claim) e perdedor **retried, não dropado**. FIFO estrita por-contato no ingress BullMQ é mudança de topologia de fila, **fora de escopo** (risco residual §6).

---

## 5. Modelo de dados — migrations aditivas mínimas

Duas migrations aditivas. Nenhuma mudança destrutiva. JSONB de `workflow_executions` intocado.

**Migration 1 — `workflow_correlation` (índice):**

| Coluna | Tipo | Nota |
|---|---|---|
| `account_id` | int/bigint | casa com `workflow_executions.account_id` |
| `contact_key` | text | identidade estável por-prospect (conversation/contact do payload) |
| `workflow_execution_id` | uuid/text FK → `workflow_executions.id` | instância dona |
| `suspend_token` | text | token corrente (espelho; nullable quando running) |
| `resume_event` | text | qual `resume_event`/`suspend_reason` o binding satisfaz (filtro REPLY_RESUMABLE) |
| `status` | text | espelho do status da linha dona (poda de índice parcial) |
| `updated_at` | timestamptz | tie-break / staleness |

- **Índice único parcial** `UNIQUE (account_id, contact_key) WHERE status='suspended' AND resume_event IN (REPLY_RESUMABLE)` — força no DB a invariante "≤1 cadência reply-resumable ativa por contato"; tentativa de duplo enrollment falha alto (defeito de integridade exposto, mantém o alarme de N-match vazio por construção).
- **Índice** `(account_id, contact_key, status)` para a sonda (lookup point, sub-ms).
- **Mantida por hooks existentes** (sem cirurgia em engine): `onSuspended` (`engine.ts:284`) → upsert com token+resume_event; `onResumed` (`engine.ts:127`) → running/limpa token; `onWorkflowTerminal` (`engine.ts:241`) → terminal (poda do índice parcial). Projeção derivada, nunca mantida à mão.

**Migration 2 — concorrência otimista:** `lock_version int NOT NULL DEFAULT 0` em `workflow_executions`; `update()` (`state-store.ts:113`) bumpa; novos `claimForResume`/`claimForExpiry` assertam; `listExpired` (`state-store.ts:145`) + escrita do cleanup (`cleanup.ts:49`) migram para forma guardada.

Ambas aditivas (colunas/tabela + métodos novos); callers existentes de `update()` inalterados (bump de lock interno).

---

## 6. Riscos residuais (aceitar ou desenhar à parte)

| Risco | Tratamento |
|---|---|
| **Idempotência partida sob retry** — resposta já enviada + avanço da FSM falhou → retry BullMQ não pode re-responder. Requer marcador "resposta-enviada" keyed por `(account,contact,hash da msg)`, distinto do dedup de execução, com avanço da FSM retried independentemente. | **Principal residual — desenhar explicitamente na spec de implementação**, não delegar ao dedup de 1h. |
| **Ordenação estrita de replies** — §4.4 garante no-loss + ordem causal eventual, não FIFO estrita. FIFO por-contato no ingress é design de topologia de fila à parte. | Aceitar; fora de escopo do elo. |
| **Fidelidade temporal poll-driven** — janela resume-vs-cleanup agora race-safe (§4.3), mas precisão de timing continua poll-bound (`cleanup.ts:26`, default 5min). | Aceitar (pré-existente, spec §6.3.2). |
| **Estabilidade do `contact_key`** — todo o elo assume `contact_key` estável ao longo da cadência de dias. Se o Bevox muda o identificador no meio, o índice orfana a linha suspensa → morre por timeout (falha perigosa §4.2). | **Validar com o Bevox** e assertar; idealmente fallback secundário (resolver por `account_id`+{phone,email} quando `contact_key` falha). Dependência, não interno do elo. |
| **Version drift em semanas** — inalterado (spec §6.3.3); disciplina de manter versões vivas (`listActiveVersions`, `state-store.ts:171`). | Elo emite evento de telemetria classe `workflow_version_removed` (espelha `resume-server.ts:124`) em vez de falhar silenciosamente. |

---

## 7. Resumo de pontos de inserção (para implementador futuro)

| Preocupação | Arquivo:linha | Mudança (aditiva) |
|---|---|---|
| Sonda de correlação | `execution-handler.ts` ~447→519 (novo passo 2.5) | gated em `sdr_profile`; um SELECT indexado; curto-circuito no hit |
| Primitiva de resume (reuso) | `engine.ts:94 resumeWorkflow` | inalterada |
| Precedência estática de workflow | `execution-handler.ts:611` | inalterada (só caminho from-scratch) |
| Índice de correlação | nova `workflow_correlation` + hooks em `engine.ts:284/127/241` | Migration 1 |
| Concorrência otimista | `state-store.ts:113 update`, novos `claimForResume`/`claimForExpiry`; `cleanup.ts:49` guardado; `listExpired` `state-store.ts:145` | Migration 2 |
| Tie-break / alarme ambiguidade | módulo do elo (novo) | hook telemetria `onCorrelationAmbiguity` |
| Marcador idempotência partida | módulo do elo + Redis (chave separada de `harness:dedup:`) | design de risco residual |

---

## 8. Fora de escopo

- Implementação (qualquer parte). Somente desenho.
- Design do marcador de idempotência partida sob retry (risco residual principal — spec de implementação própria).
- FIFO estrita por-contato no ingress BullMQ (design de topologia de fila à parte).
- Validação da estabilidade do `contact_key` com o Bevox (dependência externa a confirmar).
