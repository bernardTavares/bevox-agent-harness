# Gap Analysis — bevox-harness — 2026-06-02

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica.
> HEAD auditado: `86b70e4`. Canon: `bevox-knowledge` HEAD local + PRD v1.1
> (`10_prd/bevox-harness/2026-05-15-bevox-harness-prd-v1.md`) + ADRs harness 016–019
> + ADRs `_shared` 005/006/007/016/021 + `runtime-topology.md`.
> Método: 1 censo canônico + 16 trilhas de investigação por categoria (via agentes
> especialistas locais) + verificação adversarial de **todos** os achados CRÍTICO/ALTO
> + crítico de completude. 62 subagentes, ~4,7M tokens. Detalhe de método em §Notas.
>
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é
> o único artefato escrito.

---

## Resumo executivo

O harness está **substancialmente mais maduro** do que o `CLAUDE.md` sugere (MCP, RAG,
workflows, evals, OTel, streaming, security já existem), mas tem **dois bloqueadores de
piloto de impacto catastrófico e correção trivial** que ninguém pegou porque o ambiente
de validação está cego: (1) **o worker não inicia a partir da imagem compilada `dist/`
sob Node 20** — o `SkillLoader` faz `require()` de skills ESM no bootstrap e estoura
`ERR_REQUIRE_ESM` → `process.exit(1)`; passa em dev (`tsx`) e morre em prod
(`node dist/index.js` em `node:20-alpine`); e (2) **o callback final `/complete` é
rejeitado pelo backend com HTTP 400** em praticamente toda execução, por divergência de
contrato (`response` vs `response_text`, `usage`/`sentiment` ausentes, `strategy:"workflow"`
fora do enum do backend). Some-se a isso o **filtro de permissão ser advisory-only** (o
executor resolve o registry inteiro em runtime, ignorando as 3 camadas) e o **trap de
migration `accounts(id)`** que aborta um deploy-do-zero na 001.

O achado de **primeira ordem**, porém, é de enquadramento (§F0): **o caminho VIVO de
produção é um agente SDR específico (`dispatchModelC` / `src/sdr/` / workflow `sdr-cadence`
/ migration 008), não o harness genérico de `SchedulerAgent` + pipeline de 10 passos que o
PRD v1.1 descreve.** Subsistemas-bandeira do PRD — o **ContextBuilder de 5 camadas** e os
**3 modos de autonomia (ADR-018)** — são **código morto** que não roda em job real.

**Veredito para o piloto:** **NÃO-GO no estado atual.** Os bloqueadores são poucos e de
baixo esforço (os 4 primeiros somam < 1 dia de engenharia); depois deles o piloto é viável
em modo `autonomous_supervised`. **GA exige** fechar o cluster de autonomia (3 modos),
idempotência, gate de permissão em runtime e o contrato de streaming.

**Tally pós-verificação:** **13 CRÍTICO · 20 ALTO · 46 MÉDIO · 34 BAIXO** (113 achados).
Verificação adversarial dos 33 CRÍTICO/ALTO: **0 refutados**, 25 confirmados, 19 ajustados
(quase todos *downgrades* — a auditoria pecou por excesso de severidade, não por inventar
problemas). Confiança alta nos achados que citam `arquivo:linha` de código não-teste.

---

## F0 — Achado de primeira ordem: o produto vivo diverge do produto canônico

**Severidade: CRÍTICO (de enquadramento) — não tem "fix", tem decisão de produto.**

O PRD v1.1 (§2, §5) e o `CLAUDE.md` descrevem um **harness genérico**: pipeline de 3 agentes
→ `AgentRouter` → `SchedulerAgent` de superfície rodando ReAct sobre o `ContextBuilder` de
5 camadas, com fluxo de 10 passos. O **caminho que de fato executa no piloto** é outro:
`dispatchModelC` (`src/runtime/execution-handler.ts`), que **pula o pipeline e o
ContextBuilder**, injeta doutrina SDR via `composeSystemPrompt(systemPrompt, sdrProfile)`,
roda o workflow declarativo `sdr-cadence`, e persiste estado em `migrations/008_sdr_account_state.sql`.

- **Evidência:** `src/runtime/execution-handler.ts:790-795` e `:1098` (prompt vivo = `composeSystemPrompt`, não o builder); `:240` (Model-C usa `toolRegistry.all()` sem filtro); `:332-342`, `:887-891` (marcadores `FOLLOW-UP (post-Fase-C)`, `observedSignals` vazio); `src/runtime/sdr-profile.schema.ts`; `migrations/008_sdr_account_state.sql`.
- **Impacto:** a maior parte da auditoria — e do próprio PRD — descreve um sistema que **não é o que recebe o primeiro job real**. Quem revisar precisa decidir conscientemente: o piloto é um **piloto de SDR**, e o PRD §2/§5 está **materialmente desatualizado** quanto a isso. Vários achados de "código morto" (CTX-01, SKILLS/EM, a-reasoning) só são "mortos" porque o caminho Model-C os contorna.
- **Ação:** atualizar PRD §2/§5 para nomear o Model-C/SDR como o caminho vivo, **ou** criar um PRD/spec próprio do SDR; e **re-priorizar a auditoria do subsistema SDR** (hoje sub-auditado — ver §Notas).
- **Origem:** crítico de completude + `CTX-01` + `DEBT-08` + `EM-04`.

