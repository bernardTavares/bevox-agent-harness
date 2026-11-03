# Gap Analysis — bevox-harness — 2026-06-04

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-06-02.md`.
> **HEAD auditado:** `6a8a308` (branch `test/execution-handler-coverage-uplift`). **HEAD do audit anterior:** `86b70e4` (278 arquivos mudados, +31.9k/−4.5k).
> **Canon:** `bevox-knowledge` HEAD local — PRD v1.1 (`10_prd/bevox-harness/2026-05-15-bevox-harness-prd-v1.md`) + ADRs harness 016–019 + ADRs `_shared` 006/007/016/021 + `runtime-topology.md`.
> **Cross-repo:** contrato de callbacks validado contra `../bevox-backend` (`src/integration/harness-callbacks.{routes,schema}.ts`, HEAD `dbd231e`).
> **Método:** 1 censo canônico (40 requisitos) + índice do audit anterior (95 achados) + **14 trilhas de investigação** especialistas + verificação adversarial de todos os CRÍTICO/ALTO + **cross-check independente do orquestrador** (leitura direta de código + dry-run de migrations + grep de léxico). ~57 subagentes, ~2,1M tokens. Detalhe em §Notas de método.
>
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

O harness sofreu **remediação massiva e bem-sucedida** desde 2026-06-02: o time usou o audit anterior como worklist (vários fixes carregam comentários `// auditoria 2026-06-02`) e **fechou ~todos os 13 CRÍTICOS** — o worker agora **sobe a partir de `dist/` sob Node 20** (C1), o corpo do `/complete` é **contrato-válido** (C2/C3/C4/C5/C6 via `buildCompletePayload`), o **gate de permissão em runtime existe** (C7), o **`execution_mode` é parseado e propagado** (C8), as **5 mutation tools passam por `executeOrPropose`** (C9), o **deploy-do-zero não aborta** (C11, `000_accounts_stub`), a **dedup limpa em falha transiente** (C12), o **ContextBuilder de 5 camadas roda de verdade** (CTX-01, flag-on por default), e — fechando a **limitação metodológica nº1 do audit anterior** — **a suíte de testes RODA** (`vitest run` exit 0, cobertura **68.79% stmt / 62.55% br**). Migrations dry-rodadas limpas; léxico legado `account_id`/`workspace_id` **zerado** em `src/`.

**Mas a remediação introduziu um novo cluster de bloqueadores de piloto**, concentrado em dois pontos cegos do audit anterior: (1) **o contrato de callbacks regrediu** — a unificação do helper `post()` fixou o corpo do `/complete` mas **manda todos os `/status` por POST contra uma rota PATCH-only** (`CB-NEW-01`/`LIFE-NEW-01`), os **`proposals[]` saem sem o `idempotency_key` que o backend exige** (`CB-NEW-02` → 400 nos modos draft), as **estratégias de abort `aborted_*` estão fora do enum do backend** (`CB-NEW-03` → 400), e os **audit-rows de proposta violam o CHECK da migration 013** (`AUD-PROPOSAL-CHECK`); (2) **o caminho VIVO do piloto — SDR/Model-C — está incompleto**: **não há caminho para INICIAR uma cadência** (`SDR-LIFECYCLE-START`), o **timeout de não-resposta marca `failed` em vez de avançar** a cadência de 7 toques (`SDR-CADENCE-NOADVANCE` → cadência de 1 toque na prática), o **Model-C não tem error boundary** (`SDR-MODELC-NOBOUNDARY` → falha transiente perde a execução e a dedup-key bloqueia retry), e **respostas vivas nunca qualificam o lead nem honram opt-out** (`DEBT-08` → exposição LGPD).

A **causa-raiz sistêmica do cluster (1)** é canônica e conhecida: o critério de prontidão **marco-1 §16.1 item-2 — "teste de contrato end-to-end com backend stub" — está ABERTO**. Nenhum teste valida o cliente HTTP do harness contra os **schemas Zod reais do backend**; o `smoke 01` não sobe backend nenhum; e o **OpenAPI (`agent-harness-v1.yaml`) está em v1.0.0, `account_id`-native, e nem sequer parseia** (`DOC-08`). Foi exatamente esse vão que deixou `CB-NEW-01/02/03` passarem pelo CI verde.

**Veredito para o piloto: NÃO-GO no estado atual** — mas por razões **menos numerosas, mais localizadas e de menor esforço** que em 2026-06-02. O fix de maior ROI (POST→PATCH no `/status`, **~1h**) destrava a maior fatia; o pacote de piloto completo (callbacks + boundary Model-C + lifecycle de cadência) soma **~3–4 pessoa-dia + 1 PR no backend**. Os antigos bloqueadores de infra (boot, corpo do `/complete`, migrations, permissões) estão **genuinamente fechados**.

**Tally pós-verificação:** **6 CRÍTICO · 17 ALTO · 23 MÉDIO · 22 BAIXO** (68 achados ativos) + **~40 achados do audit anterior confirmados FECHADOS** (ver §Delta). Verificação adversarial dos CRÍTICO/ALTO: **0 refutados**; convergência alta (a maioria dos CRÍTICOS foi encontrada independentemente por 2–4 trilhas + cross-check do orquestrador contra os dois repos).

---

## Achados por severidade

> Convenção: `arquivo:linha` no HEAD; `[verificado]` = re-aberto por verificador adversarial independente; `[orq]` = cross-check direto do orquestrador contra código/repos; `[conv:N]` = N trilhas independentes convergiram. `[CANON-STALE]` = gap no documento, não no código. `Eh` = esforço estimado.

### 🔴 CRÍTICO — bloqueia o piloto (6)

