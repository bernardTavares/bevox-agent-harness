# Gap Analysis — bevox-harness — 2026-07-18

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-07-17.md` (linhagem: `07-17`/`07-16`/`07-15`/`07-14`/`07-08`/`07-07`/`07-05`/`07-04`/`06-23`/`06-04`/`06-02` — esta é a **12ª rodada**).
> **HEAD auditado:** `32c31a4` (branch `test/execution-handler-coverage-uplift`) — que **é o próprio commit do doc 07-17**. `git log ff2f61d..HEAD` = só o doc `32c31a4`. **Zero commits de produto desde 07-17** (e desde `2979eb0` `origin/main`, 2026-06-03).
> **Freeze re-verificado FRESCO nos 3 repos em disco nesta sessão (evidência de leitura própria, não citada de memória nem do 07-17):**
> 1. **harness** — `git diff origin/main..HEAD -- src/` = **0 linhas** (produto byte-idêntico a `origin/main` @ `2979eb0`, ~45 dias). `git status` = só `docs/` + `.claude/worktrees/` untracked. **Suíte verde:** `vitest run` = **173 files / 1236 tests passed**, 17/57 skipped, **0 falhas**, exit 0 (as linhas `level:50` no output são fixtures de caminho-negativo — falhas sintéticas propositais — não erros reais).
> 2. **backend** `bevox-backend` @ `105fb50` (2026-07-07) — contrato relido FRESCO campo-a-campo (`harness-callbacks.routes.ts`, `harness-callbacks.schema.ts`, `harness-dispatch.schema.ts`).
> 3. **hub** `bevox-PRD-consolidation` — manifest `infra/bevox-prod-manifest.yaml` @ `fd1373b` relido linha-a-linha (bloco `bevox-harness` `:132-162`).
> 4. **canon** `bevox-knowledge` — PRD `10_prd/bevox-harness/2026-05-15-...-v1.md` (v1.1) + ADRs `_shared`/`bevox-harness` relidos.
>
> **Método (deliberadamente enxuto — ver §"Notas de método"):** dado o freeze de ~45 dias re-confirmado, **NÃO** re-executei o fan-out multi-agente de 458K tokens do 07-17 — isso reproduziria um backlog byte-idêntico e seria a exata inércia que o prompt-mãe proíbe ("não invocar [agents] por inércia"). O valor desta rodada é **verificação independente de primeira-mão** do cluster acionável nos 3 repos (cada `arquivo:linha` lido NESTA sessão, marcado `[orq✓ 18]`) + a **escalada do meta-achado de processo**.
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

**Nada de produto mudou em ~45 dias e em nenhum dos 3 repos do contrato; o veredito é pré-determinado e esta 12ª rodada não o altera — PILOTO: NÃO-GO · GA: NÃO-GO.** Os 3 blockers de deploy **incondicionais** (`MANIFEST-DB-ENV`, `NO-MIGRATOR`, `C-01`) foram **re-lidos e hand-verificados FRESCO dos DOIS lados** (harness + hub/backend) nesta sessão e **sobrevivem sem branch de remediação** — precisam ser **ESCRITOS**, não re-auditados. Todo o cluster CRÍTICO/ALTO/MÉDIO/BAIXO do 07-17 (`~8·~21·~42·~36`) sobrevive por construção (código congelado). **0 CRÍTICO/ALTO fechados** (0 commits de produto).

**O achado dominante — reiterado pela 3ª rodada consecutiva — é de PROCESSO, não de código.** A 12ª auditoria sobre código byte-idêntico confirma que a cadência autônoma diária virou toil de valor marginal ≈ 0. O 07-16 e o 07-17 já elevaram "pausar a cadência" a recomendação #0; **eu concordo e a mantenho como recomendação #0**, agora com prova fresca de 3 repos. A ação de valor **não** é uma 13ª auditoria — é o **primeiro commit de produto desde 2026-06-03**, começando pelos 3 fixes de deploy (~3h harness-side).

**Delta de código vs 07-17: ZERO.** Nenhum CRÍTICO/ALTO/MÉD/BAIXO aberto ou fechado; nenhum arquivo de produto tocado. As únicas variações mensuráveis são time-sensitive e imateriais: `prettier --check` ≈ **12** arquivos dirty (07-17: 11 — ruído de contagem/doc, tree de produto congelado); `npm audit` runtime = **32** (28 moderate, 4 high, 0 crit) — **idêntico** (lockfile congelado); `TODO/FIXME/HACK/XXX/@deprecated` em `src/` = **6** (idêntico); `find tests -name '*.test.ts'` = **190** (idêntico); refs `fix/`/`op-` = **41** (idêntico). Não re-derivo os NOVOS do 07-17 (`NEW-COST-01`, `NEW-CTX-01`, `MCP-MUTATION-UNGATED`, `USAGE-TABLE-DEAD`, `WF-*`, etc.) — sobrevivem inalterados e estão catalogados lá em detalhe.

**Correções duráveis re-confirmadas (o prompt-mãe E o CLAUDE.md continuam desatualizados):** (1) a categoria **(f)** do prompt trata a FK `accounts(id)` como aberta — **FECHADA** (`000_accounts_stub.sql`+`012_drop_accounts_stub.sql` em disco); (2) a categoria **(h)** cita 4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn` — os 3 últimos **não existem**; os reais são `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`; (3) **"PRD §212"** é fantasma (o PRD termina no §17; o gate do piloto é §16.1); (4) "cobertura Vitest é mínima" (CLAUDE.md) é **super-dimensionado** — a suíte tem **1236 testes passando** e a hot-path é 97-100% coberta.