---

## Achados por severidade

> Convenção: cada achado lista IDs das trilhas que o encontraram (achados independentes que
> convergem aumentam a confiança), `arquivo:linha` de evidência, e esforço estimado (`Eh`).
> `[CANON-STALE]` = o gap é no documento canônico, não no código. `[verificado]` = re-lido
> por verificador adversarial independente no HEAD.

### 🔴 CRÍTICO — bloqueia o piloto (13)

#### C1 — Worker não inicia a partir de `dist/` sob Node 20 (`ERR_REQUIRE_ESM`)
`MCP-001` · Eh≈3h · [verificado, reproduzido E2E]
O `SkillLoader` é instanciado no **bootstrap stage 5** (`src/bootstrap/stages.ts:335`) e usa
`createRequire(import.meta.url)` (`src/skills/skill-loader.ts:19`) para `require()` o
`index.js` de cada skill — que é **ESM** (`dist/skills-builtin/calendar/cancel-appointment/index.js:1`).
Sob Node 20, `require()` de ESM lança `ERR_REQUIRE_ESM`; o loader propaga e o stage faz
`process.exit(1)` (o próprio docstring admite: *"never start the worker"*, `skill-loader.ts:29-31`).
- **Blast radius:** o **worker de produção** (`node dist/index.js`, runtime `node:20-alpine` do Dockerfile) **não sobe**. Também derruba o binário `bevox-mcp`.
- **Por que ninguém pegou:** dev usa `npm run dev` → `tsx` (ESM-nativo, funciona); a suíte de testes não roda (ver C-build / `j-build-01`); não há smoke de boot a partir de `dist/`. Falha só no caminho compilado = exatamente prod.
- **Fix:** trocar `localRequire(entryPath)` por `await import(pathToFileURL(entryPath).href)` em `src/skills/skill-loader.ts`. ~3h + smoke de boot do `dist/`.

#### C2 — `/complete` rejeitado pelo backend: `response` vs `response_text` → HTTP 400
`H-CB-01` · Eh≈2h · [verificado]
O harness monta o corpo de `/complete` com a chave `response` (`src/integration/bevox-callback.ts:39-44`,
`src/runtime/execution-handler.ts:1257-1262`); o backend valida com `CompleteCallbackSchema`
que exige `response_text: z.string()` obrigatório (`../bevox-backend/src/integration/harness-callbacks.schema.ts:45-56`).
Ausente → `.parse()` lança → **400 antes de qualquer persistência**, no caminho final de
**toda execução normal**.
- **Fix:** renomear `response`→`response_text` no `CompletePayload` (ou mapear no `post()`). Atualizar o teste que consagra o contrato errado (`tests/unit/integration/bevox-callback.test.ts:120-122`, ver H-CB-06).

#### C3 — `/complete` sem `usage` (obrigatório no backend) em 6 call sites → HTTP 400
`H-CB-02` · Eh≈3h · [verificado]
Backend exige `usage` (`required: [response_text, sentiment, strategy, usage]`). No harness
`usage` é opcional e **omitido** em: request-human sem surface agent (`execution-handler.ts:225-229`),
reply do Model-C/SDR (`:297-301`), `mapWorkflowResultToCallback` (`:637-658`), error boundary,
e nas tools `send-message`/`request-human`.
- **Fix:** garantir `usage` sempre presente (default `{prompt_tokens:0,completion_tokens:0}`) — idealmente real (ver A-token / `DEBT-02`).

#### C4 — `strategy:"workflow"` e `"handoff"` rejeitados pelo enum do backend → HTTP 400
`H-CB-04` · Eh≈2h · [verificado] · `[CANON-STALE: PRD §10.2 diz que strategy aceita workflow]`
Enum do backend = `[direct, react, plan-execute, rewoo, request-human, failed]`. O harness
emite `"workflow"` em `mapWorkflowResultToCallback` (`execution-handler.ts:653-657`) e em
`AgentResponse.strategy` (`src/reasoning/engine.ts:65`) — **atingido sempre que um agente
declara workflow, i.e., o caminho SDR-cadence do piloto** — e `"handoff"` em
`src/tools/messaging/request-human.tool.ts:38-41`.
- **Fix (cross-repo):** adicionar `workflow` ao schema/OpenAPI do backend (o PRD já pede) **e** corrigir `request-human.tool.ts` para usar `request-human` (que está no enum).

#### C5 — Tools `send-message`/`request-human` enviam `/complete` malformado → HTTP 400
`H-CB-05` · Eh≈1h · [verificado]
`send-message` envia só `{response: p.message}` (sem `sentiment`/`strategy`/`usage`),
`request-human` envia `{response:"", strategy:"handoff"}` (`src/tools/messaging/send-message.tool.ts:37-39`,
`request-human.tool.ts:38-41`). São **STOP signals**: quando um surface agent os usa (o
`scheduler` tem `send-message` em `permissions.required`), o `/complete` final é exatamente esse.
- **Fix:** centralizar `/complete` num helper único que sempre preenche os 4 campos.