#### C-01 — `/status` por POST contra rota PATCH-only do backend → 404 (caminho genérico morre no "running"; `dead_letter` não persiste)
`CB-NEW-01` + `LIFE-NEW-01` + `CB-NEW-01-CONTRACT` + `CB-NEW-01-DOC` · Eh≈1h · [verificado, conv:4, orq]
O helper `post()` cravou `method:"POST"` (`src/integration/bevox-callback.ts:28`) e `updateStatus()` roteia **todo** `/status` por ele (`:141`). O backend expõe **só** `app.patch("/api/v1/executions/:id/status")` (`bevox-backend/src/integration/harness-callbacks.routes.ts:56`) — sem rota POST → Fastify `notFoundHandler` → **404**.
- **Caminho genérico:** `updateStatus(...,"running")` é o **primeiro `await` do `try`** (`execution-handler.ts:1410`, try em `:1409`), sem catch local → o 404 estoura no error boundary **antes** de qualquer trabalho de pipeline/LLM. **Toda execução do caminho genérico falha.** O boundary então faz `del(dedupKey)`+rethrow → BullMQ re-tenta (`attempts:7` do producer) → cada retry re-404a → 7 re-runs fúteis (`LIFE-NEW-03`).
- **Caminho Model-C/SDR (vivo):** o corpo do `_dispatchModelCImpl` **não** chama `updateStatus("running")` (retorna no probe `:1396`, antes do `try` em `:1409`) → **imune ao 404 do "running"**, mas herda a quebra do `dead_letter`.
- **`dead_letter` (op-dead-letter):** `bullmq-consumer.ts:155` faz `updateStatus(...,"dead_letter",...)` pelo mesmo POST → 404, mas é `.catch()`-guardado (degrada para o backstop do cron de 120s). **A transição autoritativa `status='dead_letter'` NUNCA acontece** — o backend construiu o handler PATCH dead-letter-aware (2026-06-03) que fica **inalcançável**.
- **Provável bug latente de longa data** que o audit de 2026-06-02 **não pegou** (focou no corpo do `/complete`, não no método do `/status`). **Fix:** dar a `/status` um `patch()` (helper dedicado ou parâmetro de método em `post()`). Destrava o maior bloco do piloto.

#### C-02 — `proposals[]` sem `idempotency_key` → `/complete` 400 nos modos draft (manual_assisted/copilot)
`CB-NEW-02` + `IDEM-04` + `CB-NEW-02-MODELC` + `TOOLS-PROPOSAL-NO-IDEMKEY` · Eh≈3h · [verificado, conv:5, orq]
`extractProposal()` retorna **só** `{action, params}` (`src/tools/_shared/mutation-tool.ts:341-352`); o branch draft de `executeOrPropose` constrói `{action, params}` sem chave (`:151-157`). Hoisted no acumulador (`execution-handler.ts:1878` main / `:422` Model-C) e serializado verbatim por `buildCompletePayload` (`bevox-callback.ts:94`). O backend **exige** `ProposalSchema.idempotency_key: z.string().min(1)` (`harness-callbacks.schema.ts:40`), via `.parse()` estrito (`routes.ts:142`). `grep idempotency_key src/` perto de proposal = **0**.
- **Impacto:** em `manual_assisted`/`copilot`, o **primeiro** proposal faz o `/complete` inteiro retornar **400** → execução nunca finaliza → cai no boundary/timeout-scan. Bloqueia o fluxo "IA começa assistindo" (PRD §14.4) para **qualquer org não-autonomous**. Atinge main e Model-C identicamente.
- **Agravante (`IDEM-05`):** a chave sha256 determinística que o backend quer **já é computável** (`deriveIdempotencyKey`, `mutation-tool.ts:192`, usada na mutação real) mas **não é anexada ao proposal** — então mesmo com placeholder, o backend não consegue dedupar a proposta aprovada contra um replay autônomo posterior. **Fix:** `executeOrPropose` deve setar `idempotency_key: this.deriveIdempotencyKey(context, params)` no proposal (mesma chave da mutação real).

#### C-03 — SDR-cadence não tem caminho VIVO de início; resume-server/subscriber nunca instanciados
`SDR-LIFECYCLE-START` · Eh≈8h · [verificado] · `[dependência cross-system: confirmar se o backend semeia a suspensão]`
Nenhum surface agent declara o campo `workflow:` (`scheduler.agent.ts` só tem name/type/reasoning/permissions), logo o branch START `agentDef.workflow` (`execution-handler.ts:1526`) é **inalcançável**. `sdrCadenceWorkflow` é **registrado** (`stages.ts:248`) mas nunca **iniciado** por dispatch vivo. `WorkflowResumeServer`/`WorkflowSubscriber` **nunca são instanciados** fora de teste (`grep "new WorkflowResumeServer|new WorkflowSubscriber" src/` = 0); o stage `start-workflow-resume` só valida env (`stages.ts:559-575`).
- **Impacto:** o harness só consegue **RESUMIR** uma suspensão que algo já semeou; nada no caminho de dispatch a semeia. A cadência SDR — **o produto do piloto** — não roda de cold-start dentro do harness.
- **Caveat honesto (cross-system):** é possível que o **backend** semeie a `workflow_correlation` (a suspensão inicial) e o harness só resuma. Mesmo assim, `C-04` impede o avanço. **Ação:** confirmar a divisão de responsabilidade harness↔backend para o start da cadência (ADR de "workflow resume boundary" / PRD §16.4); se for harness, criar o caminho START.

#### C-04 — Timeout de não-resposta marca a cadência como `failed` em vez de avançar (7 toques → 1 toque)
`SDR-CADENCE-NOADVANCE` · Eh≈6h · [verificado]
`cleanup.ts:41-52` (`tick → claimForExpiry`) e `state-store.ts:230-247` (`claimForExpiry` faz `SET status='failed', error={reason:'timeout'}, suspend_token=NULL`) — **não** resume nem avança para o toque (N+1). A spec da cadência assume "Working + timeout de não-resposta → continuar cadência (próximo toque)" (`sdr-cadence.ts:42`) e "7 toques esgotados → Nurture:Quarterly" (`:43`).
- **Impacto:** no caso dominante (prospect ignora o toque-1), o timeout marca o workflow inteiro `failed`; toques 2–7 **nunca disparam** e o FSM nunca chega a Nurture:Quarterly. A cadência de 7 toques anunciada é, na prática, **uma cadência de 1 toque** no caminho de não-resposta. **Fix:** `claimForExpiry` deve re-suspender/avançar o cursor (re-enqueue do próximo toque) em vez de falhar terminal.