---

## Achados por severidade

> Convenção: `arquivo:linha` no HEAD `32c31a4`. `[orq✓ 18]` = **lido e hand-verificado por mim NESTA sessão (2026-07-18)**, nos 3 repos em disco — não citado de memória nem do 07-17. `SOBREVIVE` = re-aberto e confirmado por freeze de código. `Eh` = esforço estimado. Para o detalhe exaustivo de cada item herdado, ver `runtime-gap-audit-2026-07-17.md` §"Achados por severidade" (não re-derivado aqui por disciplina anti-toil; o freeze garante paridade 1:1).

### 🔴 CRÍTICO — bloqueia o piloto

> Nenhum tem branch de remediação em voo. Os 3 incondicionais foram **re-lidos linha-a-linha dos dois lados nesta sessão**.

#### Incondicionais (bloqueiam o piloto em QUALQUER escopo)

- **MANIFEST-DB-ENV (SOBREVIVE, `[orq✓ 18]` harness + hub) — o pacote de deploy pinado crash-loopa no boot.**
  Harness (`src/config/env.ts`, relido): `:8 DATABASE_URL: z.string().url()` **(required)**, `:11 BEVOX_DB_URL: z.string().url().optional()` **(opcional; grep confirma que `src/` nunca a lê)**, `:12 CALENDAR_SERVICE_URL: z.string().url()` **(required)**.
  Hub (`infra/bevox-prod-manifest.yaml` @ `fd1373b`, relido): o bloco `bevox-harness` (`:132`) supre `BEVOX_DB_URL`(`:155`) + `REDIS_URL`(`:156`) + `BEVOX_CALLBACK_BASE_URL`(`:157`), mas **OMITE `DATABASE_URL` E `CALENDAR_SERVICE_URL`** (o `DATABASE_URL:` em `:105` está no bloco **backend**, não harness).
  → `getEnv()` `safeParse` falha em 2 required → `process.exit(1)` **antes do stage 1** → 2 réplicas em crash-loop. **Fix harness-side ~1 linha:** `DATABASE_URL: z.string().url().optional()` com fallback `?? BEVOX_DB_URL`, + suprir/relaxar `CALENDAR_SERVICE_URL` (o stage `calendar-health` já aceita 404). `Eh≈0.5h`. **Sem branch.**
- **NO-MIGRATOR (SOBREVIVE, `[orq✓ 18]`) — o schema do harness nunca é criado no deploy pinado.**
  `Dockerfile` (relido, **2-stage**): `builder`(`:1`) copia `scripts`(`:7`) e roda `npm run build`; `runner`(`:10`) copia **só** `COPY --from=builder /app/dist ./dist`(`:16`) → `migrations/` E `scripts/migrate.mjs` estão **fisicamente ausentes** da imagem de prod (`CMD ["node","dist/index.js"]` `:18`; nem `docker exec` migraria). O manifest não tem sidecar de migração para o harness (o migrator citado em `:8-9` é do **backend** — "não entra neste manifest"). **CLAUDE.md §Infra diz "Dockerfile single-stage (sem split runtime/migrator)" — FALSO** (é 2-stage; essa misdescrição é a raiz do bug). **Fix:** copiar `scripts/`+`migrations/`+deps no runner OU job de migração no deploy. `Eh≈1.5h`. **Sem branch.**
- **C-01 (SOBREVIVE, `[orq✓ 18]` harness + backend) — `updateStatus` por POST contra rota PATCH-only → 404 mata TODA execução do caminho genérico.**
  Harness `bevox-callback.ts`: helper `post()`(`:15`) crava `method:"POST"`(`:28`); `updateStatus`(`:133`) chama `post('/api/v1/executions/${id}/status', ...)`(`:141`).
  Backend em disco confirma FRESCO: `harness-callbacks.routes.ts:56 app.patch("/api/v1/executions/:id/status")` (docstring `:5-8` lista os 4 endpoints reais). O próprio `openapi/agent-harness-v1.yaml` declara `/status` como `patch:` — **auto-contraditório no próprio repo**.
  `await updateStatus(...,"running")` é o 1º `await` do try genérico → 404 → error-boundary → desfecho `done` silencioso (via `STRATEGY-FAILED-AS-DONE`). `Eh≈1h` (co-fixar com C-07).
  - **STATUS-02 (SOBREVIVE, `[orq✓ 18]`)** — o mesmo POST-vs-PATCH mata o `dead_letter` autoritativo. Backend `status` enum inclui `dead_letter` (`harness-callbacks.schema.ts:16`, relido) → `updateStatus(...,"dead_letter")` 404a → UI de replay nunca acende. Fechado ao corrigir o C-01.
- **C-07 (SOBREVIVE, `[orq✓ 18]` backend) — `sentiment` da pipeline não-validado → `/complete` 400 em output malformado (co-fix obrigatório do C-01).**
  Enum backend relido: `harness-callbacks.schema.ts:51` = `["positive","neutral","negative","frustrated","angry","confused"]`; campo obrigatório é `response_text`(`:50`). `message-analyzer.agent.ts:73` faz `JSON.parse(...) as ClassificationOutput` (cast cru) — os 6 padrão não 400am, só valor fora-dos-6. Mascarado hoje pelo C-01. Fix: `safeParse`+clamp. `Eh≈1-2h`.