#### C6 — Duplo `/complete` + corrupção: `send-message` dispara um, o handler dispara outro
`J1` · Eh≈4h · [verificado]
`send-message.tool.ts:37` chama `sendComplete` com a mensagem real; sendo STOP
(`src/reasoning/react.ts:176`), a loop para e o handler envia **outro** `/complete`
(`execution-handler.ts:1256`) com o **envelope** `{sent:true}`, **sobrescrevendo** a resposta
do cliente. Backend recebe **dois** POST `/complete`.
- **Fix:** `send-message` apenas sinaliza (retorna a mensagem em `data`); o **único** `sendComplete` é o do handler, usando a mensagem real.

#### C7 — Filtro de permissão é advisory-only: executor ignora as 3 camadas em runtime
`PERM-01` · Eh≈6h · [verificado] · canon: PRD §5.7, §8.7
As 3 camadas só decidem **quais tools entram no prompt** (`filterPermittedTools` → lista
passada ao loop). **Não há gate de autorização em runtime:** o `toolName` escolhido pelo LLM
vai direto ao executor, que resolve contra o **registry inteiro**
(`execution-handler.ts:1143-1158`, `:1188`; `src/reasoning/react.ts:111-116`). No caminho
Model-C é pior: `:240` usa `toolRegistry.all()` **sem filtro algum**.
- **Impacto:** uma tool negada por política, se o LLM a nomear, **executa**. Anula a camada de segurança central antes de produção.
- **Fix:** gate em `executeTool` (`~:1143`): após `resolve(toolName)`, checar pertencimento ao set `permittedTools`/`evaluatePermission` e negar com `PERMISSION_DENIED`.

#### C8 — Modo de autonomia inexistente: `execution_mode` nunca é parseado/lido
`SKILLS-01` + `EM-01` + `DEBT-03` · Eh≈8–24h · [verificado] · canon: **ADR-018 (aceita)**, regra `harness-payload.md`
O backend **sempre** envia `execution_mode` obrigatório (`../bevox-backend/src/integration/harness-dispatch.schema.ts:30`);
o schema vivo `executionPayloadSchema` (`execution-handler.ts:408-434`) usa `.passthrough()`
e **não declara o campo** — o modo é silenciosamente engolido (grep `execution_mode` em
`src/` = 0 leituras de runtime). Existem **dois schemas concorrentes**: o "canônico"
(`src/integration/execution-payload.schema.ts`, só exporta o enum) e o inline parseado.
- **Severidade condicional:** ADR-018 §75/§112 manda campo **obrigatório**. **Se algum org
do piloto estiver em `manual_assisted`/`copilot`, isto é CRÍTICO de segurança** (ver C9: as
tools executam efeito real sem aprovação). Se o piloto for **só `autonomous_supervised`**, o
risco operacional cai para ALTO (feature ausente, sem efeito colateral indevido).

#### C9 — `executeOrPropose` é código morto: tools de mutação **sempre** executam efeito real
`SKILLS-02` + `EM-02` · Eh≈16–40h · [verificado] · canon: ADR-018 §92-106, regra `harness-tools.md`
A base `MutationTool.executeOrPropose()` (caminho duplo correto) existe em
`src/tools/_shared/mutation-tool.ts:53-97` mas é **órfã**: `grep "extends MutationTool"` = 0.
As 5 tools de mutação (`create/cancel/reschedule-appointment`, `waitlist-add`, `send-message`)
são `ToolDefinition` planas que **sempre** chamam o efeito real
(`src/tools/calendar/create-appointment.tool.ts:34-59`; `execution-handler.ts:1143-1188`).
- **Impacto:** em `manual_assisted`/`copilot` a IA **cria appointment / envia mensagem de
verdade sem aprovação humana** — exatamente o efeito colateral oculto que ADR-018 (Opção C)
existe para impedir. **Acoplado a C8.**
- **Nota:** os shapes divergem (`MutationTool {ok,result}/ToolContext` vs registry vivo `{success,data}/AgentExecutionContext`) — fechar exige unificação, não só herança.

#### C10 — Nenhuma mutação emite `Idempotency-Key` → efeito duplicado em retry
`SKILLS-03` + `DEBT-01` + `J2` · Eh≈12h · [verificado] · canon: regra `harness-tools.md` (ADR-023), PRD §15.3
`MutationTool.deriveIdempotencyKey()` existe mas é morta e nem usa sha256
(`mutation-tool.ts:103-106`). `calendar-client.post/patch` (`:48-57`) e `bevox-callback`
(`:11-19`) enviam só `Content-Type`/`Authorization`. O backend irmão tem o seam de
idempotência, mas nunca recebe a chave.
- **Impacto:** com retry do BullMQ (ver C13) ou escalação dupla, `create-appointment`/
`send-message` **duplicam efeito externo** — o risco mais palpável do PRD §15.3, ainda aberto.
- **Fix:** `Idempotency-Key = sha256(execution_id + ":" + step_index + ":" + tool_name)`; propagar `step_index` ao `ToolContext`.