#### C-05 — Model-C não tem error boundary: falha transiente perde a execução + dedup-key bloqueia retry
`SDR-MODELC-NOBOUNDARY` · Eh≈5h · [verificado, orq]
O probe + `return await dispatchModelC(...)` (`execution-handler.ts:1367-1396`) fica **fora** do `try` que começa em `:1409` (dono do boundary `:2087-2191`). O `_dispatchModelCImpl` (`214-587`) **não tem try/catch** em volta de `runWithTimeout(runSurfaceAgentLoop)` (`:491`), `engine.synthesize` (`:504`) nem `sendComplete` (`:513`). A dedup-key é adquirida em `:1126` **antes** do probe e só é limpa no boundary genérico (`:2184`), **nunca** no caminho Model-C.
- **Impacto:** um throw não capturado no Model-C (blip de LLM, timeout do surface loop, erro de synthesize, 4xx do sendComplete) propaga ao worker (`bullmq-consumer.ts:47`) **sem** `/complete(failed)`, **sem** discriminação de abort, **sem** limpeza de dedup. Pior: a dedup-key fica SET (TTL 3600s) → **todo retry do BullMQ dentro de 1h bate no dedup-skip** (`:1128-1132`) → o job "sucede" instantâneo sem re-rodar → **a execução é silenciosamente perdida** e fica `running` pendurada no backend. **Fix:** envolver o corpo Model-C num boundary espelhando `:2087-2191` (emitir `/complete(failed)` + limpar dedup em erro transiente).

#### C-06 — Respostas vivas nunca qualificam lead nem honram opt-out (`observedSignals` vazio)
`DEBT-08` · Eh≈8h · [verificado] · canon: ADR-007 / LGPD
O resume payload do Model-C cravou `observedSignals: {}` com marcador FOLLOW-UP "NLU/reply-extraction out of Fase C scope" (`execution-handler.ts:556-566`). Os guards da cadência leem `payload.positive`/`payload.optOut` top-level (`sdr-cadence.ts:148-158, 246-249, 321-324`), que o Model-C **nunca** seta; e o `runQualifyGate` lê campos PACT do payload que também nunca são derivados.
- **Impacto:** rastreando o resume vivo: `isPositiveSignal`→false, `isOptOut`→false → **toda** resposta viva cai no braço falsy/falsy → `set-working-tN`. Uma resposta real de prospect (mesmo "quero agendar" ou "remova-me/unsubscribe") **nunca** transiciona o FSM para Qualified, Nurture:Active ou Nurture:Dead. **Opt-out nunca é honrado no caminho vivo — risco de compliance (LGPD / continuação de outreach após opt-out).** Qualificação só funciona com payloads injetados por fixture (testes). **Fix:** extração de sinais NLU mapeando inbound→`{positive, optOut, pain, authority, ...}` antes do resume.

> **Nota de escopo (C-03/C-04/C-05/C-06):** todos pressupõem que **o piloto é a cadência SDR/Model-C** (confirmado por `F0`: o caminho vivo é `dispatchModelC`, selecionado por `agent_config.sdr_profile.enabled===true` + `contact_id` resolvido + `workflow_correlation` existente, pulando o pipeline genérico). Se o piloto for um sub-escopo mais estreito (ex.: resposta single-turn via resume semeado pelo backend), `C-03` cai para ALTO. `C-04`/`C-05`/`C-06` permanecem CRÍTICOS em qualquer uso real da cadência.

---

### 🟠 ALTO — bloqueia GA, não necessariamente o piloto (17)