#### Condicionais ao escopo do piloto (CRÍTICO **se** o piloto inclui modos draft e/ou cadência SDR; senão ALTO)

> **Ação ao revisor: confirmar se o piloto usa `manual_assisted`/`copilot` (aciona C-02/AUD-PROPOSAL) ou a esteira SDR/Model-C (aciona C-03..C-06).**

- **C-02 (SOBREVIVE, `[orq✓ 18]` backend) — `proposals[]` sem `idempotency_key` → `/complete` 400 nos modos draft.** `ProposalSchema.idempotency_key: z.string().min(1)` (`schema.ts:40`, required); o `extractProposal` do harness hoista `{action, params}` sem a key. `Eh≈0.5h`.
- **C-03 (SOBREVIVE) — esteira SDR/cadência/Model-C/resume morta na fiação viva.** `scheduler.agent.ts` não declara `workflow:` → porta START inalcançável; `resume-server.ts`/`subscriber.ts` dead-code (`WORKFLOW_RESUME_ENABLED` default-off). `Eh≈6-8h`.
- **C-04 (SOBREVIVE) — timeout de não-resposta marca cadência `failed` em vez de avançar.** `state-store.ts` (`claimForExpiry`→`SET status='failed'`). Cobertura real 0%. `Eh≈4-6h`.
- **C-05 (SOBREVIVE) — Model-C sem error boundary + dedup key retida → execução permanentemente perdida.** `dispatchModelC` roda ANTES do único try; o único `del(dedupKey)` vive no catch nunca-entrado → re-entrega bate no `SET NX` → return silencioso. Fix parcial em `main` não cria o boundary. `Eh≈3-5h`.
- **C-06 (SOBREVIVE) — respostas vivas nunca qualificam lead nem honram opt-out (risco LGPD).** `execution-handler.ts:556-565` crava `observedSignals:{}`. A substância do fix vive UNMERGED em `origin/fix/sdr-ultrareview-findings`. `Eh≈8h`.

### 🟠 ALTO — bloqueia GA, não necessariamente o piloto

> Cluster do 07-17, SOBREVIVE integralmente (código congelado). Resumo — detalhe completo no 07-17 §ALTO.

- **CLASSIFIER-TIMEOUT-CRASH (SOBREVIVE)** — `error-classifier.ts:64` faz `(e.code ?? "").toUpperCase()`; o `.code` de um `DOMException{name:"TimeoutError"}` (de `AbortSignal.timeout`) é o numérico `23` → `TypeError` numa função que promete "Never throws". Chamada em `retry-decorator.ts`+`circuit-breaker.ts` → timeouts de LLM nunca retried e breaker cego a timeouts. **Fix 1 linha (`String(e.code ?? "")`), maior ROI técnico da lista.** `Eh≈0.25h`.
- **STRATEGY-FAILED-AS-DONE (SOBREVIVE)** — falha genérica finalizada como `done` (`/complete{responseText:"", strategy:"failed"}` in-enum → 200; backend trata texto vazio como skip que mantém `done`). Sink do CLASSIFIER-TIMEOUT e do PHASE-TIMEOUT. `Eh≈2h`.
- **CP-02 (SOBREVIVE, `[orq✓ 18]` cross-repo) — `contact_id` NÃO existe no contrato de dispatch → ContextBuilder inteiro pulado em 100% dos jobs.** `contactIdCtx` deriva de `payload.conversation?.contact_id ?? payload.context?.contact_id`; backend `harness-dispatch.schema.ts` relido: `conversation:{id, channel_account_id}` (`:31-33`), `context:{...}` (`:45`) — **`contact_id` ausente em ambos** (grep=0). Pré-requisito de TODO valor do ContextBuilder e do fix do IDOR-read. `Eh≈1-2h` + 1 PR backend.
- **CP-01 (SOBREVIVE) — backend despacha histórico ilimitado; harness poison-dropa além do cap.** Backend `messages.min(1)` sem LIMIT (`dispatch.schema.ts:44`); harness `messages.max(100)` → `UnprocessablePayloadError` (poison, sem retry/`/complete`; `dead_letter` 404a). `Eh≈2-4h`.
- **CB-NEW-03 (SOBREVIVE, `[orq✓ 18]` backend) — abort J8 emite `strategy` off-enum → `/complete` 400 engolido.** `strategy` enum backend (`schema.ts:57`) não inclui `aborted_timeout`/`aborted_cost` emitidos pelo handler. `Eh≈1h`.
- **R-01 / R-02 (SOBREVIVEM) — loop ReAct não devolve observações ao LLM (`react.ts:306-307`), e a escalação p/ plan-execute é natimorta (`fix/issue-47` só carimba PlanExecute).** Maior risco de QUALIDADE do piloto (default-ON). `Eh≈3-5h` + `2-3h`.
- **CAL-IDOR-XTENANT + CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN (SOBREVIVEM, LATENT)** — surface de calendário confia em `appointment_id`/`calendar_id` do LLM sem org-scope nem token (`cancel/reschedule.mutation.ts`, `list/read.impl.ts` passam `token=undefined`); paths não-org-scoped 404am no backend. Gated hoje pela ausência de Calendar Service no MVP → **vira CRÍTICO cross-tenant ao corrigir o contrato sem adicionar org-scope+token.** `Eh≈1-2h` + Médio.
- **IDOR-CONTACT-PARAM (SOBREVIVE) — `read-profile` confia no `contact_id` do LLM → exfiltração de PII intra-org.** `read-profile.impl.ts:22` `BigInt(p.contact_id)`; boundary de org SEGURO (repo scoped por `organizationId`). Fix depende de CP-02. `Eh≈0.5-1h`.
- **REFLEXION-NOTES-UNREAD · REWOO-UNREACHABLE · CTX-RULES/HISTORY-DEAD · AUTHZ-ALLOWLIST · AUD-PROPOSAL-CHECK(014) · USAGE-01 · OBS-LLM-METRICS/OBS-OTEL-OFF/LLM-NO-FAILOVER · D-01/D-05 · PRD-ADR017-OWNERSHIP/ADR020-LGPD-ORPHAN · STREAM-01/RAG-NO-RUNTIME-INDEXER/MCP-cluster** (SOBREVIVEM, vários LATENT atrás de flags/contratos). `OBS-OTEL-OFF` re-confirmado `[orq✓ 18]` no manifest (`:146 OTEL_ENABLED:"false"`). Detalhe no 07-17.