#### C11 — Deploy-do-zero aborta na migration 001 (`REFERENCES accounts(id)` órfã)
`MIG-001` + `J4` · Eh≈2h · [verificado, reproduzido contra Postgres limpo] · canon: `CLAUDE.md`, `runtime-topology.md` §6.5
`migrate.mjs` aplica em ordem lexical (`scripts/migrate.mjs:17-19`); a 001 roda primeiro e
referencia `accounts(id)`, tabela que **nenhuma migration cria** (`migrations/001…:11,52,80`).
Postgres rejeita → rollback → abort. O workaround (stub manual) só existe no `CLAUDE.md`,
**não automatizado**. **5 FKs órfãos** no total, não 3: 001×3, 007×1, 008×1 (`MIG-002`).
A 011 só **recria** as tabelas (DROP+CREATE, `MIG-003`) **depois** — não conserta a 001.
- **Fix definitivo (recomendado, `MIG-004`):** nova `000_accounts_stub.sql` com
`CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY);` (ordena antes da 001,
idempotente, sobrevive ao guard de `schema_migrations`). Editar a 001 **viola imutabilidade**
(já aplicada nos ambientes vivos — `migrate.mjs:22-28` nunca re-roda). Opcional: `012_drop_accounts_stub.sql` após a 011.

#### C12 — Dedup + retry do BullMQ: re-tentativa do mesmo `execution_id` é pulada em silêncio
`J6` · Eh≈5h · [verificado]
A dedup (`SET harness:dedup:{id} NX EX 3600`) é correta para entregas duplicadas, mas quando
`handleExecution` lança (`execution-handler.ts:1365`), o BullMQ re-tenta o **mesmo job**; na
re-tentativa o `SET …NX` retorna `null` (chave ainda viva 1h) e o handler faz **return
silencioso** (`:731`). Uma execução que **falhou** pode **nunca** ser re-executada com efeito.
- **Fix:** em falha, DELetar a dedup key antes do throw (ou usar lock curto liberado no `finally` + confiar na idempotência de C10).