| ID(s) | Achado | Evidência | Eh |
|---|---|---|---|
| `CB-NEW-03`/`LIFE-NEW-04` | **Abort `/complete` usa strategy `aborted_cost`/`aborted_timeout` fora do enum do backend → 400.** J8/J9 abortam internamente (correto) mas o desfecho **nunca persiste** no backend (fica `running` até o timeout-scan de 120s). [conv:3, orq] | `execution-handler.ts:2096-2100`; backend `schema.ts:57-65` | 1 |
| `AUD-PROPOSAL-CHECK` | **Audit-rows de proposta (`action_type='proposal'`/`result='proposed'`) violam o CHECK da migration 013** → INSERT rejeitado (23514), engolido pelo `.catch` fire-and-forget → **draft proposals sem trilha de auditoria** (viola invariante §12.13). Pior: o `executeTool` do Model-C **não emite audit de mutação algum** (`:405-430`). [conv:3, dry-run] | `execution-handler.ts:1857,1866`; `migrations/013_execution_audit_extension.sql:38-49`; `execution-audit.ts:106` | 2 |
| `LIFE-NEW-02` | **`dead_letter` nunca persiste no backend** (mesmo 404 POST→PATCH; `.catch`-guardado). O epic op-dead-letter (0df76ff) fica **inerte**; UI de replay de staff nunca acende; reconciliação só via cron de 120s. | `bullmq-consumer.ts:154-169`; backend `routes.ts:56` | 1 |
| `IDEM-05` | **Chave de idempotência não anexada ao proposal** → backend não consegue dedupar a proposta quando a executar depois (re-booking no approval; quebra a garantia de replay-dedup no handoff humano). | `mutation-tool.ts:150-157` (deriva no `execute()`, não no propose) | 2 |
| `OBS-DELTA-01` (C13) | **`usage` real só no caminho genérico happy-path; o caminho VIVO Model-C/SDR, o workflow e o error/abort mandam `{0,0}`** — o acumulador está em escopo mas não é lido em `:516/:1039/:2150`. Telemetria de custo/token ~zerada para o tráfego real do piloto. [orq] | `execution-handler.ts:516,1039,2150` vs `:1968` | 2 |
| `PRD-COST-NOT-PROPAGATED` | **`cost_usd` computado mas nunca propagado ao `/complete`** (contradiz PRD §5.17/§10.2). Chega ao span/log mas não ao callback → "custo por conta" do console não pode ser alimentado pela via spec. | `usage-tracker.ts:29,40`; `bevox-callback.ts:63-69` (sem campo cost) | 3 |
| `PRD-ADR017-OWNERSHIP` | **ADR-017 totalmente não-implementado:** harness persiste `contact_profiles`/`contact_facts` local (migration 001 + repos vivos); **não existe `BackendCustomerClient`.** Boundary aceito-mas-não-implementado (PRD §14.2 lista como futuro). Divergência de fonte-de-verdade + LGPD bleed entre 2 stores. | `contact-{facts,profile}.repository.ts`; `memory.layer.ts:79,86` | 24 |
| `DOC-08`/`PRD-OPENAPI-STALE` | **OpenAPI `agent-harness-v1.yaml` é v1.0.0, `account_id`-native, sem `organization_id`/`execution_mode`/`response_text`/`proposals`/`usage`/`cost_usd`/`strategy:workflow`, documenta `prompt_tokens:0`, E NÃO PARSEIA** (ScannerError L942). O único contrato consumível por integrador está obsoleto e quebrado — causa-raiz de `CB-NEW-*` passarem despercebidos. [verificado, orq] | `openapi/agent-harness-v1.yaml:5,66-67,274,1146` | 8 |
| `PRD-CONTRACT-E2E-TEST` | **Sem teste de contrato contra os schemas Zod reais do backend** (marco-1 §16.1 item-2 ABERTO). Os testes validam fakes harness-side; o `smoke 01` não sobe backend. **Causa sistêmica** de `CB-NEW-01/02/03`+`AUD-PROPOSAL` escaparem do CI. | `tests/integration/*` vs `bevox-backend/.../harness-callbacks.schema.ts` | 8 |
| `LLM-DELTA-02`/`PRD-CALENDAR-RETRY-CB` | **Calendar Service segue `fetch` cru — sem retry/circuit-breaker** (LLM já tem). O único surface agent vivo (Scheduler) chama calendar; um serviço degradado arrasta tools ao timeout global. PRD §15.4 escopava "LLM **e** Calendar". | `calendar-client.ts:38,64,87` (sem Retry/Circuit) | 6 |
| `a-reasoning-02` | **Engine escalado é descartado antes do `synthesize`** → `/complete.strategy`, `escalated`, `retriesUsed` **sempre** reportam o engine BASE (react). Telemetria de escalação impossível. | `execution-handler.ts:498,1938` (rebuild engine) | 4 |
| `a-reasoning-05` | **Unwrap de STOP-tool (fix CRÍT #6) regride no caminho plan-execute escalado** → `response_text` vira **JSON cru** do envelope da tool (PlanExecute.observe nunca seta `stopSignal`; synthesize roda no ReactEngine base). | `plan-execute.ts:272-279`; `react.ts:224,265` | 3 |
| `C7-WF-UNGATED` | **Caminho de workflow (`wfExecuteTool`) é não-gateado** — resolve+executa qualquer tool nomeada contra o registry inteiro, sem permission check, sem hoist de proposal, sem audit. **Latente hoje** (nenhum agent declara `workflow`), vira CRÍTICO vivo no dia que algum declarar. | `execution-handler.ts:1537-1547` vs gate `:408` | 2 |
| `AUTHZ-ALLOWLIST` | **Evaluator é denylist-only:** o allowlist `required`/`optional` do agent **nunca é enforçado** em runtime (só `logger.warn`). Um surface agent pode executar **qualquer** tool não-explicitamente-negada, fora do seu capability set declarado. | `evaluator.ts:50-89` (granted:true por default); `:109` (warn) | 5 |
| `LIFE-NEW-03` | **Running-404 dispara retry-storm 7× + terminal prematuro** — caminho genérico emite `/complete(failed)` no attempt 1, depois queima retries 2-7 re-404ando (`lockForCompletion`→409 engolido). C12 (correto isolado) **amplifica** a tempestade aqui. | `execution-handler.ts:2087-2191`; backend `routes.ts:154-163` | 2 |
| `D-04` | **CI nunca roda `--coverage` e thresholds ficam comentados** → cobertura não medida nem enforçada; nada impede código novo entrar a 0%. | `.github/workflows/ci.yml:75`; `vitest.config.ts:22-30` | 3 |
| `j-build-02` | **CI `format:check` (prettier) ainda VERMELHO** (11 arquivos) → o job "Lint & Format" reprova **todo** push/PR a `main`, mascarando regressões novas. Caiu de 146→11 arquivos mas segue red. | `.github/workflows/ci.yml:25`; `prettier --check` exit 1 | 1 |

---

### 🟡 MÉDIO — degrada qualidade (23)

**Contrato / callbacks:** `IDEM-06` (header `Idempotency-Key` no `/complete` é **lido em lugar nenhum** pelo backend — dedup real é o `lockForCompletion`; defense-in-depth morta + drift de doc, `bevox-callback.ts:10-13`); `CB-NEW-05` (meta do `dead_letter` no body é stripada — `StatusCallbackSchema` sem `.passthrough()`, `schema.ts:15-17`); `H-CB-06`/`PRD-CONTRACT-VERSIONING` (sem header de versão de contrato — só prefixo `/v1/`); `PERM-AUDIT-SCHEMA-DRIFT` (enum TS `proposed` vs CHECK 013 — mesma raiz de `AUD-PROPOSAL-CHECK`).

**SDR / workflow:** `AUTHZ-WF-DIRECTIMPORT` (`sdr-cadence.ts:54,168` chama `qualifyOpportunitySkill.execute(params, {} as never)` por import direto, pulando gate+registry+audit+rate-limit; **funcionalmente NIL hoje** — a skill é pura, `_context` não usado — mas é o smell arquitetural se copiado a skill com efeito); `WF-LOCKVERSION-UNUSED` (`state-store.ts:134-141` bumpa `lock_version` mas o WHERE não tem o predicado `lock_version=$expected` → last-write-wins no step-walk; mitigado pelos guards de status nos entry points).

**Reasoning:** `a-reasoning-01` (Reflexion `learnedContext`/`reflexionNotes` escrito mas **lido em lugar nenhum** → aprendizado é no-op, `reflexion.ts:188-201`); `a-reasoning-03` (ReWOO `executeWaves`/`buildWaves` dead-code; escalate-to-rewoo roda sequencial ignorando `dependsOn`, `rewoo.ts:280`); `a-reasoning-04` (Plan&Execute thrash parcialmente fixo — intra-engine ok, cross-swap early-terminate + re-escalação thrash sobrevivem, `plan-execute.ts:315-323`); `a-reasoning-07` (ReWOO inalcançável do surface agent default — plano ReAct de 1 passo nunca atinge `parallelThreshold`).

**Context:** `CTX-04` (tokenizer ainda heurística `words×1.3`, não BPE — erro de budget material em PT-BR/código/emoji, `tokenizer.ts:16-22`); `CTX-05` (truncação ainda corte proporcional único por contagem de linhas, sem loop de re-medida — fix convergente **não** está neste HEAD, `budget-enforcer.ts:212-245`); `CTX-CAL` (5ª camada CalendarLayer **órfã** — não existe `getCalendarContext` no calendar-client; "5 camadas" = 4 na prática).

**Observabilidade:** `OBS-DELTA-02` (`UsageTracker.record`/`execution_usage` é **dead code** — nunca instanciado fora de teste; sem ledger durável de custo/token); `OBS-DELTA-03` (métricas de dispatch SLO são **log-only** — sem `sdk-metrics`/exporter; per-process nas 2 réplicas, resetam no restart); `OBS-PII-02` (`recordException` ecoa o **corpo de erro do backend** ao span quando `OTEL_ENABLED=true` — vetor único de conteúdo ao OTLP; baixa probabilidade pois OTEL off por default, mas dispara muito dado o alto reject-rate dos `CB-NEW-*`).

**Permissões / MCP:** `PERM-02` (DB-half fixo mas **MCP nunca chama `setPermissionAuditLogger`** → tráfego MCP 100% não-auditado, `mcp/bootstrap.ts:29-55`); `PERM-06` (testes do evaluator sub-cobrem a matriz das 3 camadas — falta unit do complemento allowlist PERM-05); `PERM-04` (audit flood — 1 row "allow" por tool por execução); `AUTHZ-SKILLS-REQUIRED` (allowlist `skills` que omita uma tool `required` do agent a nega silenciosamente — só warn); `MCP-002` (`references/mcp-tools.md` documenta **5 tools fictícias** — `inspect_execution` etc. — que não existem); `MCP-008` (invariante de exposição frágil — skills sales/SDR + calendar-mutation fora do default-denied podem vazar via glob `MCP_EXPOSED_SKILLS` largo).

**Migrations / infra / testes:** `DC-PGVECTOR` (dev `docker-compose.yml:3` fixa `postgres:16-alpine` **sem pgvector** → migration chain aborta na 006); `MIG-003` (011 é DROP+CREATE destrutivo, sem backfill — aceito pré-prod); `D-01` (`execution-handler.ts` agora testado mas só 59% stmt/52% br; `dispatchModelC` só via integração gated); `D-05` (`scheduler.agent.ts` ainda 0% — o surface agent vivo de booking); `BOOT-005` (shutdown 90.9% mas `stages.ts`+`runner.ts` 0%); `T-NEW-01` (vitest `include:['tests/**']` **exclui 10 testes co-locados** `src/**/*.test.ts` → `builder-factory.ts` 0% no caminho vivo); `T-NEW-03` (`workflow/resume-server.ts`+`subscriber.ts` true-0% — caminho de resume do piloto sem teste algum); `T-NEW-04` (`usage-tracker.ts` 0% — o módulo do C13); `j-build-04` (CI usa `npm install --ignore-scripts` não `npm ci`; suíte inteira vs `postgres:16` puro).

---

### 🟢 BAIXO — higiene (22)

**Doc-drift `[CANON-STALE]`:** `DOC-10` (README.md **mojibake** UTF-8 duplo em todo o PT-BR — confinado ao README); `CB-NEW-01-DOC` (o OpenAPI declara `patch:` para `/status` MAS tem nota "o harness usa POST internamente" — a própria spec normaliza o bug `CB-NEW-01`); `DOC-01` (CLAUDE.md payload+callbacks agora **corretos**; resíduo: contagens "12 tools/4 cat" `:48` vs "15" `:140`, "11 migrations" `:177`, "13 tools" `:221`); `DOC-06/07` (PRD §11.1 "7 migrations" + invariante `account_id` vs 15 arquivos/organizationId); `DOC-SKILLS-04` (`SessionStart.sh:8-10` saúda toda sessão dizendo que `execution_mode`+`organization_id` — **já entregues** — ainda abrem, cita `workspace_id` retirado); `AUD-PROPOSAL-CHECK-DOC` (`harness-tools.md` documenta o fluxo de proposta como landed sem notar o gap de auditoria); `DOC-PRD-TOKEN` (PRD §16.1 "[x] token accounting real" é **acurado** no happy-path — corrige a hipótese pessimista anterior).

**Lifecycle / SDR (latentes):** `BOOT-004` (`buildStages` tem ~17 stages vs "7" do doc — os 7 canônicos existem na ordem, resto flag-gated); `LIFE-NEW-05` (`smoke 01` sem backend dá falso e2e — não exercita o contrato de callback, **mascara** `CB-NEW-*`); `LIFE-NEW-06` (redelivery logado mas não-bounded; sem DLQ dedicada — regra ainda cita fila inexistente); `WF-ENGINE-CORRECTNESS` (resume/suspend/correlation/tenancy **corretos** — não-gap, registrado para evitar re-investigação).

**Migrations / lexicon:** `MIG-DUP013` (dois `013_*.sql` — sort lexical `e<p`, PK por filename, **não-hazard** mas frágil); `IDX-LEGACY-NAME` (9 índices `idx_*_account` em `011` indexando `organization_id` — cosmético); `TEN-003` (77 hits `account_id`/`accounts` em migrations = histórico pré-011, 0 reintrodução pós-011, 0 `workspace_id`).

**Reasoning / MCP / outros:** `a-reasoning-06` (`EscalationConfig.escalateTo` é campo morto); `a-reasoning-08` (wrap-reflexion pode aninhar `ReflexionWrapper`s sem guard → blowup de retry); `a-reasoning-09` (`DirectEngine` nunca instanciado em prod — pipeline agents reimplementam inline); `MCP-009` (`MCP_TRANSPORT` env morto — bin lê CLI `--transport`); `MCP-010` (SSE sem validação Origin/Host — mitigado por bind loopback); `MCP-011` (docstrings citam `SkillRegistry` removido); `CTX-09/10/11/12` (predicado SQL redundante em HistoryLayer; HEAD não-comprimível nunca trimado; tools dominando budget pequeno passam direto; `compress()` do builder morto no caminho vivo); `DEBT-MARKERS` (5 markers inertes + 1 falso-positivo PT "TODOS" — zero debt vivo); `OBS-PII-03` (auto-instrumentação OTel em modo default — sem captura de body/param); `DOC-09` (`examples/mcp.config.example.json` **restaurado** — link não-quebrado, fecha achado anterior).

#### Confirmações que NÃO são gaps (evitar re-investigação)
- `OBS-PII-01` — **PII-para-OTLP é risco BAIXO, não o alto temido pelo audit anterior**: spans carregam **metadados only** (counts/tokens/IDs/layer-names/booleans); conteúdo de conversa **nunca** vai ao span (redação é egress-only por design). Vetor único = `recordException` de corpo de erro do backend (`OBS-PII-02`), e só com `OTEL_ENABLED=true` (off por default). [orq, verificado]
- `CLOSED-RECORDER-FAILCLOSED` — LLM Recorder replay é **fail-closed** (`replay.ts:32-38` lança `CassetteMissError`, sem passthrough). Invariante §12.17 satisfeita.
- `CLOSED-MCP-INVARIANT` — exposição MCP é **fail-closed** (padrões vazios → `[]`; stop_signals dropados; reuso do evaluator). Invariante §12.15 satisfeita.
- `LLM-SAFETY-01` — hygiene de segredos sólida (keys só em `Authorization`; cassettes scrubbed; Pino redige credenciais em todos níveis).
- `WF-ENGINE-CORRECTNESS` / `IDEM-07` (C12) / `IDEM-01/02/03` (C10 mutações reais) — todos **corretos** no HEAD.

---

## Itens de fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. Os 3 primeiros somam **~6h** e destravam o grosso do caminho de callback.

1. **C-01 — `/status` por PATCH** (`CB-NEW-01`, **~1h**). Maior ROI absoluto: destrava o caminho genérico (morre no "running") **e** a transição autoritativa `dead_letter`. Split `post()` em `patch()` ou parametrizar o método.
2. **C-02 + IDEM-05 — `idempotency_key` no proposal** (`CB-NEW-02`, **~3h**). `executeOrPropose` anexa `deriveIdempotencyKey(context, params)` ao proposal → destrava `/complete` em draft modes E habilita dedup do backend no approval. **Atualizar o teste que consagra a forma errada** (`em-03-proposals-end-to-end.test.ts:276`).
3. **CB-NEW-03 + AUD-PROPOSAL-CHECK — enum de abort + CHECK de audit** (**~3h**). Adicionar `aborted_*` ao enum do backend (ou mapear para `failed`+meta) e estender o CHECK da 013 (ou remapear `proposal/proposed`→`mutation_execution`/`pending_approval`). Fecha o 400 de abort e o drop silencioso de audit.
4. **C-05 — error boundary no Model-C** (`SDR-MODELC-NOBOUNDARY`, **~5h**). Espelhar `:2087-2191` no `_dispatchModelCImpl`: `/complete(failed)` + limpeza de dedup em erro transiente. Evita perda silenciosa de execução no caminho vivo.
5. **C-04 — avanço de cadência no timeout** (`SDR-CADENCE-NOADVANCE`, **~6h**). `claimForExpiry` re-suspende/avança o cursor em vez de `failed`. Transforma a cadência de 1 toque de volta em 7.
6. **PRD-CONTRACT-E2E-TEST — teste de contrato contra schemas Zod do backend** (**~8h**). Pega `CB-NEW-01/02/03`+`AUD-PROPOSAL` na fonte e impede regressão futura. **Pré-requisito de confiança** para todos os fixes acima. (Marco-1 §16.1 item-2.)
7. **C-06 — extração de sinais NLU** (`DEBT-08`, **~8h**). Mapear inbound→`{positive, optOut, PACT}` no resume Model-C. **Risco LGPD** (opt-out) + habilita qualificação real.
8. **C-03 — caminho de start de cadência** (`SDR-LIFECYCLE-START`, **~8h**, **confirmar boundary cross-system primeiro**). Instanciar resume-server/subscriber ou declarar o `workflow` no agent — ou documentar que o backend semeia.
9. **OBS-DELTA-01 — `usage` real no Model-C/workflow/abort** (C13, **~2h**). Ler `agentContext.usageAccumulator` nos 3 sites (`:516/:1039/:2150`). Liga telemetria de custo do tráfego real do piloto.
10. **DOC-08 — corrigir + parsear o OpenAPI** (**~8h**). Regenerar a spec a partir do contrato Zod real (organizationId/execution_mode/response_text/proposals/usage/cost_usd/strategy:workflow/aborted_*). Destrava sign-off de integração e elimina a fonte de drift.

> **Itens 1–3 + 6 ≈ pacote mínimo de callback** (~15h + 1 PR backend). **1–9 ≈ pacote de piloto SDR** (~3–4 pessoa-dia). **10 + ADR-017 + Calendar CB ≈ pacote de GA.**

---

## Dependências cruzadas

- **C-01/CB-NEW-03 (verbo `/status` + enum de abort)** → **bevox-backend**: a rota `/status` é PATCH-only (`harness-callbacks.routes.ts:56`); o enum strategy não tem `aborted_*` (`schema.ts:57-65`). Fix pode ser **unilateral no harness** (POST→PATCH; mapear abort→`failed`+meta) **ou** bilateral (backend aceitar POST/`aborted_*`). Recomendado: harness conforma ao backend.
- **C-02 (`idempotency_key`)** → **bevox-backend**: `ProposalSchema.idempotency_key` (`schema.ts:40`) já existe e é exigido; a divergência é **unilateral do harness** (não emite). O seam `executeProposals` do backend espera a chave para dedupar no approval.
- **C-03 (start de cadência)** → **bevox-backend / canon**: confirmar quem semeia a `workflow_correlation` (harness vs backend orchestration). Depende do ADR "workflow resume boundary" (PRD §16.4 — ADR-012 local, ainda não promovida ao canon).
- **AUD-PROPOSAL-CHECK** → **migration local**: estender o CHECK da `013_execution_audit_extension.sql` (decisão de schema; não toca o backend).
- **PRD-CONTRACT-E2E-TEST** → **bevox-backend**: idealmente importar/validar contra os schemas Zod reais do backend (`test/integration/harness-contract.test.ts` já existe lá; falta o lado harness cross-validar).
- **PRD-ADR017 (ownership)** → **bevox-backend**: ADR aceita manda o harness virar read-through HTTP e **remover** `contact_profiles`/`contact_facts`; requer `BackendCustomerClient` no harness + endpoints `Customer`/`CustomerFact` no backend.
- **PRD-COST-NOT-PROPAGATED** → **bevox-backend**: o `usage` do `CompleteCallbackSchema` (`schema.ts:66-69`) só tem 2 campos de token; propagar `cost_usd` exige estender o schema do backend.
- **DC-PGVECTOR** → **infra/CI**: dev compose + CI usam imagem PG sem pgvector; trocar por `ghcr.io/bernardtavares/bevox-postgres` (hub `infra/`).
- **F0 / SDR como caminho vivo** → **canon `bevox-knowledge`**: PRD §2/§5 ainda descrevem o sistema genérico, não o Model-C/SDR. Persiste do audit anterior; precisa nomear o caminho vivo (ou ganhar PRD/spec próprio).

---

## Delta vs audit anterior (2026-06-02 → 2026-06-04)

**Magnitude:** 278 arquivos mudados (+31.9k/−4.5k). O time tratou o audit anterior como worklist (fixes carregam `// auditoria 2026-06-02`).

### FECHADOS (eram CRÍTICO/ALTO em 2026-06-02) — ~confirmados por leitura direta
- **C1** (boot ESM): `skill-loader.ts:104` `await import(pathToFileURL)`. ✅
- **C2/C3/C5/C6** (corpo `/complete`): `buildCompletePayload` (`bevox-callback.ts:88`) preenche os 4 campos; `send-message` não auto-emite (`mutation.ts:43`); guard `completeSent`. ✅
- **C4** (enum strategy): backend adicionou `workflow`; harness dropou `handoff`→`request-human`. ✅ [cross-repo]
- **C7** (gate de permissão): runtime gate em surface loop + Model-C (`:415/:418`). ✅ **parcial** — caminho workflow ainda não-gateado (`C7-WF-UNGATED`).
- **C8/C9** (execution_mode + executeOrPropose): parseado/propagado (`:673/:1347`); 5 mutation tools via `mutationExecute`. ✅
- **C10** (idempotência mutações reais): sha256+canonicalize+lineage `original_execution_id`; header **na wire** pelo calendar-client. ✅ (proposals seguem sem chave — vira `C-02`/`IDEM-05`).
- **C11** (trap accounts): `000_accounts_stub`+`012_drop`; **dry-run da chain de 15 migrations limpo**. ✅
- **C12** (dedup em falha): `del` em erro transiente, retém em abort (`:2178-2191`). ✅
- **C13** (usage 0/0): acumulador + UsageDecorator emitem **real no happy-path genérico**. ✅ **parcial** (`OBS-DELTA-01`: Model-C/workflow/abort seguem 0/0).
- **CTX-01** (builder órfão): agora **wired + flag-on por default** em ambos caminhos (`env.ts:185`). ✅ **parcial** (4/5 camadas; Calendar deferida).
- **CTX-02** (budget): enforçado em runtime, incondicional (`:1688/:463`). ✅
- **CTX-03** (recall): consumido via MemoryLayer; doubling resolvido. ✅
- **PERM-02/03/05** (audit/Layer-2): execution_id TEXT; escalação+mutação auditadas; `deriveAccountDeniedTools` em ambos caminhos. ✅ (`PERM-02` wiring MCP ainda morto).
- **EM-03/EM-05** (proposals/per-mode tests): emitidos em ambos caminhos; testes por modo existem. ✅ (forma do proposal errada — `C-02`).
- **H-CB-03** (streaming): `/stream` `{chunk,index}` correto. ✅
- **J3/J8/J9/BOOT-002** (poison/abort/shutdown): `UnprocessablePayloadError`; abort cooperativo terminal; teardown ordenado com handles reais. ✅
- **MIG-004** (000-stub), **MCP-003** (token só sse), **MCP-005** (testes rodam), **D-02** (CI RUN_INTEGRATION), **D-07** (evaluator tests), **J7-LLM** (RetryDecorator+CircuitBreaker), **DOC-02** (rule field-accurate), **DOC-09** (exemplo restaurado), **SKILLS-05** (UnifiedToolRegistry), **j-build-01** (suíte roda). ✅

### SOBREVIVEM (de 2026-06-02)
`DOC-08` (OpenAPI — **piorou**: agora confirmado não-parseável), `a-reasoning-01/02/03/04` (parciais/no-op), `CTX-04/05` (tokenizer/truncação), `MCP-002/004/006`, `PERM-04/06/07`, `D-04`/`j-build-02`/`j-build-04` (CI), `MIG-003`, `DEBT-05`/`LIFE-NEW-06` (DLQ), `DOC-06/07`/`DOC-10`/`SKILLS-04`, `F0` (caminho vivo SDR diverge do PRD), `PRD-CALENDAR-RETRY-CB`.

### NOVOS (não estavam em 2026-06-02)
**Cluster de callbacks (introduzido pela remediação):** `CB-NEW-01` (status POST/PATCH), `CB-NEW-02` (proposal sem idempotency_key), `CB-NEW-03` (enum abort), `AUD-PROPOSAL-CHECK` (CHECK 013), `IDEM-05/06`, `LIFE-NEW-02/03/04/05`.
**Cluster SDR/Model-C (sub-auditado antes, agora aprofundado):** `SDR-LIFECYCLE-START`, `SDR-CADENCE-NOADVANCE`, `SDR-MODELC-NOBOUNDARY`, `AUTHZ-WF-DIRECTIMPORT`, `WF-LOCKVERSION-UNUSED`.
**Observabilidade/contrato:** `OBS-DELTA-01/02/03`, `OBS-PII-02/03`, `PRD-COST-NOT-PROPAGATED`, `PRD-OPENAPI-STALE` (unparseable), `AUTHZ-ALLOWLIST/SKILLS-REQUIRED`, `DC-PGVECTOR`, `T-NEW-01..07`, `a-reasoning-05/06/07/08/09`.

**Resumo do delta:** dos **13 CRÍTICOS** anteriores, **~12 fechados/parciais**. Surgiram **6 CRÍTICOS novos**, concentrados (a) no contrato de callbacks (regressão de remediação) e (b) no lifecycle SDR (que o audit anterior **explicitamente** marcou como sub-auditado — §Notas 2026-06-02). O veredito de piloto continua **NÃO-GO**, mas a superfície de bloqueio **encolheu e se localizou** (era infra ampla; agora é majoritariamente o helper de callback + lifecycle de cadência).

---

## Notas de método

**Orquestração.** Workflow multi-agente em 3 rodadas (`wf_ff0ed355`, `wf_8e44f3b5`): 1 censo canônico (40 requisitos do PRD §5/§12/§15/§16 + ADRs) + índice do audit anterior (95 achados) → **14 trilhas de investigação** por categoria (callbacks, permissões, autonomy-modes, idempotência, reasoning, context, bootstrap-lifecycle, migrations, mcp-server, test-coverage, sdr-live, canon-gap, observability-pii, doc-lexicon) → **verificação adversarial** de todos os CRÍTICO/ALTO (skeptics re-abrindo `arquivo:linha` no HEAD, instruídos a refutar nas duas direções). ~57 subagentes, ~2,1M tokens.

**Falha de tooling reconciliada (honestidade de método):** a primeira rodada (agentes com `agentType` persona + schema estruturado) **falhou ao emitir StructuredOutput em 14/14 trilhas**; a segunda (agente default + schema) recuperou **7/14**; a terceira (saída texto-markdown, sem schema) recuperou as **7 restantes**. Nenhum achado foi perdido — apenas re-executado. As 7 trilhas estruturadas trazem verdicts adversariais embutidos; as 7 texto trazem auto-verificação inline + foram cross-checadas pelo orquestrador.

**Cross-check independente do orquestrador (ground-truth `[orq]`).** Para reduzir dependência de agente, o orquestrador validou diretamente, lendo código nos dois repos: C1/C2/C3/C4/C5/C6/C7/C8/C11/C12/CTX-01 (fechados), `CB-NEW-01` (backend `routes.ts:56` PATCH-only + `updateStatus`→`post()`→POST + mapeamento de call-sites generic vs Model-C), `CB-NEW-02` (`ProposalSchema.idempotency_key:min(1)` + `extractProposal` sem chave), `CB-NEW-03` (enum), e **refutou** o medo de "PII-para-OTLP" do audit anterior (spans são metadados-only). Migrations dry-rodadas contra PG limpo (chain de 15 limpa). Léxico de tenancy grep-ado (0 em `src/`).

**Reconciliação de nuance (o orquestrador corrigiu imprecisões dos agentes):** (a) a trilha bootstrap disse `CB-NEW-01` é fatal em "**toda** execução" — preciso: é fatal no **caminho genérico** (`updateStatus("running")` em `:1410`); o **Model-C retorna antes** (`:1396`) e é imune ao 404 do "running", herdando só a quebra do `dead_letter`. (b) `C13` não é binário: é **real no happy-path genérico, 0/0 no Model-C/workflow/abort**. (c) `C-03` (start de cadência) tem caveat cross-system real (o backend pode semear a suspensão). Essas nuances estão refletidas na severidade.

**Confiança.** Alta nos achados que citam `arquivo:linha` de código não-teste — a maioria dos CRÍTICOS foi encontrada por **2–4 trilhas independentes + cross-check do orquestrador contra ambos os repos**, e 0 foram refutados na verificação adversarial. A cobertura de testes (categoria `d`) é **medição real** desta vez (suíte roda), não inferência estática — fechando a limitação nº1 do audit anterior.

**Limitações.** (1) A divisão harness↔backend para o **start da cadência SDR** (`C-03`) não foi confirmada lendo o orchestration-service do backend a fundo — marcada com caveat. (2) O **pgvector path** dos testes de integração não foi exercitado (imagem PG sem pgvector no ambiente). (3) O **hub `infra/`** (manifest de prod, smoke de cluster) não estava em escopo — o pin do nome de fila `bevox.execution.dispatch` em prod deve ser confirmado lá (cross-ref memória `backend-dispatch-retry-contract`). (4) Achados em código de teste/fixture têm confiança menor que os de `src/`.