### 🟡 MÉDIO — degrada qualidade (SOBREVIVEM do 07-17)

- **EXEC-MODE-FAIL-OPEN (SOBREVIVE, `[orq✓ 18]` vs canon) — `execution_mode` cai default no ÚNICO modo de mutação real, contra a ADR-018 "obrigatório".** `execution-handler.ts:673 ExecutionModeSchema.optional().default("autonomous_supervised")`. Backend **sempre envia** (`dispatch.schema.ts:30` required, relido) mas o schema do harness inverte a garantia — um replay/legado que omita executa create/cancel/send **sem aprovação**. Fix: required (fail-closed) OU default `manual_assisted` (fail-safe). `Eh≈0.5h`.
- **Demais MÉD do 07-17 (SOBREVIVEM):** `NEW-CTX-01` (budget conta schemas-fantasma → truncagem espúria), `MCP-MUTATION-UNGATED` (mutações de calendário via MCP mode-less/unthrottled/unaudited), `CB-BASEURL-IGNORED` (`[orq✓ 18]`: backend `dispatch.schema.ts:28 callback_base_url` required, harness parseia e nunca lê), `USAGE-TABLE-DEAD` (PRD §5.17 não cumprida — `execution_usage` nunca escrita), `WF-COMPLETE-DOUBLE`/`WF-SUSPEND-CLOSES`, `DOUBLE-COMPLETE-REQHUMAN`, `PHASE-TIMEOUT-TERMINAL`, `LLM-MODEL-DOWNGRADE`, `IDOR-WRITE`(inalcançável), `SYNTH-STOP-REACT-ONLY`, `IDEMP-NONDET-PARAMS`, `CP-03`, `TRUNC-DOCTRINE-DROP`, `TOKENIZER-UNDERCOUNT`, `CALENDAR-NO-RETRY`, `QUEUE-NAME-OBS-TRAP`, `D-02`/`D-03`, `MEM-INDEXER-DUP`, `MEM-CONDENSE-NO-CONSUMER`, `CTX-SILENT-DEGRADE`/`TRACES-01`/`STATUS-01-PAUSED`, `SEC-AUDIT-RED`, `CI-LINT-RED`. Detalhe no 07-17.

### 🟢 BAIXO — higiene (SOBREVIVEM do 07-17)

- **DOC-DRIFT (SOBREVIVE, `[orq✓ 18]` re-confirma `CLAUDE.md` §Infraestrutura):** (a) accounts-FK trap descrito ABERTO com workaround `CREATE TABLE accounts...; DROP...` — **OBSOLETO e CONFLITA** com `000_accounts_stub.sql`+`012_drop_accounts_stub.sql` (relidos em disco — trap FECHADO); (b) "Dockerfile single-stage" — FALSO (2-stage); (c) "7 estágios" — o bootstrap tem ~16 blocos `name:`; (d) "3 agentes" — 4 (+MemoryCondenser); (e) `calendar-health` "faz HEAD em CALENDAR_SERVICE_URL" — é GET `/health` e aceita 404. `Eh≈1h`.
- **OPENAPI drift (SOBREVIVE):** `SENTIMENT-ENUM-DOC-DRIFT` (openapi lista 3, backend aceita 6 — `[orq✓ 18]` no `schema.ts:51`); `OPENAPI-REQUEST-LEXICON-STALE` (request ainda `account_id`/`account`, sem `organization_id`/`execution_mode`); `OPENAPI-COMPLETE-FIELD-DRIFT` (campo `response` em vez de `response_text` — backend usa `response_text`, `schema.ts:50`). `Eh≈S`.
- **MARCO1-VERSIONING / MARCO1-OPENAPI-GAP (SOBREVIVEM):** payload sem campo de versão (`X-API-Version`/`/v1/`); openapi sem `cost_usd` nem `strategy:"workflow"`/`aborted_*`. (Gate do piloto = PRD §16.1, "EM ANDAMENTO".) `Eh≈S`.
- **CENSUS-PRD-STALE (SOBREVIVE):** PRD §5.1 `HARNESS_QUEUE_NAME` stale (código: `bevox.execution.dispatch`, `env.ts:28`); PRD §11.1 "7 migrations" (real: 15 arquivos 000–013, dois `013_`); §11 ainda `account_id`. **Código é o lado correto.** `Eh≈2h`.
- **Demais BAIXO (SOBREVIVEM):** `WORKFLOW-FWD-DEAD`, `PERM-BLACKLIST-ORPHAN` (`[orq✓ 18]`: `account_denied_tools` ausente do `dispatch.schema.ts` — grep=0 → blacklist inbound morta; Layer-2 enforça só via complemento do allowlist `skills`), `NEW-RWO-01`, `NEW-3`, `CP-04`, cluster de testes-máscara, `OBS-REDACT-SHALLOW`, `MIG-DUP013` (non-hazard), `ACCOUNT-LEXICON` (`src/`=**0** `[orq✓ 18]`).