#### C13 — `usage` no `/complete` é efetivamente `0/0` e `UsageTracker` nunca é chamado
`DEBT-02` · Eh≈8h · [verificado] · `[CANON-STALE: PRD §16.1 marca "token accounting real" como [x]]`
`execution-handler.ts:1252-1253` calcula `totalTokens = 0` ("Observations don't carry token
counts") e envia `{prompt_tokens: totalTokens, completion_tokens: 0}` (`:1261`).
`UsageTracker.record()` (`src/observability/usage-tracker.ts:20-28`, insere em
`execution_usage`) tem JSDoc "Phase 5 will wrap this" e **não é instanciado** fora de teste.
- **Precisão (correção do crítico):** não é um literal `0` cravado nos dois campos — é
`prompt_tokens=totalTokens` com `totalTokens` derivado como 0; efeito líquido `0/0`. Contradiz
PRD §16.1 [x] e o invariante §12.12. Custo por execução (§5.17) também fica zerado.

> **Nota de severidade (C8/C9):** mantidos em CRÍTICO porque o produto **promete** os 3
> modos e o cliente-alvo começa em `manual_assisted` (ADR-018 §Contexto). Se a decisão de
> piloto for **`autonomous_supervised` exclusivo e explícito**, rebaixe C8/C9 para ALTO.

---

### 🟠 ALTO — bloqueia GA, não bloqueia piloto (20)

| ID(s) | Achado | Evidência | Eh |
|---|---|---|---|
| `CTX-01` | **ContextBuilder + 5 camadas são órfãos** — nunca instanciados em prod; prompt vivo = base + doutrina SDR (`composeSystemPrompt`). O subsistema-bandeira do PRD §5.5 não roda. | `execution-handler.ts:790-795,852`; `context/*` | 10 |
| `CTX-02` | **Token budget não é enforçado em runtime** — `compress()`/truncação só via builder morto; `max_context_tokens` ausente do payload. | `context-builder.ts:21-29`; `execution-handler.ts:1123-1127` | 5 |
| `PERM-02` | **Audit-rows de MCP nunca persistem** — `executionId="mcp-<uuid>"` viola `permission_audit.execution_id UUID NOT NULL`; INSERT falha e é engolido. | `src/mcp/execution-context.ts:25`; `migrations/011…:167`; `src/security/audit.ts:30-44` | 2 |
| `PERM-03` | **Invariante 13 parcial** — escalação-a-humano e **execução** de mutação não são auditadas; só decisões allow/deny de filtro. | `src/permissions/evaluator.ts:43-48`; `execution-handler.ts:225-230` | 4 |
| `PERM-05` | **Camada 2 (conta/org) morta** — `accountDeniedTools` nunca populado; `payload.skills` nunca consumido. | `execution-handler.ts:1112-1116`; `permission-context.ts:32` | 5 |
| `EM-03` | **Harness não emite `proposals`** — `CompletePayload` sem o campo; o seam `executeProposals()` do backend (que executa após aprovação) nunca recebe nada. | `bevox-callback.ts:39-44`; `../bevox-backend/.../seams.ts:110-127` | 6 |
| `H-CB-03` | **Streaming bate em `/stream-chunk` (rota inexistente → 404)** com shape incompatível; a função `/stream` correta (`{chunk,index}`) é código morto. Canon §5.19/§16.1 marca streaming como entregue. | `bevox-stream-callback.ts:37`; `stream-publisher.ts:170-184` | 8 |
| `H-CB-06` | Teste de contrato e2e ausente; o único teste consagra o contrato **errado** (`body.response`). | `tests/unit/integration/bevox-callback.test.ts:120-128` | 4 |
| `DEBT-02` | (ver C13 — listado em CRÍTICO) | — | — |
| `SKILLS-04` | **Doc afirma que `execution_mode`/`executeOrPropose` foram entregues ("Wave 7/G1")** — código prova o contrário; cria falsa confiança. | `.claude/rules/harness-payload.md:21`; `skills/.../execution-payload.md:47`; `.claude/hooks/SessionStart.sh:9` | 3 |
| `SKILLS-05` | **Dois modelos paralelos vivos** (tools planos vs skills declarativas) — PRD §5.6 declara skills como canônico, runtime consome o `ToolRegistry` plano. | `skill-registry.ts:48-62`; `skills-builtin/README.md:9-13` | 16 |
| `EM-05` | **Zero testes por modo** (manual/copilot/autonomous) — regra `harness-tools.md` exige. | `tests/unit/tools/*`; grep em `tests/` = 0 | 5 |
| `a-reasoning-04` | Observações acumuladas corrompem `shouldContinue`; plan-execute termina cedo e re-escala em *thrash*. | `src/reasoning/plan-execute.ts:284-288` | 6 |
| `DEBT-02`→`TEN-003` | Migrations 001–009 mantêm `account_id`/FK `accounts(id)` — OK como lexicon histórico (011 reverte), mas é a raiz do trap C11. | `migrations/001…:11`; `008…:18` | 3 |
| `MIG-004` | Trade-off de fechamento: editar 001 viola imutabilidade; **000-stub é o único fix definitivo não-destrutivo**. | `migrate.mjs:22-28`; `011…:31` | 1 |
| `DOC-01` | **`CLAUDE.md` documenta payload OBSOLETO** (`account` em vez de `organization_id` UUID) e só 3 callbacks — instruções autoritativas erradas. | `CLAUDE.md:195-199`; `execution-handler.ts:416` | 1 |
| `DOC-02` | `.claude/rules/harness-payload.md` normatiza campos que **não existem** no schema vivo (`execution_mode`, `workspace_id`, `idempotency_key`). | `harness-payload.md:13-16`; `execution-handler.ts:408-434` | 1 |
| `j-build-01` | **Suíte unit não inicia** — binding nativo `@rolldown/binding-linux-x64-gnu` ausente; **0 sinal de teste vivo** (138 arquivos unit). | `node_modules/rolldown/...`; vitest@4→vite@8 | 1 |
| `j-build-02` | **CI lint está VERMELHO** — `prettier --check` falha em 146 arquivos; `ci.yml:25` reprova todo push a `main`. | `.github/workflows/ci.yml:25`; `package.json:30` | 1 |
| `D-02` | 16/22 testes de integração pulados no CI (gated por `RUN_INTEGRATION=1`) — Postgres/BullMQ/callbacks sem gate. | `tests/integration/*` | 2 |

---

### 🟡 MÉDIO — degrada qualidade (46)

Agrupados por tema. Todos com evidência `arquivo:linha` no anexo de método; aqui os de maior relevância.

**Autonomia / payload (extensões de C8–C10):** `DEBT-03` (dois schemas de payload concorrentes;
`ExecutionMode`/`executeOrPropose` nunca parseados — `execution-handler.ts:408-434`); `EM-04`
`[CANON-STALE]` (delivery-tracker marca `harness-execution-mode` como **delivered** com gate
de evidência tautológico — `40_roadmap/_shared/delivery-tracker.yml:762-765`).

**Permissões:** `PERM-04` (audit floода: 1 row de "allow" por tool por execução — contradiz o
escopo "decisões sensíveis"); `PERM-06` (testes do evaluator STALE, sub-cobrem as 3 camadas;
staleness escondido porque `tsconfig` só checa `src/`).

**Reasoning (todos rebaixados de ALTO) — RESOLVIDOS (plano `2026-06-03-reasoning-engine-quality`):**
`a-reasoning-01` **[RESOLVED]** (Reflexion `learnedContext` nunca chegava ao prompt — agora
`reflexionNotes` é campo tipado em `AgentExecutionContext`, escrito por `augmentContext` sem cast
e lido por `ReactEngine.step` que o prefixa à doutrina); `a-reasoning-02` **[RESOLVED]** (engine
escalado era descartado antes do `synthesize` — `runSurfaceAgentLoop` agora retorna
`SurfaceLoopResult { observations, engine, escalated, escalationChain }`; main + Model-C
sintetizam com o engine escalado e carimbam atributos de span de escalação); `a-reasoning-03`
**[RESOLVED]** (ReWOO `executeWaves` era dead-code — a branch escalate-to-rewoo agora dirige
`executeWaves` com gates J8 deadline / J9 cost e captura de `CyclicDependencyError`, respeitando
`dependsOn`).

**Context:** `CTX-03` (read path do recall semântico D.3 morto — `getSemanticRecall()` sem
consumidor de produção); `CTX-04` (tokenizer é heurística `words×1.3`, não BPE — budget pode
errar muito em PT-BR/código/emoji); `CTX-05` (`compress()` faz corte proporcional único, pode
não atingir o budget).

**Callbacks / contrato:** `H-CB-06` (ver ALTO). **Bootstrap:** `BOOT-002` (shutdown nunca
fecha DB pool nem Redis — `index.ts` passa `registerShutdownHandlers({})` vazio); `BOOT-005`
(cobertura ZERO em `src/bootstrap/*` — o caminho que gateia o piloto não é exercitado).

**Migrations:** `MIG-002` (5 FKs órfãos, não 3); `MIG-003` (011 é DROP+CREATE destrutivo por
design — OK em pré-prod vazio); `TEN-002` (`scripts/eval-golden.ts:141` usa `account_id:0`
legado — **mas NÃO quebra o build**: `scripts/` está fora do `tsconfig include:['src']`).

**MCP:** `MCP-002` (`mcp-tools.md` documenta **5 tools fictícias** — `inspect_execution`,
`simulate_execution`, etc. — que **não existem** no código nem no PRD); `MCP-003` (trap de
config: `.env` com `MCP_SERVER_TOKEN=` vazio aborta o processo até em stdio); `MCP-005` (testes
MCP não rodam — binding rolldown + dependem do binário quebrado de C1).

**Pilot risks:** `J3` (payload inválido no Zod é **descartado em silêncio** — `return` sem throw;
sem retry, sem DLQ, sem callback; job some — `execution-handler.ts:710`); `J5` (`/complete` no
caminho de **falha** é best-effort — execução pode sumir sem o backend saber); `J8` (sem timeout
global de wall-clock; `synthesize` final sem timeout; trabalho órfão continua após timeout de
fase — sem `AbortController`); `J9` (sem `max_cost_usd` com aborto — `cost-calculator` mede mas
não corta); `J10` (`updateStatus("running")` no início do `try` **não** é best-effort — um blip
do backend derruba a execução antes de qualquer trabalho); `J7`/`DEBT-04` `[CANON-STALE]`
(circuit breaker/retry **já existem** no LLM — `RetryDecorator(CircuitBreakerDecorator())` — mas
o Calendar Service segue `fetch` cru; PRD §15.4 parcialmente obsoleto).

**DLQ:** `DEBT-05` (não há DLQ dedicada — consumidor só faz rethrow; mas `harness-payload.md`
afirma que enfileira em `bevox.harness.dead-letter` — **regra descreve algo inexistente**).

**SDR (sub-auditado):** `DEBT-08` (marcadores `FOLLOW-UP (post-Fase-C)`, `observedSignals` vazio,
"not yet wired" no caminho Model-C — funcionalidade SDR declarada parcial).

**Doc drift `[CANON-STALE]`:** `DOC-03` (numeração de ADR diverge — código/rules citam
ADR-006/021/023 do esquema do hub que **colidem** com ADRs canônicas diferentes em
`bevox-knowledge`); `DOC-04` (`CLAUDE.md` omite ~10 subsistemas existentes); `DOC-05`
(`harness-tools.md` exige `executeOrPropose` que as tools reais não usam); `DOC-06`/`DOC-07`
(PRD §11.1 diz "7 migrations" + invariante `account_id` — contradiz 11 migrations + ADR-019);
`DOC-08` (OpenAPI `agent-harness-v1.yaml` usa `account_id`, sem `organization_id`/`execution_mode`/`stream`).

**Coverage (estática — ver limitação metodológica):** `D-01` (`runSurfaceAgentLoop`+`dispatchModelC`
sem teste unit; 1373 linhas); `D-04` (sem thresholds e CI não roda `--coverage`); `D-05`
(`scheduler.agent.ts` 0%); `D-07` (`evaluator.test` com `PermissionContext` stale).

**Agents:** `a-agents-02` (teste roda com `org` undefined, não valida tenancy); `a-agents-03`
(`message-analyzer`/`memory-extractor` fazem `JSON.parse` cru sem fence-strip; Gemini schema
sem `properties` → 400; em failover a classificação fatal pode abortar); `a-agents-04`/`a-skills`
(testes não rodam — rolldown).

`j-build-04` (CI usa `npm install --ignore-scripts`, não `npm ci`, e o test job roda a suíte
**inteira** contra `postgres:16` puro — fragilidade/reprodutibilidade do gate).

### 🟢 BAIXO — higiene (34)

**Confirmações de canon STALE (gap no documento, código OK):** `TEN-001` (ADR-019 cita 82
`account_id` já migrados — vivo = 0); `BOOT-003` (doc diz que `calendar-health` aborta — nunca
aborta); `BOOT-004` (canon diz "7 estágios"; código tem ~15, os 7 existem na ordem certa);
`MCP-004` (PRD diz exposição "por flag no manifesto" — é por env `MCP_EXPOSED_SKILLS`); `MCP-006`
(PRD diz "cada chamada MCP gera trace OTel" — OTel não está ligado no caminho MCP); `DOC-11`
(PRD §14.4 lista `execution_mode` como evolução futura de **2** modos; código tem enum de **3**);
`DOC-12` (hipótese da missão sobre links README quebrados → **refutada**: `docs/workflows/README.md`
e `docs/adr/012` existem); `H-CB-07`/`H-CB-08` (versionamento de contrato ausente; `/complete`
best-effort só no caminho de falha — ambos confirmam PRD §15.8/§16.1); `CTX-07` (PRD §15.7 prompt
caching ainda não implementado — **acurado**).

**Higiene de código/lexicon:** `TEN-004` (índices em 011 mantêm nomes legados `*_account` —
cosmético); `TEN-005` (UUID de `organizationId` validado só no boundary); `PERM-07` (restrições
de agent-type são sets hardcoded, não derivados de `ToolDefinition.agentType` — risco de drift
para tools novas); `SKILLS-06`/`SKILLS-07` (`CLAUDE.md` "13 tools/4 categorias" → real 15/5,
categoria `sales` não documentada; STOP signal hardcoded em 4 engines, metadado `sideEffects`
decorativo); `CTX-06`/`CTX-08`/`CTX-09` (5 camadas presentes mas recall dobrado na MemoryLayer;
árvores de teste de context duplicadas inflam cobertura aparente; predicado SQL redundante em
HistoryLayer); `DEBT-06`/`DEBT-07`/`DEBT-09` (3 `@deprecated` inertes; deriva de refs de ADR;
marcadores "for now"/"best-effort"); `j-build-03` (lint passa só porque ~12 regras type-aware são
`warn` e `tests/**` não é lintado — 219 warnings).

**Doc hygiene:** `DOC-09`/`MCP-007` (README e PRD apontam para `examples/mcp.config.example.json`
**deletado**); `DOC-10` (README.md com **mojibake** UTF-8 duplo em todo o texto PT-BR).

#### Confirmações que NÃO são gaps (evitar re-investigação)
- `J12` — **dedup e session Redis estão corretos** (`SET …NX EX 3600`; `SESSION_TTL_SECONDS=86400`). O bug é a *interação* com retry (C12), não a dedup.
- `BOOT-001` — **`calendar-health` tolera 404 corretamente** (GET `/health`, só network/timeout aborta). A preocupação da missão (§i) é infundada. (Discrepância cosmética: usa `GET /health`, não `HEAD` na base URL como o `CLAUDE.md` descreve.)
- `BOOT-006` — `warmup-pipeline` degrada para warning (não aborta) sem credencial LLM — correto.
- `J11` — **`BEVOX_KNOWLEDGE_PATH` não afeta o runtime** (consume-by-reference não ocorre no caminho de execução; não está no schema de env). O env unset é irrelevante para o worker.
- `MIG-006` — `migrate.mjs` registra `schema_migrations` corretamente e é idempotente.
- `TEN` (geral) — **convergência para `organizationId` está LANDED**: 0 `account_id`/`workspace_id` em `src/`, 236 `organizationId`; bridge `resolveOrganizationId`/`resolveWorkspaceId` removida. **ADR-019 entregue.**

---

## Itens de fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. Os 4 primeiros somam **< 1 dia** e são o
> caminho mínimo para o worker subir e os callbacks pararem de tomar 400.

1. **C1 — `import()` dinâmico no `SkillLoader`** (`MCP-001`, ~3h). Sem isto o worker **não
   sobe em prod**. Maior ROI absoluto. Adicionar smoke de boot a partir de `dist/`.
2. **C2+C5 — `response`→`response_text` + helper único de `/complete`** (`H-CB-01`/`H-CB-05`, ~3h).
   Conserta o 400 do caminho final de toda execução.
3. **C3+C4 — `usage` sempre presente + alinhar enum `strategy` (`workflow`)** (`H-CB-02`/`H-CB-04`, ~5h; C4 toca o backend).
4. **C11 — migration `000_accounts_stub.sql`** (`MIG-001`/`MIG-004`, ~2h). Deploy-do-zero determinístico.
5. **C6 — eliminar duplo `/complete`** (`J1`, ~4h). `send-message` sinaliza, handler envia uma vez.
6. **C12 — limpar dedup key em falha** (`J6`, ~5h). Destrava re-execução de jobs falhos.
7. **j-build — restaurar binding rolldown + `prettier --write`** (`j-build-01`/`02`, ~2h). Recupera CI e **qualquer** sinal de teste — pré-requisito para validar tudo acima.
8. **C7 — gate de autorização em runtime no `executeTool`** (`PERM-01`, ~6h). Fecha o bypass de permissão antes de produção.
9. **C10 — `Idempotency-Key` determinística nas mutações** (`SKILLS-03`/`J2`, ~12h). Elimina duplicação de efeito externo.
10. **C8+C9 — wire de `execution_mode` + `executeOrPropose` no caminho vivo** (`SKILLS-01/02`, ~24–40h).
    **Pré-condição de GA** e de piloto não-`autonomous`. Maior esforço, maior valor de produto.

> **Itens 1–7 ≈ pacote de piloto** (~1,5 pessoa-dia + 1 PR no backend). **8–10 ≈ pacote de GA.**
> Decidir C8/C9 **antes** do piloto se algum org entrar em `manual_assisted`/`copilot`.

---

## Dependências cruzadas

- **C4 (`strategy` enum)** → **bevox-backend**: adicionar `workflow` ao `CompleteCallbackSchema`/OpenAPI (`harness-callbacks.schema.ts`). PRD §10.2 já pede.
- **C2/C3/C5 (contrato `/complete`)** → **bevox-backend**: paridade de campos (`response_text`, `usage`, `sentiment`). Idealmente fechar com um **teste de contrato e2e** compartilhado (`H-CB-06`; o backend já tem `test/integration/harness-contract.test.ts`).
- **EM-03 (`proposals`)** → **bevox-backend**: o seam `executeProposals()` (`seams.ts:110-298`) e `ProposalSchema` já existem no backend; falta o harness **emitir** `proposals[]`. Acoplado a C8/C9.
- **C8 (`execution_mode`)** → **bevox-backend / orchestration**: o backend já envia o campo obrigatório (`harness-dispatch.schema.ts:30`); a divergência é unilateral do harness. Depende de `AutonomyProfile.current_mode` estar sincronizado antes do dispatch (ADR-018 §110).
- **H-CB-03 (streaming)** → **bevox-backend**: a rota é `/stream` com `{chunk,index}` (não `/stream-chunk`); o harness precisa convergir ao contrato do backend.
- **F0 / SDR** → **canon `bevox-knowledge`**: PRD §2/§5 precisa nomear o Model-C/SDR como caminho vivo (ou ganhar PRD/spec próprio). `EM-04` exige corrigir o `delivery-tracker.yml` (gate de evidência tautológico).
- **ADR-017 (ownership do perfil)** → **bevox-backend**: ADR aceita manda o harness virar **read-through HTTP** e **remover** `contact_profiles`/`contact_facts`; o código ainda persiste local (migration 001 + repos). **Boundary aceito-mas-não-implementado, não auditado a fundo** (ver Notas). Requer `BackendCustomerClient` no harness + endpoints no backend.
- **Doc drift (`DOC-01/02/04/06/07/08`, `DOC-03` numeração de ADR)** → **canon + repo**: sincronizar `CLAUDE.md`, `.claude/rules/*`, OpenAPI e PRD §11 com o estado pós-ADR-019.

---

## Notas de método

**Orquestração.** Workflow multi-agente (`wf_3a39814a-d7e`): 1 censo canônico (48 requisitos,
24 critérios de prontidão, 10 invariantes de ADR extraídos do PRD v1.1 + ADRs) → **16 trilhas
de investigação** em paralelo, cada uma com um agente especialista local
(`AI Engineer` para reasoning/context/agents; `Backend Architect` para execution_mode/tenancy/
callbacks/bootstrap/risks; `MCP Builder` para skills/MCP; `Security Engineer` para permissões;
`Database Optimizer` para migrations; `Test Results Analyzer` para cobertura; `Technical Writer`
para doc-drift; `general-purpose` para debt/build) → **verificação adversarial de todos os 33
achados CRÍTICO/ALTO** (skeptics que reabriram `arquivo:linha` no HEAD; resultado: 0 refutados,
25 confirmados, 19 ajustados — quase todos downgrades) → **crítico de completude**. Total: 62
subagentes, ~4,7M tokens, ~45 min. Ground-truth-checks independentes do orquestrador: contagem
de lexicon de tenancy, schema de payload, ADR-018/019, e **reprodução manual do blast radius de
C1** (worker via `dist/`/Node 20).

**Limitação metodológica nº1 — a suíte de testes NÃO RODA neste checkout.** `npm test` falha no
startup (`MODULE_NOT_FOUND @rolldown/binding-linux-x64-gnu`; `j-build-01`). **Portanto toda a
categoria "d" e qualquer número de cobertura/skip neste relatório é INFERÊNCIA DE LEITURA
ESTÁTICA, não medição.** "scheduler 0%", "16/22 pulados" etc. não foram executados. **Ação para
o revisor:** consertar o binding (constrain `vite` a `^7`, ou reinstalar deps) e **re-derivar a
categoria d por execução real**.

**Limitação metodológica nº2 — tensões reconciliadas** (o crítico de completude pegou
imprecisões que **corrigi** neste relatório): (a) `tsc --noEmit` passa **limpo** (exit 0) — o
"type-error" em `eval-golden.ts` (`TEN-002`) está **fora** do `tsconfig` (`include:['src']`), não
quebra build; (b) token accounting (`DEBT-02`/C13) é `0/0` por `totalTokens` derivado, **não** um
literal cravado; (c) o bypass de permissão (C7/`PERM-01`) é preciso: o caminho genérico **chama**
`filterPermittedTools` (para o prompt), mas o `executeTool` resolve o registry inteiro em runtime;
o Model-C nem filtra.

**Cobertura do baseline — o que NÃO foi auditado a fundo (sem silenciar):** ~10–12 cláusulas §5
do PRD ficaram **sem achado**, o que significa **"não investigado"**, não "verificado-limpo":
streaming E2E (§5.19/ADR-016, além de H-CB-03); **redação de PII antes do export OTLP**
(§5.18/ADR-007 — `redactors.ts` só aparece em loggers, não no export de spans → **risco de
vazamento de PII em prod não avaliado**); LLM Recorder replay fail-closed (§12.17); correlação
OTel/ausência de fase oculta (§12.14); invariante de exposição MCP (§12.15 — vazamento de skill
interna); **corretude do engine de workflow** (resume/suspend/double-respond — o caminho vivo do
piloto!); **RAG/pgvector** (§5.14 — há **dois** `search_faq`, em `skills-builtin/` e `tools/`);
rate-limiter (§5.18); **ADR-017 ownership** (boundary aceito-mas-não-implementado — o código
persiste perfil/fatos local, o oposto da ADR). Recomenda-se uma segunda rodada focada no
**subsistema SDR/Model-C** (o caminho vivo) e nesses módulos.

**Confiança.** Alta nos achados que citam `arquivo:linha` de código não-teste (verificados).
Baixa em qualquer asserção sobre comportamento de runtime de teste ou cobertura (limitação nº1).
Os 4 bloqueadores de topo (C1, C2/C5, C3/C4, C11) foram cross-validados por múltiplos agentes e,
no caso de C1 e C11, **reproduzidos**.
