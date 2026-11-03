# Gap Analysis — bevox-harness — 2026-07-05

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-07-04.md` (linhagem: `2026-06-23` / `2026-06-04` / `2026-06-02`).
> **HEAD auditado:** `26fbd42` (branch `test/execution-handler-coverage-uplift`) — que **é o próprio commit do audit 07-04**. Único commit desde então: o doc de audit. **HEAD do audit anterior:** `ddf4c67`.
> **Fato estrutural decisivo — ESTASE CONTINUADA DE 4 REPOS (re-confirmada FRESCO hoje):** (1) `git diff origin/main..HEAD -- src/ migrations/ openapi/` = **vazio**; `origin/main` em `2979eb0` (2026-06-03). Último commit tocando `src/` = 2026-06-03; `migrations/` = 2026-06-02. (2) **Nenhum commit de produto** desde 07-04. (3) **Canon `bevox-knowledge` em `0317985`** (2026-06-02) — ZERO drift. (4) **Contrato de callback `bevox-backend` em `dbd231e`** (2026-06-03), backend HEAD `b61cf62` — byte-idêntico. **O produto, o canon e o contrato do backend seguem TODOS congelados no estado auditado em 06-04/06-23/07-04.**
> **Consequência metodológica:** como o alvo é byte-idêntico, **todo CRÍTICO/ALTO do 07-04 SOBREVIVE por construção** — re-verificado com citação fresca (drift de linha = 0). O valor desta rodada é **cobertura nova das superfícies que 5 auditorias deixaram sub-varridas** (MCP-outbound/SSRF, internos de observabilidade, os 11 eval scorers, CI/CD, **manifest de infra do hub**) + **1 CRÍTICO NOVO de deploy** que nenhuma rodada anterior pegou.
> **Método:** workflow multi-agente de 7 trilhas de investigação (agentes especialistas locais: Security Engineer, SRE, AI Engineer, DevOps Automator, Backend Architect) em texto-markdown **sem schema** → 1 síntese consolidadora (Code Reviewer). **~578K tokens, 8 subagentes (Opus 4.8, effort high), 0 perdidos, ~10min.** Sobre isso, **cross-check independente do orquestrador** (`[orq]`, leitura direta de código nos 3 repos) dos **7 CRÍTICO**, do **NOVO CRÍTICO** (env.ts + manifest do hub), do contrato Zod do backend, das migrations, do Dockerfile/CI, e correção de **1 superestimativa de severidade** de agente.
>
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

**Zero mudou em 32 dias — e agora com um alçapão de deploy provado.** `src/`, `migrations/`, `openapi/`, o canon e o contrato do backend seguem byte-idênticos a 06-04. Portanto **PILOTO: NÃO-GO** e **GA: NÃO-GO** permanecem, e os **7 CRÍTICO** + **~18 ALTO** do 07-04 seguem abertos, re-verificados linha-a-linha com drift zero. O que esta rodada acrescenta é de quatro tipos: (1) **1 CRÍTICO NOVO de infra — `MANIFEST-DB-ENV`** — o manifest de produção pinado (`bevox-PRD-consolidation/infra/`) injeta `BEVOX_DB_URL` (variável **nunca lida** no `src/`) e **omite `DATABASE_URL` + `CALENDAR_SERVICE_URL`**, ambos *required* pelo `env.ts` → `getEnv()` faz `process.exit(1)` no boot → **as 2 réplicas crash-loopam e nenhum job é consumido**; verificado `[orq]` nos dois lados; (2) um **cluster de infra-deploy irmão** — **`NO-MIGRATOR`** (imagem runtime não carrega aplicador de migração → schema do harness nunca criado num Postgres novo) — que junto ao (1) significa que **o pacote de deploy atual não sobe**; (3) **cobertura nova das superfícies sub-auditadas**: cluster de segurança MCP-outbound/SSRF (10 achados, todos *latent* até `bevox-mcp` ser exposto), contrato de métricas LLM não-emitido em prod (`OBS-LLM-METRICS`), os 11 eval scorers (injeção no judge, PII-scorer fraco p/ formatos BR, faithfulness sempre-N/A), e o estado real do CI (Lint & Format e Security cronicamente vermelhos); (4) **higiene analítica** — correção de 1 superestimativa de agente (`SEC-AUDIT-RED`: memo disse "2 crit + 7 high/44"; `npm audit` fresco = **0 crit, 4 high, 28 mod, 32 total**) e reafirmação de que **o prompt-mãe desta auditoria segue factualmente errado** (endpoints `/artifact`,`/tool-result`,`/turn` e "PRD §212" são fantasmas; a categoria (f) "accounts-FK" está **FECHADA** desde PR #25). **O gargalo humano é inalterado: em 32 dias a equipe testou (cobertura estável ~69% stmt) mas não integrou uma linha de fix — e ninguém deu deploy, o que agora sabemos que também não funcionaria.**

---

## Achados por severidade

> Convenção: `arquivo:linha` FRESCA no HEAD `26fbd42`. `[orq]` = cross-check direto do orquestrador (leitura de código nos 3 repos). `SOBREVIVE` = re-aberto e confirmado (código congelado). `NEW` = não em 5 audits. `SHARPENS/CONFIRMS <id>` = refina/confirma finding anterior. `Eh` = esforço estimado.

### 🔴 CRÍTICO — bloqueia o piloto

#### Incondicionais (bloqueiam o piloto em QUALQUER escopo)

- **MANIFEST-DB-ENV (NEW) — o pacote de deploy pinado crash-loopa no boot.** `[orq]` O manifest de prod do hub (`bevox-PRD-consolidation/infra/bevox-prod-manifest.yaml:143-162`) seta no bloco do serviço harness apenas `BEVOX_DB_URL` (`:155`) — variável declarada `.optional()` e **nunca lida em lugar nenhum de `src/`** (o pool sempre usa `env.DATABASE_URL`: `config/harness-config.ts:6`, `mcp/bootstrap.ts:52`, `rag/cli/*`). **Omite `DATABASE_URL` (`env.ts:8`, `.url()` required) e `CALENDAR_SERVICE_URL` (`env.ts:12`, required).** `getEnv()` (`env.ts:203-207`) faz `safeParse` → falha → `console.error` + `process.exit(1)` antes do stage 1. **Impacto:** as 2 réplicas worker morrem no boot em loop; 0 jobs consumidos; 100% das execuções caem no timeout-scan de 120s do backend → handoff humano — exatamente a falha que o comentário do próprio manifest (`:147-150`) tentou evitar para `HARNESS_QUEUE_NAME`. O dry-run `2026-05-30-findings.md:40` (Gap C) já **observou o sintoma** (`process.env.DATABASE_URL undefined`) e a "correção" expandiu env por-chave mas **errou o nome da var do harness**. **Fix mais barato (harness-side):** aceitar `DATABASE_URL ?? BEVOX_DB_URL` no `env.ts` (fallback), que faz o manifest atual funcionar; OU corrigir o manifest (renomear + adicionar `CALENDAR_SERVICE_URL`). **Residual honesto:** repousa em manifest+env serem autoritativos; se a plataforma Hetzner injeta `DATABASE_URL` fora do manifest, rebaixa — mas o modelo de secret é por-chave (sem `env_from_file`, dry-run Gap C), então improvável. `Eh≈0.5h`.
- **C-01 — `/status` por POST contra rota PATCH-only → 404 mata TODA execução do caminho genérico.** `[orq]` `SOBREVIVE, drift 0`. `bevox-callback.ts:27-28` crava `method:"POST"` para **todo** path; `updateStatus` (`:133-147`) POSTa `/status`, cuja rota backend é `app.patch(...)` (`harness-callbacks.routes.ts:56`) → **404** → `post()` faz `throw` (`:34-37`). E `await updateStatus(...,"running")` é o **1º `await` do try genérico** (`execution-handler.ts:1410`, try em `:1409`) **sem catch interno** → o throw propaga ao error-boundary → `/complete(strategy:"failed")` e o **pipeline (`:1413`) e o agente NUNCA rodam**. Não é "status perdido": é **falha de 100% do tráfego genérico**. `dead_letter` (via `updateStatus`) sofre o mesmo 404. Maior ROI de runtime do piloto. `Eh≈1h` (co-fixar com C-07).
- **C-07 — `sentiment` da pipeline não-clampado → `/complete` 400 silencioso (co-fix obrigatório do C-01).** `[orq]` `SOBREVIVE, drift 0`. `message-analyzer.agent.ts:73` faz `JSON.parse(response.content) as ClassificationOutput` (**cast cru, sem Zod**; contraste com `MemoryCondenser` que usa `.parse`). `buildCompletePayload` passa `opts.sentiment` **passthrough** (`bevox-callback.ts:91`; default "neutral" só quando `undefined`). Backend: `sentiment: z.enum([positive,neutral,negative,frustrated,angry,confused])` **estrito** (`schema.ts:51`). Rótulo LLM fora dos 6 ("positivo", "mixed", "happy") → **400** engolido → execução perdida sem dead_letter nem retry. **Mascarado HOJE** (caminho genérico morre no C-01 antes; Model-C crava `"neutral"` em `execution-handler.ts:518`) → **vira vivo no instante em que o C-01 for corrigido**. **Nunca mergear C-01 sozinho.** Fix de ponto-único: `zod.safeParse` + clamp/default no `:73`. `Eh≈1-2h`.

#### Condicionais ao escopo do piloto (CRÍTICO **se** o piloto inclui modos draft e/ou cadência SDR — postura do 07-04; senão ALTO)

> O 07-04 tratou o piloto como "a cadência SDR/Model-C" e manteve estes CRÍTICO. Como o **escopo do piloto não é confirmável** lendo só os repos, apresento-os como CRÍTICO-condicional com o gatilho explícito. **Ação ao revisor: confirmar se o piloto usa `manual_assisted`/`copilot` (aciona C-02) ou a esteira SDR (aciona C-03..C-06).**

- **C-02 — `proposals[]` sem `idempotency_key` → `/complete` 400 nos modos draft.** `[orq]` `SOBREVIVE`. Branch draft de `executeOrPropose` (`mutation-tool.ts:341-352`) e `extractProposal` retornam `{action, params}` sem chave; backend exige `ProposalSchema.idempotency_key: z.string().min(1)` (`schema.ts:40`). `deriveIdempotencyKey` existe mas não é anexado. Bloqueia `manual_assisted`/`copilot` para toda org não-autonomous. **Agravante:** `tests/unit/runtime/invariants/em-03-proposals-end-to-end.test.ts:276` trava a forma errada. **CRÍTICO se o piloto expõe modos de aprovação-humana** (feature central do ADR-006/ADR-018). `Eh≈2-3h`.
- **C-05 — Model-C sem error boundary: falha transiente perde execução + dedup bloqueia retry.** `[orq]` `SOBREVIVE`. `_dispatchModelCImpl` (`execution-handler.ts:214-587`) tem `.catch` **apenas** em `resumeWorkflow` (`:568-580`); `runSurfaceAgentLoop` (`:491`), `engine.synthesize` (`:504`) e `sendComplete` (`:513`) ficam **sem try/catch**. O `return await dispatchModelC(...)` (`:1385`) fica **fora** do try genérico (`:1409`); a dedup-key (SET NX em `:1122-1126`) só é limpa em `:2184` (inalcançável). Throw transiente → propaga ao worker **sem `/complete` terminal e sem limpar dedup** → todo retry bate no dedup-skip → **execução silenciosamente perdida**, pendurada `running` no backend. `Eh≈3-5h`.
- **C-04 — Timeout de não-resposta marca cadência `failed` em vez de avançar.** `[orq]` `SOBREVIVE, drift 0`. `state-store.ts:230-247` (`claimForExpiry` → `UPDATE workflow_executions SET status='failed', suspend_token=NULL`), chamado por `cleanup.ts:41-57` (job iniciado em `stages.ts:571`). A FSM da cadência só avança via REPLY; o braço "no-reply/timeout → continuar" é inalcançável pelo gatilho que deveria acioná-lo → cadência de 7 toques vira **1 toque** no caso dominante (sem resposta). `Eh≈4-6h`.
- **C-03 — Esteira SDR/cadência/Model-C/resume morta na fiação viva.** `[orq]` `SOBREVIVE`. `grep "workflow:" src/agents/` = **0** (`scheduler.agent.ts:9-37` é o único surface agent e não declara `workflow:`) → a única porta START (`execution-handler.ts:1526`, gated em `agentDef.workflow`) é inalcançável. `WorkflowResumeServer`/`Subscriber` existem mas têm `new … = 0` em `src/` (dead code — `C-03b`). O único resume vivo é a chamada direta do Model-C, mas nada semeia a suspensão inicial. **Caveat cross-system:** a divisão harness↔backend depende do **ADR-012 (resume boundary), LOCAL e não-promovido ao canon** (PRD §16.4). Se o backend semeia a `workflow_correlation`, C-03 cai para ALTO. `Eh≈6-8h`.
- **C-06 — Respostas vivas nunca qualificam lead nem honram opt-out.** `[orq]` `SOBREVIVE, drift 0`. Resume payload do Model-C crava `observedSignals: {}` (`execution-handler.ts:562-566`, comentário `:556-561` "out of Fase C scope"); os guards da cadência leem sinais que o Model-C nunca seta → **toda** resposta viva cai no braço `set-working-tN`; qualificação PACT nunca derivada. **Opt-out nunca honrado** → risco LGPD (_shared ADR-019/020). `Eh≈8h`.

> **Nota:** o 07-04 rotulava C-06 como CRÍTICO; a síntese desta rodada o rebaixou a MÉDIO por pressupor C-03/C-05 já corrigidos. Mantenho-o no cluster condicional-CRÍTICO por causa do **risco LGPD de opt-out** — é o item com maior custo regulatório, mesmo que funcionalmente dependente de C-03.

### 🟠 ALTO — bloqueia GA, não necessariamente o piloto

**Infra-deploy (irmão do MANIFEST-DB-ENV):**
- **NO-MIGRATOR (NEW) — imagem runtime não migra o schema do harness.** `[orq]` O Dockerfile é **multi-stage**; o `runner` (`Dockerfile:10-18`) copia só `--from=builder /app/dist ./dist` (`:16`) — **não** copia `scripts/` (onde vive `migrate.mjs`), e `npm run build` (`tsc`) **não compila** `scripts/*.mjs` para `dist/`. `CMD ["node","dist/index.js"]` (worker). `release-docker.yml` builda essa imagem única (sem migrator). **Impacto:** num `postgres-harness` novo, as 12 tabelas do harness (`contact_profiles`, `rag_*`, `workflow_*`…) **nunca são criadas** sem passo out-of-band. Compõe com MANIFEST-DB-ENV: mesmo corrigindo o env, o schema não existe. **Residual:** se o runbook do hub roda `migrate.mjs` fora do manifest (job de init), rebaixa — confirmar. `Eh≈1.5h`.

**Contrato / callbacks (sobreviventes do 07-04, `[orq]`):**
- **CB-NEW-03 / AGENTRESP-STRATEGY-TYPE — abort J8 emite `strategy` off-enum → `/complete` 400.** `execution-handler.ts:2096-2099`→`:2150`; `engine.ts:82`. `strategy:"aborted_cost"/"aborted_timeout"` ∉ enum backend (`schema.ts:57-65`) → desfecho de abort **nunca persiste**. O tipo `AgentResponse["strategy"]` omite os valores → o type-system não protege o contrato. `Eh≈3h`.
- **AUD-PROPOSAL-CHECK — rows de proposta violam o CHECK da 013 → auditoria de proposta descartada.** `[orq]` `execution-handler.ts:1856-1866`; `security/execution-audit.ts:106-120`; `migrations/013_execution_audit_extension.sql:49` (`CHECK result IN ('success','failure','pending_approval')` — exclui `'proposed'`). INSERT 23514 engolido pelo `.catch()` → draft proposals **sem trilha de auditoria** (viola Invariante §12.13, pré-condição de GA). `Eh≈1h`.
- **AUTHZ-ALLOWLIST / AUTHZ-DEFAULT-ALLOW — evaluator é denylist-only.** `[orq]` `evaluator.ts:88` (`return granted:true` default); `required` só `logger.warn` (`:109-113`); `optional` nunca lido. O allowlist estático do agent é **advisory**. **Nuance:** o allowlist de ORG (PERM-05) **É** enforçado via `accountDeniedTools` derivado (`:80`) — só o allowlist do agent é inerte. Org com `skills` vazio → surface agent invoca qualquer tool não explicitamente blacklistada. `Eh≈2-5h`.

**Reasoning (sobreviventes + sharpening, `[orq]` parcial):**
- **STEPEVAL-RULE3-THRASH (SHARPENS ESCALATE-STEPINDEX-RESET) — thrash de replan após escalação.** `step-evaluator.ts:68` compara `observations.length` cumulativo (nunca resetado) ao `stepThreshold=3` (`scheduler.agent.ts:18`); pós escalate reseta `stepIndex=0` mas não `allObservations` → **toda** iteração re-escala (`plan()`+LLM), sem progresso, até o gate de custo/wall-clock abortar → `aborted_timeout` em vez de resposta em conversas >3 passos. `Eh≈4h`.
- **a-reasoning-02 — engine escalado descartado antes do `synthesize`.** `runSurfaceAgentLoop` retorna só `Observation[]` (`:967`); ambos sites de synthesize reconstroem o engine BASE (`:498,504,1938,1945-1949`) → `/complete.strategy`/`escalated`/`retriesUsed` reportam sempre o BASE (`react`); obs de plan-execute sintetizadas pela lógica do react. `Eh≈3h`.
- **LLM-NO-FAILOVER — sem failover cross-provider.** `[orq]` `llm-gateway.ts:137-175` resolve UM provider via `switch` + `RetryDecorator(CircuitBreakerDecorator(adapter))`; **não há fallback OpenAI→Gemini**; `grep E_INFRA_LLM_ALL_DOWN src/` = 0. **Viola `.claude/rules/harness-llm.md §Failover`.** OpenAI 5xx/429 pós retry-budget → circuit abre → **toda** execução falha, Gemini nunca tentado. (O credential-pool multi-key é intra-provider, não cross-provider — confirmado.) Incidente-dependente → ALTO-GA. `Eh≈8h`.

**Observabilidade (NOVOS + sharpening da trilha SRE):**
- **OBS-LLM-METRICS (NEW) — contrato de métricas por-chamada LLM não emitido em prod.** `usage-decorator.ts:37-50` só acumula tokens+cost no **success-path** (sem catch) → `error_code` nunca capturado; `provider`/`model_id`/`duration_ms`/`cost_estimate_usd` nunca emitidos por-chamada; `DevEmitterLLM` (`dev-emitter-decorator.ts:18-20`) gated a `HARNESS_DEV_MODE`. **Impacto:** falhas/latência/custo LLM **invisíveis** na telemetria prod — spike de 429/5xx/failover sem métrica, cego no piloto. Viola `harness-llm.md §Métricas obrigatórias`. `Eh≈4h`.
- **OBS-J9-SNAPSHOT + OBS-J9-CLAUDE (SHARPENS J9-DESARMADO) — teto de custo é no-op para o default e para Claude.** `[orq]` `cost-calculator.ts:17-26` tem **6 model-ids exatos** e retorna **0** para o resto (`:50`). O `openai.adapter` retorna snapshot datado (`gpt-4o-mini`→`gpt-4o-mini-2024-07-18`) → sem match → **cost 0 no happy-path do default**; o `AnthropicAdapter` está vivo mas há **0 entradas `claude-*`** → toda call Claude custa 0; Gemini exótico idem. → `costCents >= costCeilingCents` (`execution-handler.ts:885,1196`) nunca dispara → `HARNESS_MAX_COST_USD`/`max_cost_usd` **inertes**. Backstop J8 (wall-clock) ainda limita tempo. `Eh≈1-3h` (fail-closed por família ou normalizar model-id). `[orq]`

**Segurança MCP (cluster — todos *latent* até `bevox-mcp` ser exposto ao piloto; ver Duvidosos):**
- **MCP-MODE-AUTONOMOUS — canal MCP executa mutação REAL sem gate draft.** `mcp/server.ts:103-110` monta `execCtx` sem `executionMode` → `mutation-tool.ts:314` faz `?? "autonomous_supervised"` → mutação MCP roda **efeito real**, pulando o gate ADR-006. `Eh≈1h`.
- **MCP-EMPTY-ORG — tenant vazio não rejeitado antes de mutação.** `server.ts:80` (`?? ""`); `bin/bevox-mcp.ts:37` (stdio não passa org). Mutações com `organization_id=""` → bypass de tenancy ADR-019/021 / records órfãos. `Eh≈2h`.
- **MCP-008 — glob largo expõe mutações de calendário.** `mcp/adapters/permission-filter.ts:29-38,54-63` — create/cancel/reschedule/waitlist **não** estão em denylist estático; `MCP_EXPOSED_SKILLS=calendar.*` os abre. Armado por MCP-MODE-AUTONOMOUS. `Eh≈1h`.
- **MCP-PERM-AUDIT-DROP (CONFIRMS PERM-02) — decisões de permissão MCP não-auditadas.** `setPermissionAuditLogger` só no boot worker (`stages.ts:305`), nunca no MCP (`mcp/bootstrap.ts:29-55`) → `emitPermissionAudit` early-return (`security/audit.ts:88-89`) → zero trilha forense para grants/denies MCP. `Eh≈1h`.

**CI (verificado read-only pela trilha DevOps + `[orq]`):**
- **CI-LINT-RED — job "Lint & Format" cronicamente vermelho.** `[orq]` `ci.yml:25` roda `format:check`; `prettier --check` falha em **12 arquivos** commitados (incl. `context-builder.ts`, `shutdown.ts` — e por linhagem `execution-handler.ts`/`mutation-tool.ts`). **Impacto:** se `required` na branch protection, bloqueia todo merge; se advisory, é teatro que faz o CI agregado ser baseline-❌, escondendo regressões reais. `Eh≈0.25h` (`npm run format`).

**Outros GA (sobreviventes):**
- **PRD-ADR017-OWNERSHIP + ADR020-LGPD-ORPHAN** — `grep BackendCustomerClient src/` = 0; repos persistem local; sem `delete` cascateável → SoT diverge do backend e erasure LGPD (art. 18) não honrável fim-a-fim. Canon _shared ADR-019/020, harness ADR-017. `Eh≈24h`.

### 🟡 MÉDIO — degrada qualidade

**Reasoning / escalation:**
- `WF-UNGATED-LATENT` (CONFIRMS C7-WF) — `wfExecuteTool` faz `resolve`+`execute` do registry inteiro sem permission/audit/proposal-hoist; JSDoc `:1534` mente "reuse permission-filtered surface" (`execution-handler.ts:1537-1547`). Latente (dead via C-03); vira CRÍTICO quando algum agent declarar `workflow:`.
- `REFLEXION-DOUBLE-WRAP` — `strategy-router.ts:79-81` já embrulha ReflexionWrapper; rule-1 (`execution-handler.ts:921-922`) re-embrulha → retries multiplicam 2ⁿ calls LLM.
- `WRAP-REFLEXION-NORERUN` — wrap-reflexion cai fora do `if` → `stepIndex++` (`:921-922` vs `:942/960`) → passo N falho nunca re-executado.
- `REFLEXION-NOTES-UNREAD` — `reflexion.ts:188-201` gera `learnedContext`; nenhum engine lê `context.reflexionNotes` (grep 0) → retry re-roda prompt idêntico. Tax puro.
- `PARSEACTION-SILENT-DEGRADE` — `react.ts:324-327` catch→`{text:content}` → JSON malformado (Gemini não hard-enforça `json_object`) degrada tool-call em "resposta final" sem marcar falha.
- `a-reasoning-05` (SYNTH-RAW-ENVELOPE-LATENT em BAIXO) — unwrap de STOP-tool regride no plan-execute/rewoo escalado.
- `C-03b` — `WorkflowResumeServer`/`Subscriber` dead code; comentário `stages.ts:561-564` "wired lazily" é falso.

**Context / tokenizer:**
- `TRUNC-DOCTRINE-DROP` (SHARPENS TRUNC-MARKERLESS) — com `CONTEXT_BUILDER_ENABLED=false` OU `contactId==null`, `sdr/compose.ts:68` põe `SDR_DOCTRINE` no tail sem marker; branch markerless de `budget-enforcer.ts:220-222` mantém só o topo → doutrina SDR silenciosamente dropada sob budget pressure.
- `TOKENIZER-UNDERCOUNT` — `tokenizer.ts:20-21` `ceil(words*1.3)` por whitespace; subconta PT acentuado/JSON.
- `BUDGET-NO-RECHECK` (BAIXO abaixo; par com CTX-04) — `budget-enforcer.ts:229-231` re-mede `finalTokens` mas nunca re-compara ao budget → prompt "compressed" excede budget com `wasCompressed:true`.

**Segurança / permissão / infra:**
- `PERM-AUDIT-FLOOD` (CONFIRMS PERM-04) — `filterPermittedTools` dispara 1 INSERT/tool (`evaluator.ts:46,101-106`; `audit.ts:36-50`) → ~15/execução sem batch → pressão no pool PG (MCP `max:4`).
- `MCP-EXT-NO-MODE-GATE (NEW)` — tools MCP externos chamam `client.callTool` direto (`mcp-tool-adapter.ts:131-170`), nunca via `mutationExecute` → bypassam o gate execution_mode. Latente (`MCP_CLIENT_ENABLED` default false).
- `MCP-STDIO-ENV-LEAK (NEW)` — subprocess stdio herda `process.env` completo (`mcp/transports/client-stdio.ts:16`) → server MCP comprometido recebe `DATABASE_URL`/`OPENAI_API_KEY`/tokens no spawn (supply-chain).
- `MCP-ERR-ECHO (CONFIRMS)` — `mcp/server.ts:115-120`→`skill-to-mcp.ts:56-78` ecoa `err.message` cru (PG/host interno) ao cliente MCP.
- `OBS-REDACT-SHALLOW (CONFIRMS PINO-REDACT-SHALLOW)` — wildcard `*` casa 1 nível (`redactors.ts:35-61`); PII aninhada + `messages.*.content` deliberadamente não-redigido, prod roda INFO. **(Duvidoso: precisa de log-site aninhado concreto p/ provar leak live — ver Duvidosos.)**
- `CALENDAR-NO-RETRY (NEW/CONFIRMS PRD-CALENDAR-RETRY-CB)` — `calendar-client.ts:34-98` = `fetch` cru (10s timeout), zero retry/backoff/circuit; única dependência externa viva do Scheduler. PRD §15.4 escopava "LLM **e** Calendar". `Eh≈4h`.
- `MIGRATE-DIVERGE (CONFIRMS)` — `scripts/migrate.mjs:31,34` vs `integration-setup.ts:23-25` splitam SQL em markers diferentes → DDL antes de `-- UP` roda em teste, pula em prod (schema drift invisível).
- `CODEQL-NOGATE (NEW)` — `codeql.yml:26` `upload:never` → SARIF nunca sobe ao security tab; scan é CI-minutes puro sem gate.
- `CI-QUEUE-WRONG (NEW)` — `ci.yml:92` seta `HARNESS_QUEUE_NAME=execution.dispatch.agent_harness` — o valor exato que o hub documenta como production-breaking (default correto `bevox.execution.dispatch`). Landmine de copy-paste.
- `SEC-AUDIT-RED (NEW, severidade CORRIGIDA)` — `security.yml:37-38` npm-audit `continue-on-error:false`; **`npm audit` fresco `[orq]` = 0 critical, 4 high, 28 moderate (32 total)** — o memo original disse "2 crit + 7 high/44" (**superestimado**, corrigido aqui). Gate Security perma-vermelho, mas sem criticals e sem confirmar se é `required` → MÉDIO (não ALTO). `Eh≈2h`.

**Eval scorers (trilha AI Engineer — todos OFFLINE, gate nada live; ver Refutações):**
- `EVAL-CONTEXT-NULL (NEW)` — hook de sampling live hard-coda `context:undefined` (`runtime/hooks/eval-sampling-hook.ts:59`) → `FaithfulnessScorer` sempre `score:null` (`faithfulness.ts:23`); `SdrAuditGateScorer` perde `system_prompt`+`contact_profile` (`sdr-audit-gate.ts:198-206`).
- `JUDGE-PROMPT-INJECTABLE (NEW)` — resposta do agente interpolada em `<agent_response>…</agent_response>` sem escape (`evals/judge-prompt.ts:36-41`) → agente jailbroken fecha a tag + "ignore above, score 1.0". O próprio agente que a toxicidade policia manipula seu score.
- `NO-PII-BR-LOCAL (SHARPENS NO-PII-SCORER-WEAK)` — `no-pii.ts:10-14,25` exige literal `55` no telefone; "(11) 98765-4321" nunca casa; CPF bare-11 removido; sem RG/CNPJ/cartão → sub-reporta PII-leak (falso sinal LGPD).

**Contrato / observabilidade / custo (sobreviventes):**
- `STATUS-NEVER-PAUSED` — `grep '"paused"' src/` = **0** `[orq]`; suspend reporta `"running"`. Backend aceita `paused` (`schema.ts:16`). Cadência suspensa (3–14d) indistinguível de execução ativa.
- `TRACES-DEAD` — `traces[]` populado mas `sendTrace` tem **0 callers** `[orq]`; backend `/traces` pronto e nunca chamado.
- `OBS-DELTA-01` — `usage` real só num site; `{0,0}` em Model-C `:516`, workflow, abort, request-human. Telemetria de custo zerada no tráfego do piloto.

### 🟢 BAIXO — higiene

- `C-06`-downstream `SYNTH-RAW-ENVELOPE-LATENT` — fix raw-envelope landou só em `react.synthesize`; `plan-execute.ts:352`/`rewoo.ts:260` ainda retornam envelope `JSON.stringify` p/ STOP tools (latente até a-reasoning-02 ser corrigido).
- `REWOO-EXECUTEWAVES-DEAD` (CONFIRMS a-reasoning-01/03) — `rewoo.ts:280` waves paralelas nunca chamadas; `ESCALATE-TO-REWOO` inalcançável do ReAct default (single-step plan).
- `OBS-USAGE-DEAD` (CONFIRMS OBS-DELTA-02) — `UsageTracker` + tabela `execution_usage` (003) dead code (grep 0 instâncias).
- `OBS-DLQ-NOOTEL` — `dead-letter-metrics.ts:45-76` só counters process-local + Pino lvl-50; nenhum OTel counter mesmo com `OTEL_ENABLED` → reset por restart, sem agregado nas 2 réplicas.
- `OBS-REDACT-DEAD-EGRESS` — `redactors.ts:59-60` lista paths `callback.payload.*` que nenhum log-site preenche (`bevox-callback.ts` loga só `{executionId}`) → paper-control inerte.
- `ADVISORY-LOCK-CROSS-TENANT` (CONFIRMS) — `pg_advisory_xact_lock($1)` com `[contactId]` (`memory-extractor.agent.ts:173`; `memory-condenser.agent.ts:186`); `contact_id` é BIGINT por-org → org A e B com `contact_id=42` serializam no mesmo lock (contenção cross-tenant, sem leak).
- `NO-LLM-KEY-BOOTS (NEW)` — `warmup-pipeline` só `console.warn` sem credencial (`stages.ts:289-294`); todas `*_API_KEY` `.optional()` → boota green e consome jobs sem LLM creds → 100% falha pós-go-live.
- `CUSTOM-JUDGE-DEAD (NEW)` — `scorer-factory.ts:54-56` pula nomes custom ("handled separately") sem handling; capacidade documentada inexistente.
- `SAMPLING-TAGGED-DEAD (NEW)` — `sampler.ts:45-51` lê `input.payload.tags` inexistente no schema Zod → `EVALS_SAMPLING_POLICY={"type":"tagged"}` amostra nada.
- `AUDIT-GATE-SQL-FALSEPOS (NEW)` — `sdr-audit-gate.ts:72` `/\bSQL\b/` trata qualquer "SQL" como claim de qualificação → over-claim espúrio em prosa técnica.
- `MCP-NO-SSRF-ALLOWLIST (NEW)` — `mcp/client-config.schema.ts:29-31` só `z.string().url()`, sem allowlist scheme/host → `mcp.config.json` adulterado aponta a `169.254.169.254`/backend interno. Cap BAIXO: fonte é arquivo deploy-time.
- `MCP-UNBOUNDED-RESP (NEW)` — respostas MCP externas com time-bound mas sem size-bound (`mcp-tool-adapter.ts:61-71`) → payload multi-GB.
- `MCP-PARAMS-LOOSE (SHARPENS MCP-PARAMS-NOREVALIDATE)` — `json-schema-to-zod.ts:42-49` dropa `maxLength`/`pattern`; confia na self-validation da skill.
- `DC-PGVECTOR (CONFIRMS)` — `docker-compose.yml:3`/`ci.yml:44` sem pgvector; `migrate.mjs` aborta na 006. Invisível ao CI (testcontainer usa `pgvector/pgvector:pg16`).
- `ACCOUNT-LEXICON (SHARPENS "0 account_id")` — léxico `account` sobrevive como tipo `AccountConfig`/`accountConfig` (`execution-context.ts:82`, `react.ts:80`…) — **é config de modelo, não `account_id`/tenant** → não é bug de tenancy, mas contradiz o statement "src/ = 0 account". `src/` de produção segue **0 `account_id`/`workspace_id` materiais** `[orq]`.
- `MARCO1-SELF-STALE` — PRD §11.1 (`:614`) "7 migrations" vs **14 arquivos** no disco; §11.1 invariante `:627` "filtrado por `account_id`" stale (código é `organizationId`); §16.1 `[x]` "streaming/token-accounting real" superestima (dead code / `{0,0}`).
- `DOC-DRIFT (NEW)` — (a) CLAUDE.md "Dockerfile single-stage" **falso** (`Dockerfile:1 AS builder` + `:10 AS runner`) `[orq]`; (b) workaround manual "accounts-FK trap" em CLAUDE.md §Infra + hub `:96` **OBSOLETO** — `000`/`012` automatizam e o passo manual agora **conflita**.
- `PRD-§16.4-ADRS-FALTAM` — `30_adr/bevox-harness/` só tem 016-019; PRD §16.4 (`:764-773`) manda 4 outros (Skills-substituem-ToolRegistry, Workflow-vence-reasoning, MCP-canal-lateral, Idempotência-de-mutação). ADR-012 (resume boundary) LOCAL, não-promovido.
- `MIG-DUP013` **non-hazard confirmado `[orq]`** — dois `013_*.sql` ambos `ALTER TABLE permission_audit` mas **colunas disjuntas** (decision/layer/action_type/result vs execution_id→TEXT); `migrate.mjs` chaveia por filename completo + `readdirSync().sort()` → ordem lex determinística. Non-hazard para correção; smell de naming.

---

## Cobertura por categoria do prompt (a–k)

| Cat | Tema | Veredito desta rodada |
|---|---|---|
| **a** | PRD vs implementado | **Gaps vivos:** ADR-017/ADR-020 ownership+LGPD não implementados; §16.1/§16.2 marco: `[x]` streaming/token-accounting/rate-limit-by-model **superestimados** (dead code); `[ ]` teste-de-contrato-e2e, OpenAPI-atualizado, idempotência-mutação (parcial), retry-CB-Calendar (parcial), draft-mode (implementado-mas-quebrado por C-02). 5 reasoning engines presentes; ReWOO waves + Reflexion notes dead. |
| **b** | execution_mode (ADR-018) | **Parseado e propagado** (EM-03 LIVE); `mutationExecute` roteia por `execution_mode`. **Buraco:** MCP entry não seta `executionMode` (MCP-MODE-AUTONOMOUS) → default autonomous. C-02 quebra o retorno dos modos draft. |
| **c** | Léxico `account_id`/`workspace_id` | **`src/` produção = 0 materiais** `[orq]`. Hits só em migrations 001-011 (histórico, retirado pela 011 — esperado) + fixtures + `rag/cli --account`. `resolveOrganizationId` colapsada — confirmado (0 hits). `ACCOUNT-LEXICON`: `AccountConfig` (model config) sobrevive — não é tenant. |
| **d** | Testes faltando | Cobertura **fresca** unit-only: **68.79% stmt / 62.55% br / 68.59% fn / 69.61% lines** (1208 testes ✓). Buracos: `mcp/*`, `evals/*` scorers, `resume-server`/`subscriber`, `scheduler.agent`, `condense-worker`, `reasoning` escalation. PRD-CONTRACT-E2E ausente é o gap #1 (pegaria C-01/02/07/CB-NEW-03). |
| **e** | Dívida conhecida | `grep TODO\|FIXME\|HACK\|XXX\|@deprecated src/` = **6** (benignos: `harness.ts` deprecated stubs, `TODO C13` usage, abort TODO). Dead code é a dívida real (ReWOO/Reflexion/resume-server/UsageTracker). |
| **f** | Migrations accounts(id) FK | **FECHADO** `[orq]` — `000_accounts_stub` + `011` (DROP+CREATE 12 tabelas → org UUID) + `012_drop_accounts_stub` (PR #25). **A categoria do prompt e o workaround do CLAUDE.md estão OBSOLETOS** (agora conflitam). Nada a fechar; **remover o passo manual da doc**. |
| **g** | MCP server (dev/evals) | **Funcional mas fail-closed** (glob vazio = nada exposto). Cluster de segurança se exposto (MODE-AUTONOMOUS/EMPTY-ORG/008/PERM-AUDIT-DROP + SSRF/env-leak outbound). PRD §5.13/§10.3, **não §212** (fantasma). |
| **h** | Callbacks (X-Execution-Token) | **4 endpoints reais** `[orq]`: `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`. **`/artifact`,`/tool-result`,`/turn` do prompt NÃO EXISTEM.** Paridade quebrada por C-01 (verbo), C-02/C-07/CB-NEW-03 (schema). `/stream`+`/traces` prontos no backend mas callerless no harness. |
| **i** | Bootstrap stages | ~15-17 stages (não "7"). `calendar-health` GET `/health` **aceita 404** `[orq]` (só network/timeout aborta — como o CLAUDE.md prescreve). `warmup-pipeline` só warn sem LLM key (NO-LLM-KEY-BOOTS). `dev/ws-server` nega boot sob prod. |
| **j** | Alçapões p/ piloto | **MANIFEST-DB-ENV (boot crash) + NO-MIGRATOR (sem schema) = o deploy atual não sobe.** Depois: C-01 (todo job genérico falha), C-07 (400 pós-fix-C-01), MANIFEST secrets no stdio-env. |
| **k** | Delta vs audit anterior | Ver §Delta. **0 CRÍT/ALTO fechados** (0 commits); **+1 CRÍTICO NOVO** (MANIFEST-DB-ENV) + cluster infra-deploy + surfaces sub-auditadas. |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. **Os 3 primeiros são o "pacote de deploy" que precede qualquer outro fix — sem eles o harness não sobe nem processa.**

1. **MANIFEST-DB-ENV — corrigir env do manifest OU fallback `DATABASE_URL ?? BEVOX_DB_URL`** (`0.5h`). Sem isso as réplicas crash-loopam. Fix mais barato é harness-side (1 linha no `env.ts`), fecha o deploy sem tocar o hub.
2. **C-01 + C-07 juntos — `/status` por PATCH **E** clamp de `sentiment`** (`~2h`). C-01 isolado é o maior ROI de runtime mas expõe C-07. Mesmo PR: `patch()` dedicado + `zod.safeParse`+clamp do sentiment. **Nunca mergear C-01 sozinho.** Fix do `/status` já em `finding-j10-running-status` (Grupo C).
3. **NO-MIGRATOR — copiar `scripts/` no runner OU job de migração no deploy** (`~1.5h`). Sem schema, nenhum insert funciona. Confirmar antes se o runbook do hub já roda migrate out-of-band.
4. **CI-LINT-RED — `npm run format`** (`0.25h`). Destrava o gate CI (baseline verde) para que regressões reais fiquem visíveis. Hot-path files.
5. **AUD-PROPOSAL-CHECK — remapear o CHECK da 013** (`~1h`). GA-blocker de trilha de auditoria de proposta; `result='proposed'`/`action_type='proposal'` ao CHECK (ou o audit usar valores válidos).
6. **C-02 + IDEM-05 — `idempotency_key` no proposal** (`~2-3h`). `executeOrPropose` anexa `deriveIdempotencyKey(context, params)`. **Atualizar `em-03-proposals-end-to-end.test.ts:276`**. Desbloqueia modos draft.
7. **OBS-J9 (SNAPSHOT+CLAUDE) — reativar o teto de custo** (`~1-3h`). Normalizar model-id ou fail-closed por família + adicionar rows `claude-*`. Fecha o bound anti-runaway.
8. **C-05 — error boundary no Model-C** (`~3-5h`). Espelhar `:2087-2191`: `/complete(failed)` + limpeza de dedup em erro transiente. Para a perda silenciosa de execução.
9. **PRD-CONTRACT-E2E-TEST — teste de contrato contra os schemas Zod do backend** (`~8h`). Pega C-01/02/07 + CB-NEW-03 + AUD-PROPOSAL na fonte. Substitui o `smoke 01` não-funcional. **Pré-requisito de confiança de 1–8.**
10. **Integrar Grupo C (6 branches `op-*`/`finding-*`, ~860 linhas, mergeáveis)** (`~1-2 pessoa-dia de review`). Remedia reasoning-quality (a-reasoning-01/02/03, STEPEVAL-THRASH família), tokenizer/budget (TRUNC/TOKENIZER/BUDGET-NO-RECHECK), STATUS-NEVER-PAUSED+`/status`, openapi-sync. **Maior valor/esforço do backlog — trabalho pronto, falta review.**

> **Pacotes:** **1–4 ≈ "faz o deploy subir e o CI ver"** (~4.25h, dos quais 1+3 tocam infra/hub). **1–9 ≈ pacote mínimo de piloto** (~20-25h + 1 PR backend). **+ ADR-017/020 + Calendar-CB + LLM-failover + MCP-hardening ≈ pacote de GA.**

---

## Dependências cruzadas

- **hub-infra (`bevox-PRD-consolidation/infra/`)** → **MANIFEST-DB-ENV** (renomear var + adicionar `CALENDAR_SERVICE_URL` no manifest pinado, OU aceitar o fallback harness-side), **NO-MIGRATOR** (job de migração no deploy), **CI-QUEUE-WRONG**, **DC-PGVECTOR**, **DOC-DRIFT(b)**. **P0 operacional — o pacote de deploy não sobe sem (1).**
- **bevox-backend** → **C-01/CB-NEW-03** (verbo PATCH + enum abort; `routes.ts:56`/`schema.ts:57-65`), **C-02/AUD-PROPOSAL** (`idempotency_key` já exigido em `schema.ts:40`), **C-07** (enum sentiment estrito), **PRD-COST-NOT-PROPAGATED** (estender `usage` com `cost_usd`), **TRACES-DEAD/STATUS-PAUSED** (`/traces` e `paused` prontos, harness não usa). Contrato frozen `dbd231e` — fixes unilaterais-harness (conformar).
- **canon (bevox-knowledge / hub `bevox-PRD-consolidation`)** → **C-03/RESUME** (promover ADR-012 ao canon; confirmar quem semeia `workflow_correlation`), **PRD-§16.4-ADRs** (criar os 4 ADRs), **ADR-CITE-MAP** (execution_mode = harness ADR-018, não _shared 006), **MARCO1-SELF-STALE** (PRD §11.1 "7 migrations" / invariante account_id).
- **deploy platform (Hetzner)** → residual de **MANIFEST-DB-ENV** e **NO-MIGRATOR**: se a plataforma injeta `DATABASE_URL`/roda migrate fora do manifest, severidade cai (ver Duvidosos).
- **HARNESS_QUEUE_NAME em prod** (memória `backend-dispatch-retry-contract`) — manifest pina `bevox.execution.dispatch` (`:151`), correto; **mas o CI seta o valor errado** (CI-QUEUE-WRONG). Confirmar que o manifest é o SoT.

---

## Delta vs audit anterior

**Linhagem de tally:** 06-02 `13·20·46·34` → 06-04 `6·17·23·22` → 06-23 `7·~20·~27·~30` → 07-04 `~7·~18·~29·~19` → **07-05 `~8·~15·~27·~22`** (CRÍT +1 = MANIFEST-DB-ENV; ALTO/MÉD re-balanceados com surfaces novas; C-06 movido p/ CRÍT-condicional, C-02/03/04/05 idem).

### FECHADOS desde 07-04
**Nenhum CRÍTICO/ALTO de produto fechou** — `git log 26fbd42..HEAD` = vazio (0 commits em 1 dia; nem teste). Código, canon e contrato do backend congelados idênticos. **Verdito de piloto/GA inalterado e pré-determinado.**

### NOVOS (não em 5 audits anteriores)
- **CRÍTICO:** **`MANIFEST-DB-ENV`** — o achado de maior valor do round; o alçapão de deploy que 5 auditorias (com hub infra fora de escopo) não pegaram. `[orq]` nos dois lados.
- **ALTO:** `NO-MIGRATOR`, `OBS-LLM-METRICS`, `OBS-J9-SNAPSHOT`, `OBS-J9-CLAUDE`, `CI-LINT-RED`.
- **MÉDIO:** `MCP-EXT-NO-MODE-GATE`, `MCP-STDIO-ENV-LEAK`, `CALENDAR-NO-RETRY`, `EVAL-CONTEXT-NULL`, `JUDGE-PROMPT-INJECTABLE`, `CODEQL-NOGATE`, `CI-QUEUE-WRONG`, `SEC-AUDIT-RED` (severidade corrigida).
- **BAIXO:** `NO-LLM-KEY-BOOTS`, `CUSTOM-JUDGE-DEAD`, `SAMPLING-TAGGED-DEAD`, `AUDIT-GATE-SQL-FALSEPOS`, `MCP-NO-SSRF-ALLOWLIST`, `MCP-UNBOUNDED-RESP`, `ACCOUNT-LEXICON`, `DOC-DRIFT`.

### CORREÇÕES a findings/afirmações anteriores (valor analítico)
- **`SEC-AUDIT-RED` superestimado pelo agente → CORRIGIDO** `[orq]`: memo disse "2 critical + 7 high (44 total)"; `npm audit` fresco = **0 critical, 4 high, 28 moderate, 32 total**. Finding (gate perma-red) sobrevive; **rebaixado ALTO→MÉDIO**. (Exatamente o padrão de over-statement que a memória deste repo alerta — cross-check confirmou.)
- **`C-01`/`C-07` re-inseridos pelo orquestrador:** a síntese (construída só das 7 trilhas) **não tinha C-01 nem C-07-como-tal** (nenhuma trilha era dedicada a callbacks; o orquestrador os verificou). São os CRÍTICO de maior alcance (caminho genérico) — re-inseridos aqui.
- **Todos os cites do 07-04 re-verificados com drift 0** (código frozen): C-01 `:27-28`, C-04 `:230-247`, C-06 `:562-566`, C-07 `:73`, J9 `:17-26`, AUTHZ `:88`, LLM-gateway `:137-175` — todos exatos.
- **Coverage medida fresca** (07-04 reusou o número stale 06-23): 68.79% stmt / 62.55% br unit-only — estável.
- **Reafirmado do 07-04:** accounts-FK FECHADO; MCP-MODE latente (não CRÍT, canal-lateral fail-closed); prompt-mãe factualmente errado (endpoints + §212 + categoria f).

### SOBREVIVEM (re-verificados, código congelado)
Os **7 CRÍTICO** e **~18 ALTO** do 07-04, integralmente. O cluster de segurança MCP e o backlog de branches (Grupo C mergeável) inalterados.

---

## Refutações / não-gaps (verificados — NÃO reportar/re-investigar) `[orq]` parcial

- **accounts-FK trap → RESOLVIDO** (`000`+`011`+`012`, PR #25). Categoria (f) do prompt e workaround do CLAUDE.md **OBSOLETOS**.
- **calendar-health NÃO aborta em 404** — só `.catch()` de network/timeout throw (como o CLAUDE.md prescreve).
- **Tenant-isolation sólido** — `eval_results`, memory repos, rate-limiter todos filtram `organization_id` bound-param; rate-limiter keyed `${org}:${tool}`. Session/dedup/Idempotency-Key omitem org mas são keyed em UUIDv7 globalmente-único (não leak).
- **MCP inbound seguro no essencial** — SSE não desabilita TLS (sem `rejectUnauthorized:false`); sem shell-injection (spawn `command`+`args[]`); SSE auth = length-check + XOR constant-time, token min-32; env interpolation fail-closed; MCP client default-OFF.
- **spans.ts/tracer.ts limpos** — span sempre encerra em `finally` + records exception; `initTracer` não bloqueia boot; sem PII em span-attrs. **error-classifier correto** — abort nunca vira dead_letter (`!aborted` guard); poison+exhausted → dead_letter; transients → recordTransientFailure.
- **Evals OFFLINE-only, gate nada live** — default policy `{"type":"never"}`; judge cost bounded (`maxTokens:500`+`temp:0`+`timeout(30s)`).
- **Model-C aplica permission-filter + proposal-hoist** (`:376-390`,`:402,419-428`) — "Model-C bypassa permissões" não se sustenta (mas herda C-02 + C-05).
- **MIG-DUP013 / migrate.mjs fallback / whole-file DOWN** — sem hazard (PK+sort, colunas disjuntas).
- **AnthropicAdapter presente à frente do canon** (Claude "pós-V1") — código adiante da regra, inverso de gap (mas dispara OBS-J9-CLAUDE).

---

## Duvidosos p/ revisão do humano (calibrar antes de tratar como P0)

- **MANIFEST-DB-ENV (CRÍTICO)** — repousa em manifest+env serem autoritativos. O memo não achou mapeamento da plataforma Hetzner que injete `DATABASE_URL` fora do manifest. Se injeta, deixa de ser crash-loop → rebaixar. **Confirmar com o runbook/plataforma do hub antes de tratar como P0** — mas o modelo de secret é por-chave (dry-run Gap C), então a probabilidade de injeção externa é baixa. **Recomendo o fix harness-side (fallback) de qualquer forma — é defensivo e 0.5h.**
- **NO-MIGRATOR (ALTO)** — assume que nada out-of-band roda `migrate.mjs`. Cross-check com o runbook do hub / job de init do Postgres-harness.
- **C-02/C-03/C-04/C-05/C-06 severidade** — CRÍTICO **se** o piloto usa modos draft (copilot/manual_assisted) ou a esteira SDR está em escopo; senão ALTO. **O orquestrador NÃO conseguiu confirmar o escopo do piloto** lendo os repos. Confirmar com o dono do produto.
- **SEC-AUDIT-RED / CI-LINT-RED (severidade)** — impacto real (bloqueia merge vs teatro ignorado) depende de qual check é `required` na branch protection do GitHub — não visível nos arquivos.
- **OBS-REDACT-SHALLOW (MÉDIO)** — a limitação de wildcard-depth é certa, mas um leak LGPD *live* precisa de um `logger.*` com objeto `context`/`profile` aninhado concreto que a trilha não enumerou exaustivamente. Pode ser vácuo como OBS-REDACT-DEAD-EGRESS.
- **MCP cluster (todos)** — *latent* até `bevox-mcp` ser exposto; o CLAUDE.md descreve réplicas **worker-only sem porta HTTP**. Se o bin stdio/sse NÃO está no topology do piloto, rebaixar de ALTO a latente. **Confirmar se algum operador roda o bin.**

---

## Notas de método

**Orquestração.** Workflow multi-agente de 1 rodada, **7 trilhas de investigação texto-markdown SEM schema** (lição de memória deste repo: `agentType`+`schema` perde a trilha `StructuredOutput` — desta vez **0/8 perdidos**), com **agentes especialistas locais** (`Security Engineer` ×2, `SRE`, `AI Engineer` ×2, `DevOps Automator`, `Backend Architect`) → **1 síntese consolidadora** (`Code Reviewer`). Cada trilha recebeu um *preamble* de ground-truth (freeze dos 4 repos, paths cross-repo, mapa de ADR corrigido, endpoints reais byte-verificados, os 7 CRÍTICO com cites frescos) e o mandato de **cobrir a superfície sub-auditada** + re-verificar com cite fresco. **~578K tokens, 8 subagentes (Opus 4.8, effort high), ~10min.**

**Cross-check independente do orquestrador (`[orq]`).** Antes e durante a síntese, o orquestrador validou **lendo código nos 3 repos**: os **7 CRÍTICO** (`bevox-callback.ts`, `mutation-tool.ts`, `execution-handler.ts:485-585/1400-1440`, `state-store.ts:230-247`, `evaluator.ts` inteiro, `scheduler.agent.ts`, `message-analyzer.agent.ts:73`); o **NOVO CRÍTICO** (`env.ts:8-12,203-207` + `bevox-prod-manifest.yaml:143-162` + `harness-config.ts:6` + Dockerfile); o **contrato Zod do backend inteiro** (`harness-callbacks.schema.ts` — 4 rotas, enums); as **migrations** (`000`/`011`/`012` chain + dois `013` colunas-disjuntas); a **coverage fresca** (`vitest --coverage` unit); e **correção da superestimativa** `SEC-AUDIT-RED` (`npm audit` read-only). Grep de léxico exaustivo. `git`/freshness confirmou estase de 4 repos.

**Reconciliação / correção de superestimativas** (memória: agentes over/understate severidade). **Corrigido:** SEC-AUDIT-RED (numbers 44→32, 2crit→0crit). **Rebaixado:** C-06 (síntese pôs MÉDIO; mantido CRÍT-condicional por LGPD). **Re-inserido:** C-01/C-07 (ausentes da síntese por falta de trilha de callbacks). **Confirmado non-hazard:** MIG-DUP013, calendar-health-404, MCP-inbound-TLS/auth.

**Confiança.** Alta nos achados com `arquivo:linha` de código não-teste (código congelado + cross-check direto). A cobertura numérica FOI re-rodada fresh (unit-only). O cluster MCP é *latent* (default fail-closed) — severidade ALTO condicionada à exposição do bin. O residual de MANIFEST-DB-ENV/NO-MIGRATOR (injeção de env/migrate pela plataforma) é o único ponto que poderia rebaixar o CRÍTICO novo — sinalizado em Duvidosos.

**Meta-nota ao revisor humano (repetida do 07-04, AINDA válida — recomendo atualizar o template de prompt):** o **prompt-mãe desta auditoria está desatualizado** em pelo menos 3 pontos verificados byte-a-byte: (1) afirma "4 endpoints (`/complete`, `/artifact`, `/tool-result`, `/turn`)" — os reais são `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`; `/artifact`/`/tool-result`/`/turn` **não existem**; (2) cita "PRD §212" — o PRD termina no §17 (MCP é §5.13/§10.3); (3) a categoria (f) trata o gap `accounts` FK como aberto — **fechado desde PR #25** (`000`+`012`), e o workaround do CLAUDE.md agora **conflita** com as migrations automáticas. **Antes da próxima rodada: atualizar o prompt e a seção "Infraestrutura em produção" do CLAUDE.md (accounts-FK + Dockerfile single-stage).**