---

## Cobertura por categoria do prompt (a–k)

| Cat | Tema | Veredito desta rodada (2026-07-18) |
|---|---|---|
| **a** | PRD vs implementado | PRD v1.1 (**retroativo**, 2026-05-15) majoritariamente em sincronia com o código expandido (MCP/RAG/workflow/OTel/security/streaming/evals presentes). Gate do piloto = **§16.1 "EM ANDAMENTO"** (NÃO cumprido): falta contrato versionado, contract-test e2e, OpenAPI atualizado. Marco-2/3 abertos (retry+CB, dashboards, budget-abort, LGPD retention, incident/deploy playbooks). Vários itens de §15/§16 do PRD já FECHARAM pós-PRD (idempotência sha256/ADR-023, execution_mode 3-modos/EM-03, `max_cost_usd`/J9, PERM-05, organization_id/ADR-019) — o PRD é o lado stale nesses. **"PRD §212" do prompt = fantasma** (PRD termina §17). |
| **b** | execution_mode (ADR-018) | 3 modos (`manual_assisted`/`copilot`/`autonomous_supervised`) parseados, propagados (`AgentExecutionContext.executionMode`→`mutationExecute`→`executeOrPropose`) e alcançáveis. **`EXEC-MODE-FAIL-OPEN`** (MÉD): `:673` default no modo de mutação-real contra ADR-018 "obrigatório". Backend sempre envia (required, `[orq✓ 18]`). C-02 mata retorno draft; AUD-PROPOSAL(014) mata auditoria draft. |
| **c** | Léxico `account_id`/`workspace_id` | **`src/` = 0 material** (`[orq✓ 18]` fresco). `workspace_id`=0. Migrations 001–010 têm `account_id` histórico (superseded por 011, preservado por regra). Backend `dispatch.schema.ts` é `organization_id`-native, sem `account_id` (`[orq✓ 18]`). Resíduo só no **openapi request** (doc-drift, não regressão). Bridge `resolveOrganizationId` colapsada — confirmado (sem hits). |
| **d** | Testes faltando | Suíte **verde: 1236 passed / 57 skipped** (`[orq✓ 18]`, `vitest run`, exit 0). **"cobertura mínima" (CLAUDE.md) super-dimensionado** — hot-path 97-100% (lcov 07-14, válido no código congelado); total ~69,6%; o `execution-handler.ts` 58% é artefato de dead-code (Model-C/workflow/SDR). Gaps reais: `state-store.ts`, `resume-server`/`subscriber` (dead), input-timeout numérico do `error-classifier`, caminhos Redis-blip dos `WF-*`. **#1 faltante: contract-e2e vs Zod IMPORTADO do backend** (pegaria C-01/C-02/C-07/CB-NEW-03 num lugar). |
| **e** | Dívida conhecida | `grep TODO\|FIXME\|HACK\|XXX\|@deprecated src/` = **6** (`[orq✓ 18]`, benignos: 3 `@deprecated` shims em `harness.ts`, `TODO C13` usage, `TODO abort` errors.ts, 1 falso-positivo pt-BR "TODOS"). Dívida real = dead-code (ReWOO waves, Reflexion notes, resume-server/subscriber, condense-worker não-deployado). |
| **f** | Migrations accounts(id) FK | **FECHADO** (`[orq✓ 18]`: `000_accounts_stub.sql` + `011` + `012_drop_accounts_stub.sql` em disco). **A categoria do prompt E os workarounds do CLAUDE.md (harness E hub) estão OBSOLETOS e CONFLITAM** — remover os passos manuais `CREATE TABLE accounts...; DROP...`. `MIG-DUP013` (dois `013_`) non-hazard (`migrate.mjs .sort()` no filename full; tocam tabelas disjuntas). |
| **g** | MCP server (bevox-mcp) | **Funcional, fail-closed** (`MCP_EXPOSED_SKILLS` vazio = nada exposto; `send-message`/`request-human` nunca expostos). Cluster de segurança LATENT se exposto (`MCP-MUTATION-UNGATED`: mode-less/unthrottled/unaudited). PRD §5.13/§10.3 (não "§212"). `src/mcp/` completo (server, client, transports stdio/SSE, adapters, bootstrap, health). |
| **h** | Callbacks (X-Execution-Token) | **4 endpoints reais** (`[orq✓ 18]` dos dois lados): harness exporta `updateStatus→/status`, `sendTrace→/traces`, `sendStream→/stream`, `sendComplete→/complete` (`bevox-callback.ts:98/107/133/149`); backend serve `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete` (`routes.ts:5-8/56/87/109/138`). **`/artifact`,`/tool-result`,`/turn` do prompt NÃO EXISTEM.** Paridade quebrada por **C-01** (verbo `/status`: harness POST vs backend PATCH) + cluster `/complete` (C-02/C-07/CB-NEW-03/AUD-PROPOSAL/USAGE) + OPENAPI-COMPLETE-FIELD-DRIFT. |
| **i** | Bootstrap stages | **~16 blocos `name:`** (não "7"; DOC-DRIFT). `calendar-health` faz **GET `/health` e aceita 404** (`stages.ts:483-491`, só `.catch` em rejeição de rede). Todos gate por `process.exit(1)` em throw. |
| **j** | Alçapões p/ piloto | **MANIFEST-DB-ENV + NO-MIGRATOR = o deploy não sobe/não processa (sem branch).** Depois: **C-01 → `done` fantasma** (+C-07), **CP-02+R-01/R-02+REFLEXION = qualidade quebrada**, **CLASSIFIER-TIMEOUT-CRASH**, `LLM-MODEL-DOWNGRADE`/`PHASE-TIMEOUT-TERMINAL`/`DOUBLE-COMPLETE-REQHUMAN`, `CAL-*` (se Calendar Service ligado), `IDOR-read`, `CP-01`, `USAGE-01`, `OBS-OTEL-OFF` (`[orq✓ 18]` manifest `:146`). |
| **k** | Delta vs audit anterior | **0 CRÍT/ALTO fechados/abertos** (0 commits de produto). Freeze de 3 repos re-provado em disco. Delta material = **zero**; variações só em métricas time-sensitive imateriais (§Delta). |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. **Itens 1-3 NÃO têm branch — precisam ser ESCRITOS.** Inalterado vs 07-17 (código congelado); mantido para self-containment.

