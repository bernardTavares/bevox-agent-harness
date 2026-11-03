# Gap Analysis — bevox-harness — 2026-06-23

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-06-04.md` (e, por linhagem, `2026-06-02.md`).
> **HEAD auditado:** `d6d41dc` (branch `test/execution-handler-coverage-uplift`). **HEAD do audit anterior:** `6a8a308`.
> **Fato estrutural decisivo:** `git diff origin/main..HEAD -- src/ migrations/ openapi/` = **vazio**. Os 20 commits desta branch desde o audit anterior são **100% teste/docs** (`tests/**` +4029 linhas / 18 arquivos, um deles o próprio audit 06-04). `origin/main` está em `2979eb0` (2026-06-03) e **não avançou em 19 dias** (confirmado por `git fetch` em 2026-06-23). **O código de produto está CONGELADO no estado auditado em 06-04.**
> **Canon:** `bevox-knowledge` HEAD `0317985` (2026-06-02) — PRD v1.1 (`10_prd/bevox-harness/2026-05-15-bevox-harness-prd-v1.md`) + ADRs harness 016–019 + ADRs `_shared` 005/006/007/016/019/020/021.
> **Cross-repo:** contrato de callbacks validado contra `bevox-backend` HEAD `bfe7095` (2026-06-04, também congelado) — `src/integration/harness-callbacks.{routes,schema}.ts`.
> **Método:** workflow multi-agente de 8 trilhas (1 censo canônico + 7 investigações por domínio, saída texto-markdown sem schema — ver §Notas) + **cross-check independente do orquestrador** dos 6 CRÍTICO, dos ALTO de callback/SDR/permissões e de **todos os achados NOVOS de severidade alta** (leitura direta de código nos dois repos + grep exaustivo de léxico + leitura de `migrate.mjs`/CI/vitest config). ~8 subagentes, ~0,8M tokens.
>
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

**O harness não mudou.** Desde a remediação massiva de 02→04 jun, o produto está **congelado**: `src/`, `migrations/` e `openapi/` são byte-idênticos a `origin/main`, e `origin/main` não recebe commit há 19 dias. As únicas mudanças na branch são **20 commits de teste** que subiram a cobertura de **68.79%→71.15% stmt / 62.55%→64.21% br** — mas são *regression guards de invariante* (`tests/unit/runtime/invariants/**`) que **não fecharam nenhum CRÍTICO/ALTO** e **não tocaram** os módulos estruturalmente a 0% (caminho de resume SDR, scheduler agent, bootstrap stages). Um deles (`em-03-proposals-end-to-end.test.ts:276`) **consagra ativamente a forma de proposal quebrada** do C-02.

**Consequência para o delta:** os **6 CRÍTICO e os 17 ALTO do audit 06-04 SOBREVIVEM essencialmente intactos** — re-abri cada um no HEAD atual e confirmei `arquivo:linha`. A remediação existe, mas como **30+ branches `fix/*` e `op-*` NÃO-merged** (inclusive um worktree ativo `finding-j10-running-status` para o fix do C-01); está **encenada, não integrada**.

**Quatro coisas novas que esta rodada acrescenta** (cross-checadas no código):

1. **NOVO CRÍTICO latente — `sentiment` da pipeline vai cru pro `/complete` e estoura o enum estrito do backend (400 silencioso, perda de execução).** O `sentiment` que o LLM analyzer emite não é clampado em lugar nenhum (`message-analyzer.agent.ts:80` faz `JSON.parse(...) as` sem Zod; handler `:1078` é passthrough `typeof string`). Hoje está **mascarado pelo C-01** (o caminho genérico/workflow morre antes, no `updateStatus("running")` 404; o Model-C crava `"neutral"`). **Vira CRÍTICO vivo no instante em que o C-01 — o fix nº1 da worklist — for aplicado.** É um *co-fix obrigatório*: corrigir o C-01 sem clampar o sentiment troca um 404 por uma **perda silenciosa de dados no happy-path**.
2. **NOVO ALTO — MCP roda com `organizationId=""` quando nada o fornece** (`mcp/server.ts:80` `?? ""`) → execução MCP sem tenant (vazamento cross-tenant no canal lateral dev/eval).
3. **NOVO ALTO — o harness NUNCA emite `status:"paused"`** (só `running`/`dead_letter`), embora o backend o aceite; uma cadência suspensa fica indistinguível de uma execução ativa.
4. **NOVO ALTO — leak de linha-órfã em `workflow_correlation` no timeout de cadência**: `claimForExpiry` é UPDATE SQL cru que **não dispara `onWorkflowTerminal`** → a projeção de correlação nunca é `markTerminal` (compõe com C-04).

**Dois meta-achados que o revisor humano precisa saber antes de tudo:** (a) **o próprio prompt desta auditoria está desatualizado** — afirma 4 endpoints `/complete, /artifact, /tool-result, /turn` e cita "PRD §212"; nenhum desses endpoints existe (os reais são `PATCH /status`, `POST /traces|/stream|/complete`) e o PRD termina no §17 (MCP é §5.13). (b) **O mapa de ADRs usado pelos audits anteriores E pelos comentários do código está errado**: em canon, `execution_mode` é **ADR-018** (não ADR-006), e opt-out/LGPD é **ADR-019 (bases legais) + ADR-020 (retenção/deleção)** (não ADR-007, que é sobre arquivos do repo de conhecimento). O DEBT-08/opt-out foi ancorado num ADR que não fala de opt-out.

**Veredito para o piloto: NÃO-GO — inalterado vs 06-04, e pela mesma razão localizada** (cluster de callback + lifecycle SDR), agora com a ressalva de que **nenhuma linha de produto foi entregue** e que o fix nº1 (C-01) **dispara um novo CRÍTICO** (sentiment) se aplicado isolado. O pacote mínimo de callback continua ~15h + 1 PR backend; o pacote de piloto SDR, ~3–4 pessoa-dia.

**Tally pós-verificação (aprox.):** **7 CRÍTICO · ~20 ALTO · ~27 MÉDIO · ~30 BAIXO**. Os CRÍTICO e os ALTO de callback/SDR/permissões foram **independentemente verificados pelo orquestrador** no código dos dois repos; 0 refutados. Duas super-estimativas de agente foram **rebaixadas** após cross-check (ver §Notas: `MIG-DUP013` e a "novidade" do test-lock-in).

---

## Achados por severidade

> Convenção: `arquivo:linha` no HEAD `d6d41dc`. `[orq]` = cross-check direto do orquestrador (leitura de código nos dois repos). `SOBREVIVE` = re-aberto no HEAD e confirmado aberto (código congelado). `[CANON-STALE]` = gap no documento, não no código. `Eh` = esforço estimado.

### 🔴 CRÍTICO — bloqueia o piloto (7)

#### C-01 — `/status` por POST contra rota PATCH-only do backend → 404 (SOBREVIVE) `[orq]`
`Eh≈1h`. `post()` crava `method:"POST"` (`src/integration/bevox-callback.ts:28`); `updateStatus` roteia todo `/status` por ele (`:140`). Backend expõe **só** `app.patch(".../status")` (`bevox-backend/.../harness-callbacks.routes.ts:56`) → 404. **Caminho genérico** morre no primeiro `await updateStatus(…,"running")` (`execution-handler.ts:1410`, try em `:1409`) → boundary → `del(dedupKey)`+rethrow → retry-storm `attempts:7`. **Model-C** retorna em `:1385` *antes* do `:1410` → imune ao 404 do "running", mas herda a quebra do `dead_letter`. Maior ROI do piloto. **Remediação encenada** em `origin/fix/complete-callback-contract` + worktree `finding-j10-running-status`, **não-merged**.

#### C-02 — `proposals[]` sem `idempotency_key` → `/complete` 400 nos modos draft (SOBREVIVE) `[orq]`
`Eh≈3h`. Branch draft de `executeOrPropose` (`src/tools/_shared/mutation-tool.ts:151-157`) retorna `{action, params}` sem chave; `extractProposal` (`:341-352`) idem. Backend exige `ProposalSchema.idempotency_key: z.string().min(1)` (`harness-callbacks.schema.ts:40`). `deriveIdempotencyKey` existe (`mutation-tool.ts:166-201`) mas **não é anexado ao proposal**. Atinge main (`execution-handler.ts:1878`) e Model-C (`:422`). Bloqueia `manual_assisted`/`copilot` para qualquer org não-autonomous. **Agravante (conhecido, 06-04 item-2):** o teste novo `tests/unit/runtime/invariants/em-03-proposals-end-to-end.test.ts:276` faz `expect(payload.proposals?.[0]).toEqual({action, params})` — **trava a forma errada como correta**; o fix do C-02 obriga a atualizar este teste, que hoje dá falsa confiança.

#### C-03 — SDR-cadence não tem caminho VIVO de início (SOBREVIVE) `[orq]` `[caveat cross-system]`
`Eh≈8h`. Nenhum surface agent declara `workflow:` (`scheduler.agent.ts` tem só name/type/reasoning/permissions) → branch START `agentDef.workflow` (`execution-handler.ts:1526`) inalcançável. `WorkflowResumeServer` definido (`resume-server.ts:50`) mas `grep "new WorkflowResumeServer|new WorkflowSubscriber" src/` (excl. teste) = **0**. O harness só RESUME; nada no dispatch vivo semeia a suspensão inicial. **Caveat:** pode ser que o backend semeie a `workflow_correlation` — a divisão de responsabilidade depende do **ADR-012 "workflow resume boundary", que segue LOCAL e não-promovido ao canon** (PRD §16.4). Se o backend semeia, C-03 cai para ALTO; C-04/05/06 permanecem.

#### C-04 — Timeout de não-resposta marca cadência `failed` em vez de avançar (SOBREVIVE) `[orq]`
`Eh≈6h`. `state-store.ts:230-236` (`claimForExpiry` → `SET status='failed', suspend_token=NULL`), chamado por `cleanup.ts:44`. A FSM da cadência (`sdr-cadence.ts`) suspende cada toque em `reply:inbound` com timeout de dia (`:214-222`, 3–14 dias). **Mas o avanço só ocorre via REPLY** (o resume re-entra em `reply-branch-tN`); um **timeout de não-resposta não resume — falha**. Logo o braço "soft-no / no reply / timeout → continuar cadência" (`:336`, `set-working-tN`) é **inalcançável pelo gatilho que deveria acioná-lo**. Isso **inverte o modelo de cadência** (um 7-toque manda o toque-2 *porque* o toque-1 não teve resposta). Na prática: **cadência de 1 toque** no caso dominante.

#### C-05 — Model-C sem error boundary: falha transiente perde execução + dedup bloqueia retry (SOBREVIVE) `[orq]`
`Eh≈5h`. `_dispatchModelCImpl` (`execution-handler.ts:214-587`) envolve em `.catch` **apenas** `resumeWorkflow` (`:572`, explicitamente non-fatal) — **sem try/catch** em volta de `runWithTimeout(runSurfaceAgentLoop)` (`:491`), `engine.synthesize` (`:504`) e `sendComplete` (`:513`). A chamada `return await dispatchModelC(...)` (`:1385`) fica fora do try genérico (`:1409`); a dedup-key adquirida em `:1122-1126` só é limpa em `:2184` (catch genérico, nunca alcançado pelo Model-C). Um throw transiente (blip LLM, timeout, 4xx do sendComplete) propaga ao worker **sem `/complete(failed)`, sem limpar dedup** → todo retry em 1h bate no dedup-skip → **execução silenciosamente perdida**, pendurada `running` no backend.

#### C-06 — Respostas vivas nunca qualificam lead nem honram opt-out (SOBREVIVE) `[orq]` `[canon: ADR-019:57 opt-out, NÃO ADR-007]`
`Eh≈8h`. Resume payload do Model-C crava `observedSignals: {}` (`execution-handler.ts:565`, marcador FOLLOW-UP `:556`). Os guards da cadência leem `payload.positive`/`payload.optOut` **top-level** (`sdr-cadence.ts:148-158`), que o Model-C nunca seta (e os guards nem leem `observedSignals`). Rastreando: `isPositiveSignal`→false, `isOptOut`→false → **toda** resposta viva cai no braço falsy/falsy → `set-working-tN`. O `runQualifyGate` (`:167`) precisa de evidência PACT também nunca derivada — qualificação é **duplamente morta** no vivo. **Opt-out nunca honrado** → risco LGPD (canon **ADR-019:57** exige "opt-out geral" em V1; o termo `replied?` existe no tipo mas é ignorado).

#### C-07 (NOVO) — `sentiment` da pipeline não-clampado → `/complete` 400 silencioso (perda de execução); LATENTE, mascarado pelo C-01 `[orq]`
`Eh≈1h`. O `sentiment` do analyzer é LLM-driven e **não é validado contra o enum em nenhuma camada**: o agente faz `classification = JSON.parse(response.content) as ClassificationOutput` (`message-analyzer.agent.ts:80`, cast cru, sem Zod) e o handler faz `sentiment: typeof out["sentiment"]==="string" ? out["sentiment"] : "neutral"` (`execution-handler.ts:1078`). Flui a `sendComplete` em `:1499` (ReAct), `:1970` (genérico) e `mapWorkflowResultToCallback(..., analyzerOutput.sentiment)` (`:1603`). Backend: `sentiment: z.enum(["positive","neutral","negative","frustrated","angry","confused"])` **estrito** (`harness-callbacks.schema.ts:51`) — o `.passthrough()` do objeto admite chaves desconhecidas, **não** valores de enum inválidos. Um único rótulo fora dos 6 (PT-BR "positivo", "mixed", "hopeful", "annoyed"…) → **400** → engolido pelo `.catch` do call-site → job ACKa "completed" → **execução perdida sem dead_letter nem retry**.
- **Nuance crítica (cross-check do orquestrador — o agente não a viu):** hoje os 3 caminhos afetados (`:1499`/`:1603`/`:1970`) chamam `updateStatus("running")` antes (`:1410`/`:1584`) → **o C-01 (404) os mata primeiro**; o Model-C crava `sentiment:"neutral"` (`:518`) e é imune. **Portanto C-07 está mascarado HOJE e vira CRÍTICO vivo no momento em que o C-01 for corrigido** (o fix nº1). **Co-fix obrigatório com C-01.** Não estava em nenhum audit anterior.

> **Nota de escopo (C-03..C-06):** pressupõem que o piloto é a cadência SDR/Model-C (caminho vivo `dispatchModelC`, selecionado por `agent_config.sdr_profile.enabled===true` + `contact_id` + `workflow_correlation`). C-07 é independente disso — atinge o **caminho genérico**, e por isso é o de maior alcance assim que o C-01 cair.

---

### 🟠 ALTO — bloqueia GA, não necessariamente o piloto (~20)

**Cluster de callback/contrato (todos SOBREVIVEM, `[orq]`):**

| ID(s) | Achado | Evidência | Eh |
|---|---|---|---|
| `CB-NEW-03`/`LIFE-NEW-04` | Abort emite `strategy:"aborted_cost"`/`"aborted_timeout"` fora do enum do backend → 400; desfecho nunca persiste. **Nuance:** o comentário `:2090-2094` *afirma* que aborts "mapeiam pro mesmo desfecho `failed`/só telemetria", mas o código crava a string `aborted_*` no corpo (`:2150`) — a intenção **não** é realizada no wire. | `execution-handler.ts:2096-2100`,`:2150`; backend `schema.ts:57-65` | 1 |
| `AGENTRESP-STRATEGY-TYPE` (NOVO, raiz de CB-NEW-03) | `AgentResponse["strategy"]` (TS, `engine.ts:82`) **omite** `aborted_*`/`request-human`; o boundary só compila porque alarga para `string` na fronteira do callback — o type-system **não** protege o contrato de enum. | `engine.ts:82`; `execution-handler.ts:2096` | 2 |
| `AUD-PROPOSAL-CHECK` | Audit-rows de proposta (`action_type='proposal'`,`result='proposed'`) **violam o CHECK da 013** (`action_type IN ('filter_evaluation','escalation','mutation_execution')`, `result IN ('success','failure','pending_approval')`) → INSERT 23514 engolido pelo `.catch` fire-and-forget → draft proposals **sem trilha de auditoria** (viola §12.12). Model-C `executeTool` (`:405-430`) **não emite audit de mutação algum**. | `execution-handler.ts:1857,1866`; `migrations/013_execution_audit_extension.sql:38,49`; `security/execution-audit.ts:106` | 2 |
| `LIFE-NEW-02` | `dead_letter` nunca persiste (mesmo POST→PATCH 404, `.catch`-guardado em `bullmq-consumer.ts:161`). Backend tem `markExecutionDeadLetter` (`routes.ts:76`) **inalcançável**; reconciliação só via cron 120s. | `bullmq-consumer.ts:155-161`; backend `routes.ts:56` | 1 |
| `LIFE-NEW-03` | Running-404 → retry-storm 7× + terminal prematuro (`/complete(failed)` no attempt 1). C12 (correto isolado) **amplifica** aqui. | `execution-handler.ts:2087-2191` | 2 |
| `IDEM-05` | Chave de idempotência não anexada ao proposal → backend não dedupa a proposta no approval (re-booking no handoff humano). | `mutation-tool.ts:153` | 2 |
| `PRD-CONTRACT-E2E-TEST` | **Nenhum teste valida corpo de callback contra os schemas Zod reais do backend** (marco-1 §16.1 item-2 ABERTO). `smoke 01` (`scripts/smoke/01-execution-roundtrip.ts:75`) só faz poll de `job.getState()`, não sobe backend; `streaming-contract.test.ts:5` cita o schema do backend **em comentário** e crava o shape. **Causa sistêmica** de C-01/02/07+CB-NEW-03+AUD-PROPOSAL escaparem de "1236 passed". | `tests/integration/*` vs backend `schema.ts` | 8 |

**Cluster SDR/lifecycle (SOBREVIVEM + NOVOS, `[orq]`):**

| ID(s) | Achado | Evidência | Eh |
|---|---|---|---|
| `CORR-ORPHAN-LEAK` (NOVO) | Timeout de cadência deixa **linha-órfã em `workflow_correlation`**: `claimForExpiry` é UPDATE SQL cru (`state-store.ts:230`) que **não dispara `onWorkflowTerminal`** (emitido só por `engine.ts:224/251` → `correlation-projection.hook.ts:7 markTerminal`). A linha fica `suspended` na projeção → `resolveActiveByContact` (`correlation-store.ts:126-173`) pode casar um reply futuro com um workflow `failed`, ou disparar a ambiguidade `:173`. Compõe com C-04. | `state-store.ts:230`; `engine.ts:224`; `correlation-store.ts:113` | 3 |
| `STATUS-NEVER-PAUSED` (NOVO) | Harness **nunca emite `status:"paused"`** — só `"running"` (`:1410`,`:1584`) e `"dead_letter"` (`bullmq-consumer.ts:155`); backend aceita `paused` (`schema.ts:16`). Uma cadência suspensa (3–14 dias) é indistinguível de execução ativa pro backend. | `grep '"paused"' src/` = 0; backend `schema.ts:16` | 2 |
| `SDR-NOSPEC` (= F0) | A cadência SDR — produto do piloto — **não tem PRD/ADR canônico**; PRD §2/§5 descrevem o sistema genérico. ADR-012 (resume boundary) é local, não-promovido. | canon `30_adr/bevox-harness/` só tem 016-019 | 4 |
| `T-NEW-03` | Caminho de resume do piloto **sem teste algum**: `resume-server.ts` 0%, `subscriber.ts` 0%, `state-store.ts` 0% de cobertura. | coverage v8 | 6 |

**Permissões / observabilidade / ownership / doc (SOBREVIVEM + NOVOS):**

| ID(s) | Achado | Evidência | Eh |
|---|---|---|---|
| `MCP-EMPTY-ORG` (NOVO, `[orq]`) | MCP roda com `organizationId=""` quando `opts.organizationId` e `BEVOX_DEFAULT_ORGANIZATION_ID` ausentes (`?? ""`). Execução **sem tenant** no canal lateral → Layer-2 (accountDenied keyed em org) errado, writes de memória em org `""`. | `mcp/server.ts:80` | 3 |
| `AUTHZ-ALLOWLIST` | Evaluator é **denylist-only**: o allowlist `required`/`optional` do agent **nunca é enforçado** (só `logger.warn` em `:111`); `optional` não é lido. Surface agent executa qualquer tool não-negada. | `permissions/evaluator.ts:88` (default `granted:true`),`:111` | 5 |
| `OBS-DELTA-01` (C13 parcial) | `usage` real só no happy-path genérico; Model-C (`:518`), workflow (`:1042`) e abort (`:2150`) mandam `{0,0}` (acumulador não-lido). Telemetria de custo zerada pro tráfego real do piloto. | `execution-handler.ts:1954` (lê) vs `:516/:1039/:2150` | 2 |
| `PRD-COST-NOT-PROPAGATED` | `cost_usd` computado mas nunca propagado ao `/complete` (PRD §5.17/§10.2). Schema `usage` do backend nem tem campo de custo. | `usage-tracker.ts:29`; `bevox-callback.ts:67` | 3 |
| `PRD-ADR017-OWNERSHIP` | ADR-017 não-implementado: harness persiste `contact_profiles`/`contact_facts` local; **sem `BackendCustomerClient`**. Divergência de SoT + **vazamento LGPD** (ver `ADR020-LGPD-ORPHAN`). | `contact-{facts,profile}.repository.ts`; `grep BackendCustomerClient src/` = 0 | 24 |
| `ADR020-LGPD-ORPHAN` (NOVO) | ADR-020 _shared põe retenção/hard-delete num worker **do backend** (`bevox.retention.worker`) sobre tabelas do backend. Como o harness mantém PII local (`contact_facts`) e não migrou pro read-through (PRD-ADR017), um `DELETE /customers/:id` no backend **deixa as linhas do harness intactas** → erasure LGPD (art. 18) não honrável fim-a-fim. É a forma nomeada (ADR-019/020) do risco que o DEBT-08 só gesticulou via ADR errado (007). | `memory-extractor.agent.ts:3-4`; `grep retention\|deletion src/` = só BullMQ failed-set | (= ADR-017) |
| `DOC-08`/`PRD-OPENAPI-STALE` | OpenAPI `agent-harness-v1.yaml` é v1.0.0, `account_id`-native, **não parseia** (ScannerError ~`942`), sem `organization_id`/`execution_mode`/`response_text`/`proposals`/`usage`/`cost_usd`/`strategy:workflow`. Único contrato consumível, obsoleto e quebrado. | `openapi/agent-harness-v1.yaml:5` | 8 |
| `PRD-CALENDAR-RETRY-CB` | Calendar Service segue `fetch` cru — sem retry/circuit-breaker (LLM já tem). PRD §15.4 escopava "LLM **e** Calendar". O único surface agent vivo (Scheduler) chama calendar. | `calendar-client.ts` (grep retry/circuit = 0) | 6 |
| `a-reasoning-02` | Engine escalado descartado antes do `synthesize` → `/complete.strategy`/`escalated`/`retriesUsed` sempre reportam o engine BASE. O teste novo `engine-swap-mid-loop.test.ts` **documenta** o swap, não fecha o gap. | `execution-handler.ts:498,1938` | 4 |
| `a-reasoning-05` | Unwrap de STOP-tool regride no caminho plan-execute escalado → `response_text` vira JSON cru do envelope da tool. | `plan-execute.ts:272`; `react.ts:224,265` | 3 |
| `C7-WF-UNGATED` | Caminho de workflow (`wfExecuteTool`) resolve+executa qualquer tool do registry **sem permission check, sem hoist de proposal, sem audit**. Latente (nenhum agent declara `workflow`); vira CRÍTICO vivo quando algum declarar. | `execution-handler.ts:1537-1547` vs gate `:408` | 2 |
| `D-04`/`j-build-02`/`j-build-04` | CI nunca roda `--coverage`, thresholds comentados (`vitest.config.ts:22-30`, alvo 70/70/65/70 — **branches 64.21% já abaixo de 65%**); `format:check` (prettier) **VERMELHO em 11 arquivos** (`execution-handler.ts`, `mutation-tool.ts` + 3 `.test.ts`) → job "Lint & Format" reprova todo push; `npm install --ignore-scripts` em vez de `npm ci`. | `.github/workflows/ci.yml:23,25`; `vitest.config.ts` | 3 |

> **Léxico legado (ADR-019/021):** `src/` = **0** (produção limpa, `resolveOrganizationId` colapsada, 0 refs); `migrations/` = 77 hits **históricos** pré-011 (0 reintrodução, 0 `workspace_id`); `tests/` = 75 (maioria legítima — asserts de que `account_id` *sumiu*). Único hit de produção-adjacente material → `CONSUMER-SKILL-LEXICON` (MÉDIO, abaixo).

---

### 🟡 MÉDIO — degrada qualidade (~27)

**Contrato / léxico de consumidor:**
- `CONSUMER-SKILL-LEXICON` (NOVO) — a skill **consumidora** `skills/bevox-agent-harness-consumer/` (referência que integradores leem) é **inteiramente `workspace_id`/`tenant_id`-native**, citando ADR-001/003: `SKILL.md:36,44`, `references/execution-payload.md:10-11` (`"workspace_id": "01HX…"`, `"tenant_id": null` "alias legado"), `references/mcp-tools.md:16,26`. **Duas gerações de canon de tenancy atrasada** vs o wire real (`organization_id`/ADR-019). Um integrador que monte o payload daqui manda campo que o Zod rejeita. (O grep src-only dos audits anteriores não pegou.) `Eh≈2h` (vive em hub/repo skill).
- `MCP-002` — `references/mcp-tools.md` documenta **5 tools fictícias** (`inspect_execution`, `simulate_execution`, `list_tools_available`, `read_memory`, `health_check`) que o servidor **não expõe** (ele expõe as skills built-in via `MCP_EXPOSED_SKILLS`).
- `IDEM-06` — header `Idempotency-Key` no `/complete`/`/status` **lido em lugar nenhum** pelo backend (`routes.ts:138-201`); o contrato C10/ADR-023 anunciado em `bevox-callback.ts:9-13` não é honrado (defesa-em-profundidade morta + drift de doc).
- `CB-NEW-05` — meta do `dead_letter` stripada (`StatusCallbackSchema` sem `.passthrough()`, `schema.ts:15-17`).
- `H-CB-06`/§16.1-item-1 — sem header de versão de contrato (`grep X-API-Version src/` = 0; só prefixo `/v1/`).
- `MARCO1-SELF-STALE` (NOVO) — os `[x]` do PRD §16.1 **superestimam**: "token accounting real" é `[x]` mas só no happy-path genérico (OBS-DELTA-01 mostra `{0,0}` no Model-C/workflow/abort — exatamente o caminho do piloto). Não confiar no auto-assessment do PRD como sinal de prontidão.

**SDR / workflow:**
- `SDR-INTEG-TEST-FALSE` (NOVO) — teste de integração de lifecycle SDR dá luz-verde a um caminho vivo **inalcançável** e **consagra o C-04** como comportamento correto (re-confirma `T-NEW`).
- `AUTHZ-WF-DIRECTIMPORT` — `sdr-cadence.ts:54,168` chama `qualifyOpportunitySkill.execute(params, {} as never)` por import direto (pula gate/registry/audit). NIL hoje (skill pura), smell se copiado.
- `WF-LOCKVERSION-UNUSED` — `state-store.ts` bumpa `lock_version` mas o WHERE não tem o predicado → last-write-wins; mitigado por guards de status.

**Reasoning (refinam a-reasoning-* do 06-04, `[orq]` parcial):**
- `WRAP-REFLEXION-NORERUN` (NOVO/refina a-reasoning) — escalação wrap-reflexion **avança `stepIndex` além do passo que falhou** em vez de re-rodá-lo → o retry do Reflexion nunca re-executa o passo que disparou a escalação.
- `STEPEVAL-RULE3-THRASH` (NOVO/refina a-reasoning-04) — Rule 3 do StepEvaluator conta `observations.length` cumulativo, não revisões-de-plano → após qualquer escalate-to-plan-execute, re-escala a cada passo seguinte (engine-swap thrash); o teste novo `engine-swap-mid-loop` documenta, não impede.
- `ESCALATE-STEPINDEX-RESET` (NOVO) — `escalate-to-{plan-execute,rewoo}` zera `stepIndex=0` mas alimenta o novo engine um plano cujo `step()` indexa `plan.steps[stepIndex]` re-planejado do zero → passos prévios podem repetir/pular.
- `a-reasoning-01/03/07` — Reflexion `learnedContext` lido em lugar nenhum (no-op); ReWOO `executeWaves`/`buildWaves` dead-code + escalate roda sequencial ignorando `dependsOn`; ReWOO inalcançável do surface default (1 passo nunca atinge `parallelThreshold`).

**Context / observabilidade:**
- `CTX-04`/`CTX-05` — tokenizer heurístico `words×1.3` (não BPE, `tokenizer.ts:16`); truncação corte proporcional único sem re-medida (`budget-enforcer.ts:212`).
- `CTX-CAL` — 5ª camada `CalendarLayer` **órfã** (`builder-factory.ts:51` comentada; sem `getCalendarContext` no calendar-client) → "5 camadas" = **4** vivas.
- `CTX-DOUBLE-MODELC` (NOVO) — Model-C constrói contexto duas vezes; a 2ª nunca chega ao LLM pelo caminho do builder (compute desperdiçado).
- `COST-OVERCOUNT-CEIL` (NOVO) — `Math.ceil` por chamada super-conta custo; combinado com `cost_usd` não-propagado, o único consumidor é o gate J9 (teto pode disparar cedo).
- `BUDGET-TOOLS-NOTRIM` (NOVO/refina CTX) — footprint de tool-definitions conta no budget mas o gate não consegue trimá-lo; o caminho warn-and-proceed manda prompt over-budget ao LLM silenciosamente.
- `OBS-DELTA-02`/`OBS-DELTA-03` — `UsageTracker`/`execution_usage` dead-code (nunca instanciado fora de teste); métricas de dispatch log-only (sem exporter; per-process, resetam no restart).
- `OBS-PII-02` — `recordException` ecoa corpo de erro do backend ao span se `OTEL_ENABLED=true` (off por default; mas dispara muito dado o alto reject-rate dos CB-NEW-*).
- `REDACTORS-DEAD-EGRESS` (NOVO) — `redactors.ts:59-60` lista paths de egress (`callback.payload.messages.*.content`, `.response`) que **nenhum log statement preenche** (`bevox-callback.ts` nunca loga sob `callback.payload`) → controle §5.18 é **paper-control inerte** (baixa exposição real, mas invariante não-exercida).

**Permissões / MCP / segurança:**
- `PERM-02` — MCP nunca chama `setPermissionAuditLogger` → tráfego MCP 100% não-auditado (`mcp/bootstrap.ts`).
- `PERM-04`/`PERM-AUDIT-FLOOD` (NOVO sharpen) — `permission_audit` sem dedup per-execução nem batching → 1 INSERT "allow" por tool por execução (flood + latência).
- `MCP-PARAMS-NOREVALIDATE` (NOVO) — skill MCP recebe `params` do SDK sem re-validação de manifest antes de chegar a skill DB/LLM.
- `PERM-06` — testes do evaluator sub-cobrem a matriz 3-camadas + complemento allowlist PERM-05 (o novo `perm-03-ordering.test.ts` cobre ordem audit↔callback, não a matriz).
- `MCP-008` — invariante de exposição frágil (glob `MCP_EXPOSED_SKILLS` largo pode vazar skills sales/SDR/calendar-mutation).

**Migrations / infra:**
- `DC-PGVECTOR` — dev `docker-compose.yml:3` (`postgres:16-alpine`) e CI `ci.yml:44` (`postgres:16`) **sem pgvector** → migration 006 aborta no chain do zero (prod usa `ghcr.io/bernardtavares/bevox-postgres`).
- `MIG-003` — 011 é DROP+CREATE destrutivo sem backfill (aceito pré-prod).
- `SMOKE01-NONFUNCTIONAL` (NOVO/sharpen LIFE-NEW-05) — `smoke 01` não só é "falso e2e": não sobe backend e só polla `job.getState()`; **mascara** todo o cluster CB-NEW + C-07.

---

### 🟢 BAIXO — higiene (~30)

**Léxico/doc-drift `[CANON-STALE]`:** `TEST-LEXICON-DRIFT` (NOVO) — `accountId` como campo vivo em ~6 fixtures de teste (`context-builder.test.ts:36,168`, `memory-extractor.test.ts:13`, `reasoning-stream-hook.test.ts:16`, `segment-account.test.ts:26`) — `src/` limpo, só drift de fixture; `DOC-10` (README **mojibake** UTF-8 duplo em todo o PT-BR); `docs/` ~116 hits de `account_id`/`workspace_id` históricos (CANON-STALE); `CB-NEW-01-DOC` (OpenAPI declara `patch` p/ `/status` mas nota "harness usa POST" — a spec normaliza o bug); `DOC-01` (contagens CLAUDE.md "12 tools/4 cat" `:48` vs "15" `:140`, "11 migrations" `:177` vs 15 reais, "13 tools" `:221`); `DOC-06/07` (PRD §11.1 "7 migrations" + invariante `account_id` vs 15 arquivos/organizationId; §5.21 "~11 stages" vs ~17); `DOC-SKILLS-04` (`SessionStart.sh` saúda citando `execution_mode`/`organization_id` já entregues + `workspace_id` retirado).

**ADR-cite (meta, `[orq]`):** `ADR-CITE-MAP-WRONG` — audits anteriores E comentários de código usam um mapa de ADR errado: `mutation-tool.ts:150` cita "(ADR-006 + ADR-007)" pra draft proposals; CLAUDE.md/rules citam hub-scheme ("ADR-006 execution_mode", "ADR-023 idempotency"). Em **canon**: execution_mode = **ADR-018**; autonomia/aprovação = ADR-006; sensitive-data (arquivos do repo de conhecimento, **não** redação runtime) = ADR-007; opt-out/LGPD = **ADR-019/020**; UUIDv7 = ADR-016. Reconciliar antes de citar. `Eh≈2h`.

**Reasoning / engines:** `SYNTH-RAW-ENVELOPE` (NOVO) — `synthesize` de ReWOO/PlanExecute/Direct seleciona "última observação bem-sucedida" que para um passo de tool é `JSON.stringify(toolOutput)` (envelope cru) sem unwrap STOP; `PARSEACTION-SILENT-DEGRADE` (NOVO) — falha de `parseAction`/JSON em qualquer `step()` degrada silenciosamente uma tool-call malformada em "resposta final" texto sem marcar o passo como falho; `a-reasoning-06/08/09` (`escalateTo` dead field; wrap-reflexion pode aninhar sem guard; `DirectEngine` nunca instanciado em prod).

**MCP / outros:** `MCP-ERR-ECHO` (NOVO) — catch-all do MCP ecoa `err.message` cru ao caller externo; `PINO-REDACT-SHALLOW` (NOVO) — wildcards de redação Pino são single-level (`*.token`), segredos aninhados fundo não-redigidos; `COST-CALC-STALE` (NOVO) — tabela de preços do `cost-calculator` incompleta → custo 0 silencioso p/ modelo desconhecido (inclui o default se driftar); `OTLP-NO-TIMEOUT` (NOVO) — exporter OTLP sem timeout/batching explícito, auto-instrumentação larga; `CALENDAR-HEALTH-DOC-DRIFT` (NOVO/confirma) — stage `calendar-health` aceita 404 (só timeout/erro de rede aborta) — **correto**, mas doc diverge; `LOCKFILE-SMOKE-MISMATCH` (NOVO) — gerenciador de lockfile do smoke tooling diverge do CI; `MIG-DUP013` (dois `013_*.sql` — **não-hazard**, `migrate.mjs` chaveia por **filename completo** PK, ambos aplicam em ordem lex; ver §Notas: agente super-estimou como ALTO); `IDX-LEGACY-NAME` (9 índices `idx_*_account` em 011 indexando `organization_id` — cosmético); `LIFE-NEW-06` (sem DLQ dedicada — backend `status='dead_letter'` é a autoritativa; diferido v2).

#### Confirmações que NÃO são gaps (evitar re-investigação) `[orq]`
- **`init-rag`/`init-memory-d3`/exposição MCP/LLM Recorder são fail-CLOSED** (padrões vazios → `[]`; replay lança `CassetteMissError`). Invariantes §12.15/§12.17 satisfeitas.
- **`strategy:"reflexion"` NÃO vaza ao `/complete`** — `ReflexionWrapper.strategy` delega a `inner.strategy` e o tipo `AgentResponse["strategy"]` exclui "reflexion".
- **PII-para-OTLP é BAIXO** (spans são metadados-only; único vetor = `recordException` de corpo de erro do backend, só com `OTEL_ENABLED=true`).
- **Léxico de tenancy em `src/` = 0**, `resolveOrganizationId` colapsada — confirmado.
- **§15.5 budget abort (J9) LANDED** — `HARNESS_MAX_COST_USD` + override de payload (`env.ts`; `execution-handler.ts:689,884`); ressalva: o abort emite strategy off-enum (CB-NEW-03).

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. **Mudança-chave vs 06-04:** o item nº1 agora **arrasta um co-fix obrigatório** (C-07).

1. **C-01 + C-07 juntos — `/status` por PATCH **E** clamp de `sentiment`** (`~2h`). O C-01 isolado (POST→PATCH) é o maior ROI, **mas expõe o C-07** (400 silencioso de sentiment no happy-path). Fazer os dois no mesmo PR: `patch()` dedicado + `extractAnalyzerOutput`/analyzer clampam sentiment ao enum (fallback "neutral"). **Nunca mergear C-01 sozinho.**
2. **C-02 + IDEM-05 — `idempotency_key` no proposal** (`~3h`). `executeOrPropose` anexa `deriveIdempotencyKey(context, params)` ao proposal. **Atualizar `em-03-proposals-end-to-end.test.ts:276`** (que trava a forma errada).
3. **CB-NEW-03 + AGENTRESP-STRATEGY-TYPE + AUD-PROPOSAL-CHECK** (`~3h`). Mapear abort→`failed`+meta (ou estender enum backend); **apertar o tipo `AgentResponse["strategy"]`** pra o type-system pegar o próximo; estender/remapear o CHECK da 013 (`proposal/proposed`→`mutation_execution`/`pending_approval`).
4. **PRD-CONTRACT-E2E-TEST — teste de contrato contra os schemas Zod do backend** (`~8h`). Pega C-01/02/07+CB-NEW-03+AUD-PROPOSAL na fonte. **Pré-requisito de confiança** de todos os fixes acima (marco-1 §16.1 item-2).
5. **C-05 — error boundary no Model-C** (`~5h`). Espelhar `:2087-2191`: `/complete(failed)` + limpeza de dedup em erro transiente.
6. **C-04 + CORR-ORPHAN-LEAK — avanço de cadência no timeout + markTerminal** (`~7h`). `claimForExpiry` re-suspende/avança o cursor **e** dispara `onWorkflowTerminal` (ou chama `markTerminal`) pra não orfanar a correlação.
7. **C-06 — extração de sinais NLU** (`~8h`). Mapear inbound→`{positive, optOut, PACT}` no resume Model-C. Risco LGPD (ADR-019:57 opt-out) + habilita qualificação.
8. **C-03 — caminho de start de cadência** (`~8h`, **confirmar boundary cross-system primeiro** — promover ADR-012 ao canon). Instanciar resume-server/subscriber ou declarar `workflow` no agent — ou documentar que o backend semeia.
9. **MCP-EMPTY-ORG — falhar fechado em org vazia** (`~3h`). `mcp/server.ts:80` deve lançar/recusar boot quando `organizationId` resolve para `""` (sem default silencioso).
10. **DOC-08 + CONSUMER-SKILL-LEXICON — regenerar OpenAPI + corrigir a skill consumidora** (`~10h`). Spec a partir do contrato Zod real (organizationId/execution_mode/proposals/usage/cost_usd/strategy:workflow); migrar `skills/bevox-agent-harness-consumer/` de `workspace_id`→`organization_id`. Destrava sign-off de integração.

> **Itens 1–4 ≈ pacote mínimo de callback** (~16h + 1 PR backend). **1–9 ≈ pacote de piloto SDR** (~3–4 pessoa-dia). **10 + ADR-017/ADR-020 + Calendar CB ≈ pacote de GA.**

---

## Dependências cruzadas

- **C-01/CB-NEW-03 (verbo `/status` + enum abort)** → **bevox-backend** (`routes.ts:56` PATCH-only; `schema.ts:57-65` sem `aborted_*`). Fix unilateral-harness recomendado (conformar ao backend).
- **C-02/IDEM-05 (`idempotency_key`)** → **bevox-backend** (`schema.ts:40` já exige; divergência unilateral do harness).
- **C-03 (start de cadência)** → **bevox-backend / canon**: confirmar quem semeia `workflow_correlation`; depende do **ADR-012 promovido ao canon** (PRD §16.4).
- **AUD-PROPOSAL-CHECK** → migration local (estender CHECK da 013).
- **PRD-CONTRACT-E2E-TEST** → **bevox-backend** (importar/validar contra os schemas Zod reais; `test/integration/harness-contract.test.ts` já existe lá — falta o lado harness cross-validar).
- **PRD-ADR017 + ADR020-LGPD-ORPHAN (ownership/deleção)** → **bevox-backend**: harness vira read-through HTTP (`BackendCustomerClient`) + endpoints `Customer`/`CustomerFact`; deleção LGPD cascateia pelo backend.
- **PRD-COST-NOT-PROPAGATED** → **bevox-backend** (estender `usage` schema com `cost_usd`).
- **DC-PGVECTOR** → infra/CI (trocar imagem PG por `bevox-postgres` com pgvector).
- **CONSUMER-SKILL-LEXICON / ADR-CITE-MAP-WRONG** → **canon/hub** (`skills/bevox-agent-harness-consumer/` vive no hub `bevox-PRD-consolidation`; reconciliar ADR-001/003→019).
- **HARNESS_QUEUE_NAME em prod** (memória `backend-dispatch-retry-contract`) → confirmar no manifest do hub `infra/` que o nome pinado é `bevox.execution.dispatch` (P0 operacional; fora do escopo deste repo).

---

## Delta vs audit anterior

**Linhagem de tally:** 2026-06-02 = **13 CRÍT · 20 ALTO · 46 MÉD · 34 BAIXO** (113) → 2026-06-04 = **6 · 17 · 23 · 22** (68, ~40 fechados) → 2026-06-23 = **7 · ~20 · ~27 · ~30**.

### FECHADOS desde 06-04
**Nenhum CRÍTICO/ALTO de produto fechou** — o código está congelado (`git diff origin/main..HEAD -- src migrations openapi` = vazio). Nenhuma das 30+ branches `fix/*`/`op-*` que remediam o cluster 06-04 (`fix/complete-callback-contract`, `finding-j10-running-status`, `op-openapi-sync`, `op-reasoning-quality`, `op-ctx-*`, `fix/usage-tracker-real`, `fix/sdr-ultrareview-findings`…) foi integrada a `main`. A remediação está **encenada, não entregue**.

### SOBREVIVEM (de 06-04)
**Todos os 6 CRÍTICO** (C-01..C-06) e **os 17 ALTO** — re-verificados `arquivo:linha` no HEAD. Os MÉDIO/BAIXO de 06-04 idem, salvo os de teste abaixo.

### MOVIMENTO DE TESTE (a única coisa que mudou)
Os 20 commits subiram a cobertura **+2,36pp stmt / +1,66pp br** via *invariant guards* em `tests/unit/runtime/invariants/**` (perm-03 ordering, ctx-02 budget, x-token header, otel span, engine-swap, em-03 proposals, proposals-accumulator-isolation) + evals/rag/security/workflow. **Efeito no finding-set:**
- **Nenhum CRÍTICO/ALTO fechado** por estes testes (são guards de regressão, não fixes).
- **`T-NEW-03`/`D-05`/`BOOT-005` SOBREVIVEM**: os módulos a 0% (`resume-server` 0%, `subscriber` 0%, `state-store` 0%, `scheduler.agent` 20%, `stages` 0.57%, `runner` 0%, `condense-worker` 0%, `bevox-mcp` 0%) **não foram tocados**.
- **`D-01` REVISADO** (execution-handler ~59%, sem mudança material).
- **Regressão de teste:** `em-03-proposals-end-to-end.test.ts:276` **trava a forma de proposal sem `idempotency_key`** — o teste-uplift entrincheirou o C-02.

### NOVOS (não estavam em 06-04)
- **C-07** (sentiment não-clampado → 400 silencioso, latente atrás do C-01).
- **ALTO:** `MCP-EMPTY-ORG`, `STATUS-NEVER-PAUSED`, `CORR-ORPHAN-LEAK`, `AGENTRESP-STRATEGY-TYPE`, `ADR020-LGPD-ORPHAN`.
- **MÉDIO:** `CONSUMER-SKILL-LEXICON`, `MARCO1-SELF-STALE`, `REDACTORS-DEAD-EGRESS`, `CTX-DOUBLE-MODELC`, `COST-OVERCOUNT-CEIL`, `BUDGET-TOOLS-NOTRIM`, `WRAP-REFLEXION-NORERUN`, `STEPEVAL-RULE3-THRASH`, `ESCALATE-STEPINDEX-RESET`, `MCP-PARAMS-NOREVALIDATE`, `SMOKE01-NONFUNCTIONAL`, `SDR-INTEG-TEST-FALSE`.
- **BAIXO:** `TEST-LEXICON-DRIFT`, `ADR-CITE-MAP-WRONG`, `SYNTH-RAW-ENVELOPE`, `PARSEACTION-SILENT-DEGRADE`, `MCP-ERR-ECHO`, `PINO-REDACT-SHALLOW`, `COST-CALC-STALE`, `OTLP-NO-TIMEOUT`, `LOCKFILE-SMOKE-MISMATCH`.

**Resumo do delta:** o veredito de piloto é **idêntico** ao de 06-04 (NÃO-GO, mesmo cluster) porque **nada de produto foi entregue em 19 dias**. O valor desta rodada é (a) **confirmar a estase** (a equipe testou, não corrigiu); (b) **expor o trap de sequência C-01→C-07** (o fix nº1 dispara um CRÍTICO novo); (c) achados de tenancy/segurança no canal MCP (`MCP-EMPTY-ORG`) e de doc-de-consumidor (`CONSUMER-SKILL-LEXICON`) que o grep src-only não pegava; (d) reconciliar o mapa de ADR (DEBT-08 estava ancorado no ADR errado).

---

## Notas de método

**Orquestração.** Workflow multi-agente de 1 rodada, 8 trilhas texto-markdown (sem schema estruturado — por lição registrada na memória deste repo: agentes pesados com `agentType`+`schema` não emitem `StructuredOutput` e perdem a trilha). 1 censo canônico (PRD §5/§10/§11/§12/§14/§15/§16 + ADRs 005/006/007/016/017/018/019/020/021) + 7 investigações (callbacks, autonomy, reasoning, sdr, permissions-mcp, context-obs, bootstrap-mig-tests). ~8 subagentes, ~0,8M tokens, ~7min. As trilhas receberam um *preamble* de ground-truth (HEAD, freeze, paths cross-repo, mapa de ADR) pra não re-derivar o congelamento e focar em (a) re-verificar findings no HEAD e (b) caçar o que 3 audits anteriores perderam.

**Cross-check independente do orquestrador (ground-truth `[orq]`).** Antes e depois do workflow, o orquestrador validou diretamente, lendo código: os 6 CRÍTICO (`bevox-callback.ts`, `mutation-tool.ts`, `execution-handler.ts:214-587/1360-1410/2080-2200`, `sdr-cadence.ts` inteiro, `state-store.ts`, `scheduler.agent.ts`, `resume-server.ts`), os contratos do backend (`harness-callbacks.{routes,schema}.ts` — 4 rotas, enums), o evaluator de permissões (`evaluator.ts` inteiro), `mcp/server.ts:80`, `vitest.config.ts`, `.github/workflows/ci.yml`, `scripts/migrate.mjs`, e os gates de marco do PRD (§16.1/§16.4). Grep de léxico exaustivo no repo inteiro. `git fetch` confirmou `origin/main` parado há 19 dias.

**Reconciliação / correção de super-estimativas de agente** (a memória avisa que agentes over/understate): (a) **`MIG-DUP013` rebaixado de ALTO→BAIXO** — o agente alegou hazard de deploy-do-zero, mas `migrate.mjs:12/23` chaveia `schema_migrations` por **filename completo** (PK TEXT) e `readdirSync().sort()` ordena nomes completos → ambos os `013_*.sql` aplicam, em ordem lex; não-hazard. (b) **O "test-lock-in do proposal" não é novo** — o agente o apresentou como achado novo, mas o audit 06-04 já o listara (worklist item 2, `em-03…:276`); atribuído corretamente como agravante conhecido do C-02. (c) **C-07 (sentiment) ganhou a nuance que o agente não viu** — está *mascarado pelo C-01* hoje (caminho genérico morre no "running"-404 antes; Model-C crava "neutral") e por isso é CRÍTICO-*latente*, co-fix do C-01, não "estoura no primeiro job" como o agente afirmou.

**Confiança.** Alta nos achados que citam `arquivo:linha` de código não-teste — código congelado + cross-check direto nos dois repos. A cobertura (categoria `d`) é medição real (`vitest run --coverage` exit 0, 71.15% stmt). Verdicts de contrato são contra o backend `bfe7095` (congelado, verificado).

**Limitações.** (1) A divisão harness↔backend pro **start da cadência** (C-03) não foi confirmada lendo o orchestration-service do backend a fundo — caveat preservado; o ADR-012 não-promovido é exatamente o que a resolveria. (2) O **path pgvector** dos testes de integração não foi exercitado (imagem PG local sem pgvector). (3) O **hub `infra/`** (manifest de prod, pin do nome de fila) ficou fora de escopo — confirmar lá o `HARNESS_QUEUE_NAME`. (4) A frequência real do C-07 depende de quão fielmente o LLM analyzer honra o enum de 6 valores — alta confiança de que é *alcançável* (sem clamp em nenhuma camada), sem quantificar a taxa. (5) Achados em código de teste/fixture têm confiança menor que os de `src/`.