0. **META — PAUSAR as auditorias autônomas até haver commit de produto** (`0h`). 12 rodadas sobre código byte-idêntico re-derivam o mesmo backlog; valor marginal ≈ 0. Redirecionar o slot autônomo diário para ESCREVER os itens 1-3.
1. **MANIFEST-DB-ENV — fallback `DATABASE_URL ?? BEVOX_DB_URL` no `env.ts`** (+ suprir/relaxar `CALENDAR_SERVICE_URL`) (`0.5h`). Fecha o crash-loop sem tocar o hub. **Sem branch.**
2. **NO-MIGRATOR — copiar `scripts/`+`migrations/`+deps no runner OU job de migração no deploy** (`~1.5h`). Sem schema, nada PG-backed funciona. **Sem branch.**
3. **C-01 + C-07 juntos — `/status` por PATCH E clamp de `sentiment`** (`~2h`). C-01 isolado é o maior ROI mas expõe C-07; corrige STATUS-02 de graça E neutraliza o `STRATEGY-FAILED-AS-DONE` no caminho `running`.
4. **CLASSIFIER-TIMEOUT-CRASH — `String(e.code ?? "").toUpperCase()`** (`0.25h`). 1 linha restaura retry E accounting de circuit-breaker p/ timeouts de LLM.
5. **STRATEGY-FAILED-AS-DONE — mapear falha genuína p/ desfecho `error`** (`~2h`). Impede que falha transiente vire `done` silencioso + retry-storm.
6. **CP-02 — add `contact_id` ao `conversation` no `harness-dispatch.schema.ts` do backend + destravar o gate** (`~1-2h` + 1 PR backend). Pré-requisito de TODO valor do ContextBuilder E do fix do IDOR-read.
7. **R-01 + completar R-02 — threading de observações no `step()` do ReAct + carimbar obs ReAct com `planGeneration`** (`~5-8h`). O fix `issue-47` entrou pela metade.
8. **Leva de endurecimento barata (~3.5h):** `LLM-MODEL-DOWNGRADE` + `NEW-COST-01` (chave de pricing por prefixo → restaura teto J9 no OpenAI) + `PHASE-TIMEOUT-TERMINAL` + `DOUBLE-COMPLETE-REQHUMAN`/`WF-COMPLETE-DOUBLE`/`WF-SUSPEND-CLOSES` (`completeSent=true` nas 4 branches terminais) + `EXEC-MODE-FAIL-OPEN`/`MCP-MUTATION-UNGATED` (default fail-safe) + `NEW-CTX-01` + CI-LINT (`npm run format`) + OBS-OTEL (flip flag).
9. **C-02 + AUD-PROPOSAL(014) — `deriveIdempotencyKey` no BODY do proposal + migration 014 admitindo `'proposal'`+`'proposed'`** (`~1h`). Desbloqueia modos draft + `waiting_approval` + auditoria draft.
10. **PRD-CONTRACT-E2E-TEST contra os schemas Zod IMPORTADOS do backend** (`~8h`). Pega C-01(verbo)/C-02(key)/C-07(enum)/CB-NEW-03(enum)/CAL(path)/SENTIMENT num só lugar. **#1 teste faltante.** + rebase/re-review de `fix/sdr-ultrareview-findings` (C-06).

> **Pacotes:** **1-5 ≈ "deploy sobe, processa, retria timeouts, não mente sobre o desfecho"** (~6.25h harness-side). **1-9 ≈ endurecimento de piloto** (~21h, ~2 no backend). **1-10 ≈ mínimo de piloto + rede de teste** (~29h + 1 PR backend + 1 rebase). **+ ADR-017/020 + Calendar (CAL-IDOR-XTENANT antes de expor o Calendar Service) + LLM-failover + MCP-hardening + streaming ≈ GA.**

---

## Dependências cruzadas

- **hub-infra (`bevox-PRD-consolidation/infra/`)** → **MANIFEST-DB-ENV** (renomear var ou fallback harness-side), **NO-MIGRATOR** (job/assets de migração), **D-05** (`stop_grace_period`), **OBS-OTEL-OFF** (`:146`), **QUEUE-NAME-OBS-TRAP**, **DOC-DRIFT(a)** (hub CLAUDE.md accounts-FK). **P0 operacional — o pacote não sobe sem (1)+(2), que precisam ser ESCRITOS.** Manifest @ `fd1373b` (congelado; bug presente, relido `[orq✓ 18]`).
- **bevox-backend** → **CP-02** (add `contact_id`), **CP-01** (janelar histórico), **STRATEGY-FAILED-AS-DONE**, **C-01/STATUS-02/CB-NEW-03** (verbo PATCH + enum abort/dead_letter), **C-02/AUD-PROPOSAL** (`idempotency_key` + `waiting_approval`), **C-07/SENTIMENT** (alinhar SPEC ao código — backend aceita 6), **USAGE/PRD-COST** (`cost_usd`). Contrato relido em disco @ `105fb50` `[orq✓ 18]`.
- **Calendar Service / backend Calendar module** → **CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN + CAL-IDOR-XTENANT**: confirmar o alvo de `CALENDAR_SERVICE_URL` e **NÃO expor o Calendar Service antes de threading token + `organization_id` pelo `ToolContext`** — corrigir o contrato sem org-scope transforma o IDOR de latente em CRÍTICO cross-tenant vivo.
- **canon (bevox-knowledge / hub)** → **EXEC-MODE-FAIL-OPEN** (código diverge da ADR-018:75/:112 — alinhar código ou emendar ADR), **C-03/RESUME** (promover ADR-012 ao canon), **STREAM-01** (ADR-016), **PRD-§16.4-ADRs** (idempotência-de-mutação não criado), **CENSUS-PRD-STALE** (PRD retroativo defasado do código pós-2026-06-02). Canon congelado.
- **Governança de branches** → **41 refs `fix/*`/`op-*`** (local+remote; muitas já-em-`main` por patch-id — deletar); **rebase+re-review de `origin/fix/sdr-ultrareview-findings`** (real, C-06).

---

## Delta vs audit anterior (07-17)

**Linhagem de tally:** 06-02 `13·20·46·34` → 06-04 `6·17·23·22` → 06-23 `7·~20·~27·~30` → 07-04 `~7·~18·~29·~19` → 07-05 `~8·~15·~27·~22` → 07-07 `~8·~16·~28·~20` → 07-08 `~8·~18·~30·~26` → 07-14 `~8·~18·~32·~28` → 07-15 `~8·~19·~33·~30` → 07-16 `~8·~20·~36·~33` → 07-17 `~8·~21·~42·~36` → **07-18 `~8·~21·~42·~36` (INALTERADO)**.

### FECHADOS desde 07-17
**Nenhum.** `git log ff2f61d..HEAD` = só o doc `32c31a4` (o próprio 07-17). Código, contrato e manifest congelados idênticos nos 3 repos em disco. **Veredito de piloto/GA inalterado e pré-determinado.**

### NOVOS desde 07-17
**Nenhum.** Não re-executei o fan-out (justificativa em §Notas de método); os 9 NOVOS do 07-17 (`NEW-COST-01`, `NEW-CTX-01`, `MCP-MUTATION-UNGATED`, `CB-BASEURL-IGNORED`, `USAGE-TABLE-DEAD`, `WF-COMPLETE-DOUBLE`/`WF-SUSPEND-CLOSES`, `WORKFLOW-FWD-DEAD`, `PERM-BLACKLIST-ORPHAN`, `NEW-RWO-01`) sobrevivem inalterados — todos LATENTES atrás de flags/contratos-quebrados exceto o ALTO-condicional `NEW-COST-01`. O padrão das 3 últimas rodadas ("a superfície de bug ATIVA na hot-path está exaurida; só resta cauda latente") **é a assinatura do freeze** e reforça a recomendação #0.

### Variações time-sensitive (as únicas possíveis em código congelado)
| Métrica | 07-17 | 07-18 (`[orq✓ 18]`) | Nota |
|---|---|---|---|
| `npm audit` runtime | 32 (28 mod, 4 high, 0 crit) | **32 (28 mod, 4 high)** | idêntico (lockfile congelado) |
| `TODO/FIXME/...` em `src/` | 6 | **6** | idêntico |
| `find tests -name '*.test.ts'` | 190 | **190** | idêntico |
| `prettier --check` dirty | 11 | **~12** | ruído de contagem/doc; tree de produto congelado |
| refs `fix/`/`op-` | 41 | **41** | idêntico |
| Suíte `vitest run` | (verde) | **1236 passed / 57 skipped, 0 fail** | verde, re-rodada fresca |

**Conclusão do delta:** material = **zero**. A 12ª rodada não move nenhum gate.

---

## Correções pendentes ao prompt-mãe e ao CLAUDE.md (byte-verificadas — a corrigir ANTES da próxima rodada, se houver)

1. **prompt-mãe (h)** — "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`": os 3 últimos **não existem**. Reais: `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`.
2. **prompt-mãe (f)** — trata a FK `accounts(id)` como **aberta**: está **FECHADA** (`000`+`012`, PR #25). Remover a pergunta "como fechar definitivamente".
3. **prompt-mãe (g)** — "PRD §212": **fantasma** (o PRD termina no §17; o gate do piloto é §16.1).
4. **CLAUDE.md §Infraestrutura** — accounts-FK workaround obsoleto; "Dockerfile single-stage" (é 2-stage); "7 estágios" (~16 blocos); "3 agentes" (4, +MemoryCondenser); "HEAD em CALENDAR_SERVICE_URL" (é GET `/health`, aceita 404).
5. **CLAUDE.md** — "cobertura Vitest é mínima": **super-dimensionado** (1236 testes passando; hot-path 97-100%).

---

## Notas de método

**Decisão deliberada de NÃO re-executar o fan-out multi-agente.** O 07-17 rodou 5 subagentes (Backend Architect ×2 / AI Engineer / Security Engineer / Test Results Analyzer, ~458K tokens) e concluiu, com evidência, que a superfície de bug ATIVA na hot-path está exaurida e que a cadência virou toil. Com o código **byte-idêntico** re-verificado nesta sessão (`git diff origin/main..HEAD -- src/`=0), um novo fan-out reproduziria o mesmo backlog — a **exata inércia** que o prompt-mãe proíbe ("não invocar [agents] por inércia") e que a minha memória de projeto e a recomendação #0 do 07-17 mandam evitar. Effort-max foi gasto onde há valor marginal real: **verificação independente de primeira-mão** do cluster acionável nos 3 repos.

**O que fiz (tudo `[orq✓ 18]`, leitura própria nesta sessão):**
- **git-archaeology / freeze:** `git diff origin/main..HEAD -- src/`=0; `git status` limpo (só docs/worktrees untracked); `git log ff2f61d..HEAD` = 1 doc.
- **Suíte:** `npx vitest run` → 173 files / 1236 tests passed, 17/57 skipped, exit 0 (linhas `level:50` = fixtures negativas propositais).
- **harness em disco:** `env.ts:8-12/27-28`, `Dockerfile:1-18`, `bevox-callback.ts:15/28/98/107/133/141/149/155`, `migrations/` (000+012 presentes), grep lexicon `src/`=0, grep TODO=6.
- **backend em disco** (`105fb50`): `harness-callbacks.routes.ts:5-8/56/87/109/138`, `harness-callbacks.schema.ts:16/40/50/51/57`, `harness-dispatch.schema.ts:28-53` (sem `contact_id`, sem `account_id`, sem `account_denied_tools`; `organization_id`+`execution_mode` required).
- **hub em disco:** `bevox-prod-manifest.yaml:105/132/146/155-162` (harness omite `DATABASE_URL`+`CALENDAR_SERVICE_URL`; `OTEL_ENABLED:"false"`).
- **canon:** PRD v1.1 §5/§15/§16 relido (retroativo, defasado do código pós-2026-06-02); ADR-006/007/016/019/021 + ADR-018 mapeados.
- **Métricas time-sensitive:** `npm audit --omit=dev` (32), `prettier --check` (~12), branches `fix/`/`op-` (41).

**Agents locais.** Nenhum agente `.claude/agents/` foi invocado — deliberadamente. A varredura é de verificação-de-freeze + leitura cross-repo, não de descoberta; o 07-17 já cobriu a descoberta com fan-out. Invocar `engineering-ai-engineer`/`backend-architect`/`mcp-builder`/`code-reviewer` sobre código congelado seria toil por inércia (contra a regra do prompt-mãe). Recomendação: a próxima invocação de agente de valor é para **implementar** os itens 1-3, não auditar.

**Confiança.** Alta em todo achado acionável — cada `arquivo:linha` do cluster de deploy foi lido **dos dois lados** nesta sessão. **Residual/Duvidoso:** (1) `MANIFEST-DB-ENV`/`NO-MIGRATOR` repousam no manifest+runbook do hub — se a Hetzner injeta `DATABASE_URL`/roda `migrate` out-of-band, rebaixa; **confirmar com o dono do hub** (memória `manifest-db-env-deploy-blocker`; bug presente @ `fd1373b`). (2) `CAL-*` dependem do alvo real de `CALENDAR_SERVICE_URL`. (3) escopo do piloto (draft/SDR/teto-de-custo) condiciona C-02..C-06 + `NEW-COST-01`.

**Meta-nota ao revisor humano (12ª rodada, ~45 dias de estase, 0 commit de produto).** A cadência de auditoria autônoma é toil de valor marginal decrescente e **auto-confirmado por 3 rodadas consecutivas**. **Recomendação #0: PAUSAR as auditorias autônomas até haver commit de produto.** A próxima ação de valor não é uma 13ª auditoria — é o primeiro commit de produto desde 2026-06-03, começando por: `env.ts` (`DATABASE_URL ?? BEVOX_DB_URL`), `Dockerfile` (copiar `scripts/`+`migrations/` no runner), `bevox-callback.ts` (`/status` por PATCH + clamp de `sentiment`). ~3h harness-side destravam o boot, o processamento e o não-mentir-sobre-o-desfecho. Enquanto o slot diário produzir docs e não código, este relatório e os 11 anteriores dizem a mesma coisa.
