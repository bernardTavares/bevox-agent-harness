# Gap Analysis — bevox-harness — 2026-07-20

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-07-19.md` (linhagem: `07-19`/`07-18`/`07-17`/`07-16`/`07-15`/`07-14`/`07-08`/`07-07`/`07-05`/`07-04`/`06-23`/`06-04`/`06-02` — esta é a **14ª rodada**).
> **HEAD auditado:** `2d70002` (branch `test/execution-handler-coverage-uplift`) — o commit do doc 07-19. **Zero commits de produto desde 2026-06-03** (`origin/main` @ `2979eb0`); tudo desde então (exceto docs de auditoria) é test-only.
>
> **Freeze re-verificado FRESCO nos 3 repos em disco NESTA sessão (leitura própria, marcada `[✓ 20]` — não citada de memória nem do 07-19):**
> 1. **harness** — `git diff origin/main..HEAD -- src/ migrations/` = **0 linhas** (produto + schema byte-idênticos a `origin/main` @ `2979eb0`, **~47 dias**). `git status` = só `docs/` + `.claude/worktrees/` untracked. **Suíte verde re-rodada `[✓ 20]`:** `vitest run` = **173 files / 1236 tests passed**, 17/57 skipped, **0 falhas**, exit 0 (as linhas `level:50` são fixtures de caminho-negativo propositais — poison payloads, "backend down" do `perm-03-ordering.test.ts:224`, métricas de dead-letter — não erros).
> 2. **backend** `bevox-backend` @ `6f6867d` — **moveu de `105fb50` (07-07) desde o 07-19**, mas o commit mais novo é ele próprio um **doc de auditoria autônoma** (`docs(audit): runtime gap audit 2026-07-19`). A estase cross-repo continua e é a mesma nos dois repos.
> 3. **hub** `bevox-PRD-consolidation` @ `53faef2` — manifest `infra/bevox-prod-manifest.yaml` (last-touched `fd1373b`, 2026-06-03) relido linha-a-linha `[✓ 20]` (bloco `bevox-harness` `:132-164`).
> 4. **canon** `bevox-knowledge` @ `0317985` (2026-06-02) — congelado; PRD + ADRs relidos `[✓ 20]`.
>
> **Método (effort-max redirecionado — ver §"Notas de método"):** dado o freeze de ~47 dias re-confirmado em 3 repos, **NÃO** re-executei o fan-out multi-agente de descoberta (reproduziria backlog byte-idêntico — a exata inércia que o prompt-mãe proíbe). O effort-max desta rodada foi para **git-archaeology de primeira-mão sobre o constelação de branches não-mergeadas** e **verificação cross-repo dos-dois-lados** dos 2 blockers de deploy que dependem do backend/hub. **O achado material desta rodada (o mais forte em ~47 dias): grande parte da remediação já está ESCRITA, verde, e apenas não-mergeada** — o gap dominante virou de *autoria* para *governança de integração*.
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

**Nada de produto mudou em ~47 dias em nenhum dos 3 repos do contrato; o veredito é pré-determinado — PILOTO: NÃO-GO · GA: NÃO-GO — e esta 14ª rodada não o move.** Mas ela **re-mapeia a remediação com precisão nova e acionável**. Os 3 blockers de deploy **incondicionais** (`MANIFEST-DB-ENV`, `NO-MIGRATOR`, `C-01`) foram **hand-verificados FRESCO dos DOIS lados `[✓ 20]`** — harness (`env.ts`/`Dockerfile`/`bevox-callback.ts`) **E** os repos-alvo (backend `harness-callbacks.routes.ts`, hub `bevox-prod-manifest.yaml`) — e **sobrevivem sem branch de remediação**. Todo o cluster CRÍTICO/ALTO/MÉDIO/BAIXO do 07-19 (`~8·~21·~42·~36`) sobrevive por construção (código congelado). **0 CRÍTICO/ALTO fechados** (0 commits de produto).

**Achado NOVO desta rodada (a maior alavanca em ~47 dias): boa parte dos fixes reportados como "abertos" JÁ EXISTE, verde, em branches não-mergeadas — o gap é de INTEGRAÇÃO, não de autoria.** O 07-19 encontrou UM item não-mergeado (a rede de invariantes de teste). Uma git-archaeology mais funda `[✓ 20]` revela uma **constelação inteira**:

- **`fix/*` (4 branches) = MORTAS.** `fix/migration-accounts-stub` (000+012) e `fix/skill-loader-esm-import` (`createRequire`→`await import()`) **já estão em `main` por conteúdo** (SHA diferente — deletar). `fix/complete-callback-contract` é **STALE pré-SKILLS-05** (mexe em `*.tool.ts` já deletados; **NÃO** corrige o C-01; seu único ganho — `response`→`response_text` — já está em `main`). `fix/rules-payload-organization-id` é doc-only.
- **`op-*` + `finding-j10` (5 branches) = FIXES DE PRODUTO VIVOS, não-mergeados** (pós-SKILLS-05, datados 2026-06-03/04, dormentes ~47d, `[✓ 20]` NÃO em `main`): **`finding-j10-running-status`** envolve `updateStatus("running")` num `.catch()` → **mitiga o raio de dano do C-01** (+11 linhas); **`op-reasoning-quality`** (`react`/`reflexion`/`errors`/`execution-handler`, +175) → **R-01/R-02** (threading de reflexion) + abort `invalid_plan` do ReWOO; **`op-ctx-tokenizer-budget`** (`tokenizer`/`budget-enforcer`, +207) → **TOKENIZER-UNDERCOUNT/NEW-CTX-01**; **`op-pipeline-json-robustness`** (`extract-json` + 3 pipeline agents, +145) → robustez JSON (**C-07-adjacente**); **`op-openapi-sync`** (0 src) → drift OpenAPI.
- **`NET-UNMERGED`** (do 07-19, re-confirmado `[✓ 20]`): 7 testes de invariante + helper + smoke round-trip, verdes, nunca em `main`.

**Consequência prática:** o backlog de *escrita* real é MENOR do que "escrever tudo". Só **3 itens incondicionais genuinamente não têm branch e precisam ser escritos**: `MANIFEST-DB-ENV` (~0.5h), `NO-MIGRATOR` (~1.5h), e a **raiz** do `C-01` (verbo PATCH, ~1h — embora `finding-j10` já neutralize o desfecho fatal). O resto do endurecimento de raciocínio/contexto/pipeline **já está escrito e verde** — precisa de triagem, rebase e merge disciplinados (as 5 branches se **sobrepõem em `execution-handler.ts`** → NÃO mergear em bloco).

**O achado dominante continua sendo de PROCESSO — agora na 14ª rodada.** Auditar código byte-idêntico pela 14ª vez é toil de valor marginal ≈ 0; as 4 rodadas anteriores (07-16/17/18/19) elevaram "pausar a cadência" a recomendação #0 e **eu concordo e a mantenho**. A diferença acionável desta rodada é que agora existe um **caminho de destravamento concreto e barato** (merge da rede → triagem das branches vivas → 3 fixes de escrita) que troca o slot autônomo diário de *relatar* por *integrar*.

**Correções duráveis re-confirmadas `[✓ 20]` (o prompt-mãe E o CLAUDE.md continuam desatualizados — ver §Correções):** (f) FK `accounts(id)` tratada como aberta — **FECHADA** (`000`+`012` em `origin/main`, verificado por `git cat-file -e`); (h) "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`" — os 3 últimos **não existem em NENHUM dos lados** (backend serve só `/status`,`/traces`,`/stream`,`/complete`); (g) "PRD §212" é **fantasma** (o PRD termina no §17); "cobertura Vitest mínima" (CLAUDE.md) é **super-dimensionado** (1236 testes verdes); "Dockerfile single-stage" e "7 estágios" são **falsos** (2-stage; ≥9 estágios).

---

## Achados por severidade

> Convenção: `arquivo:linha` no HEAD `2d70002` (== `origin/main` em `src/`). **`[✓ 20]`** = **lido e hand-verificado por mim NESTA sessão (2026-07-20)**, em disco. `SOBREVIVE` = re-aberto e confirmado por freeze de código. `Eh` = esforço estimado. Para o detalhe exaustivo item-a-item do latent-tail herdado (~42 MÉD + ~36 BAIXO), ver `runtime-gap-audit-2026-07-17.md` §"Achados por severidade" — não re-derivado aqui por disciplina anti-toil; o freeze de src garante paridade 1:1.

### 🔴 CRÍTICO — bloqueia o piloto

> Os 3 incondicionais foram **re-lidos linha-a-linha dos DOIS lados nesta sessão `[✓ 20]`**. Nota nova desta rodada: coluna "branch" agora distingue *sem-branch* (precisa escrita) de *mitigado por branch viva não-mergeada*.

#### Incondicionais (bloqueiam o piloto em QUALQUER escopo)

- **MANIFEST-DB-ENV (SOBREVIVE, `[✓ 20]` dos-dois-lados) — o pacote de deploy pinado crash-loopa no boot.**
  - Harness `src/config/env.ts` (relido `[✓ 20]`): `:8 DATABASE_URL: z.string().url()` **(required)**, `:11 BEVOX_DB_URL: z.string().url().optional()` **(opcional; nunca lido pelo pool)**, `:12 CALENDAR_SERVICE_URL: z.string().url()` **(required)**. `getEnv()` `:203` faz `safeParse` → `:206 process.exit(1)` em falha.
  - Hub `infra/bevox-prod-manifest.yaml` bloco `bevox-harness` `:132` (relido `[✓ 20]`): supre `BEVOX_DB_URL`(`:155`) + `REDIS_URL`(`:156`) + `BEVOX_CALLBACK_BASE_URL`(`:157`) + `BEVOX_DEFAULT_ORGANIZATION_ID`(`:158`) + chaves LLM, mas **OMITE `DATABASE_URL` E `CALENDAR_SERVICE_URL`** (o `DATABASE_URL:` em `:105` está no bloco **backend**). Imagem pinada `sha256:b4c66bb…` = **v1.0.0 (2026-06-01)** — anterior ao baseline do freeze.
  - → `safeParse` falha em 2 required → `process.exit(1)` **antes do stage 1 (`infra-check`)** → 2 réplicas em crash-loop → 0 jobs consumidos → 100% dos jobs batem no 120s-timeout-scan do backend → handoff/dead_letter. **Fix harness-side ~1 linha:** `DATABASE_URL: z.string().url().optional()` + refino `DATABASE_URL ?? BEVOX_DB_URL`, e relaxar/suprir `CALENDAR_SERVICE_URL` (o stage `calendar-health` já tolera qualquer status HTTP). `Eh≈0.5h`. **Sem branch.**

- **NO-MIGRATOR (SOBREVIVE, `[✓ 20]`) — o schema do harness nunca é criado no deploy pinado.**
  - `Dockerfile` (relido `[✓ 20]`, **2-stage**): `builder`(`:1`) copia `src`(`:6`)+`scripts`(`:7`) e roda `npm run build`(`:8`); `runner`(`:10`) copia **só** `COPY --from=builder /app/dist ./dist`(`:16`) → `migrations/` E `scripts/migrate.mjs` estão **fisicamente ausentes** da imagem de prod (`CMD ["node","dist/index.js"]` `:18`). O manifest não tem sidecar de migração para o harness. **CLAUDE.md §Infra diz "Dockerfile single-stage" — FALSO** (é 2-stage). **Fix:** copiar `scripts/`+`migrations/`(+deps de migração) no runner, OU job de migração no deploy do hub. `Eh≈1.5h`. **Sem branch.**

- **C-01 (SOBREVIVE, `[✓ 20]` dos-dois-lados) — `updateStatus` por POST contra rota PATCH-only → 404 no 1º callback.**
  - Harness `src/integration/bevox-callback.ts` (relido `[✓ 20]`): helper `post()`(`:15`) crava `method:"POST"`(`:28`); `updateStatus`(`:133`) chama `post('/api/v1/executions/${id}/status', ...)`(`:141`).
  - Backend `6f6867d` `src/integration/harness-callbacks.routes.ts` (relido `[✓ 20]`): a rota é **`PATCH /api/v1/executions/:id/status`** (`:5` doc, `:57` registro). Os outros 3 verbos batem: `POST /traces`(`:88`), `POST /stream`(`:110`), `POST /complete`(`:139`).
  - → `updateStatus(...,"running")` é o 1º `await` do try genérico → 404 → error-boundary. **NOVO `[✓ 20]`: `finding-j10-running-status` já resolve o DESFECHO fatal** (envolve a chamada num `.catch()` best-effort — o blip não mata mais a execução), mas **NÃO corrige a RAIZ** (verbo) nem o `STATUS-02` (dead_letter via mesmo POST/status → 404 → UI de replay nunca acende). **Fix raiz:** helper `patch()` para `/status` (ou parametrizar o método). `Eh≈1h` (co-fixar com C-07).
  - **STATUS-02 (SOBREVIVE)** — mesmo POST-vs-PATCH mata o `dead_letter` autoritativo. `finding-j10` NÃO cobre esta chamada. Fechado ao corrigir a raiz do C-01.

- **C-07 (SOBREVIVE) — `sentiment` da pipeline não-validado → `/complete` 400 em output malformado (co-fix do C-01).** Enum backend = 6 valores; `message-analyzer.agent.ts` faz cast cru. Mascarado hoje pelo C-01. **NOVO `[✓ 20]`: `op-pipeline-json-robustness` adiciona `extract-json.ts` + endurece os 3 pipeline agents** — não é o clamp de enum exato, mas é a robustez de parsing adjacente que reduz a superfície. Fix: `safeParse`+clamp de `sentiment`. `Eh≈1-2h`.

#### Condicionais ao escopo do piloto (CRÍTICO **se** o piloto inclui modos draft e/ou cadência SDR; senão ALTO)

> **Ação ao revisor: confirmar se o piloto usa `manual_assisted`/`copilot` (aciona C-02/AUD-PROPOSAL) ou a esteira SDR/Model-C (aciona C-03..C-06).**

- **C-02 (SOBREVIVE) — `proposals[]` sem `idempotency_key` → `/complete` 400 nos modos draft.** `Eh≈0.5h`. Guardado por `em-03-proposals-end-to-end.test.ts` (rede não-mergeada).
- **C-03 (SOBREVIVE) — esteira SDR/cadência/Model-C/resume morta na fiação viva.** `scheduler.agent.ts` sem `workflow:`; `resume-server.ts`/`subscriber.ts` dead-code (flag default-off). `Eh≈6-8h`.
- **C-04 (SOBREVIVE) — timeout de não-resposta marca cadência `failed` em vez de avançar.** Cobertura real 0%. `Eh≈4-6h`.
- **C-05 (SOBREVIVE) — Model-C sem error boundary + dedup key retida → execução perdida.** `Eh≈3-5h`.
- **C-06 (SOBREVIVE, `[✓ 20]`) — respostas vivas nunca qualificam lead nem honram opt-out (risco LGPD).** `execution-handler.ts:565` crava `observedSignals:{}` (comentário `:556` "intentionally left empty in Fase C"). Substância do fix vive UNMERGED em `origin/fix/sdr-ultrareview-findings`. `Eh≈8h`.

### 🟠 ALTO — bloqueia GA, não necessariamente o piloto

> Cluster do 07-17/07-19, SOBREVIVE integralmente. **NOVO nesta rodada:** vários têm **fix VIVO não-mergeado** (marcado 🔧).

- **CLASSIFIER-TIMEOUT-CRASH (SOBREVIVE)** — `error-classifier.ts` faz `(e.code ?? "").toUpperCase()`; `.code` de `DOMException{name:"TimeoutError"}` é numérico → `TypeError` numa função que promete "Never throws" → timeouts de LLM nunca retried. **Fix 1 linha (`String(e.code ?? "")`), maior ROI técnico da lista.** `Eh≈0.25h`. (Nota: `op-reasoning-quality` mexe em `errors.ts` mas o alvo lá é o enum `AbortReason`+`invalid_plan`, **não** este `error-classifier.ts` — este permanece sem fix.)
- **STRATEGY-FAILED-AS-DONE (SOBREVIVE)** — falha genérica finalizada como `done` (`/complete{responseText:"", strategy:"failed"}` in-enum → 200). Sink do CLASSIFIER-TIMEOUT e do PHASE-TIMEOUT. `Eh≈2h`.
- **🔧 R-01 / R-02 (SOBREVIVEM; fix VIVO não-mergeado)** — loop ReAct não devolve observações ao LLM e a escalação p/ plan-execute é natimorta. **NOVO `[✓ 20]`: `op-reasoning-quality` (`react.ts` +16, `reflexion.ts`, `execution-handler.ts` +147) faz o threading de reflexion no `systemPrompt` e trata escalação** — está escrito e verde, **fora de `main`**. Maior risco de QUALIDADE do piloto (default-ON). Guardado por `engine-swap-mid-loop.test.ts` (rede não-mergeada). `Eh` (integração)`≈2-3h` vs `≈5-8h` de escrita do zero.
- **🔧 TOKENIZER-UNDERCOUNT / NEW-CTX-01 (SOBREVIVEM; fix VIVO)** — **NOVO `[✓ 20]`: `op-ctx-tokenizer-budget` (`tokenizer.ts` +124, `budget-enforcer.ts` +81, `calibration.ts`, `execution-handler.ts` +19) endurece a contagem de tokens e o budget** — escrito, verde, fora de `main`. Guardado por `ctx-02-budget-enforce.test.ts`.
- **CP-02 (SOBREVIVE, cross-repo) — `contact_id` ausente no contrato de dispatch → ContextBuilder pulado em 100% dos jobs.** Backend `harness-dispatch.schema.ts` não emite `contact_id`. Pré-requisito de TODO valor do ContextBuilder e do fix do IDOR-read. `Eh≈1-2h` + 1 PR backend.
- **CP-01 (SOBREVIVE) — backend despacha histórico ilimitado; harness poison-dropa além de `messages.max(100)`.** `Eh≈2-4h`.
- **CB-NEW-03 (SOBREVIVE) — abort J8 emite `strategy` off-enum (`aborted_timeout`/`aborted_cost`) → `/complete` 400 engolido.** `Eh≈1h`.
- **CAL-IDOR-XTENANT + CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN (SOBREVIVEM, LATENT)** — surface de calendário confia em `appointment_id`/`calendar_id` do LLM sem org-scope nem token. Gated hoje pela ausência de Calendar Service no MVP → **vira CRÍTICO cross-tenant ao corrigir o contrato sem adicionar org-scope+token.** `Eh≈1-2h` + Médio.
- **IDOR-CONTACT-PARAM (SOBREVIVE) — `read-profile` confia no `contact_id` do LLM → exfiltração de PII intra-org.** Boundary de org SEGURO (repo scoped por `organizationId`). Fix depende de CP-02. `Eh≈0.5-1h`.
- **REFLEXION-NOTES-UNREAD · REWOO-UNREACHABLE · CTX-RULES/HISTORY-DEAD · AUTHZ-ALLOWLIST · AUD-PROPOSAL-CHECK(014) · USAGE-01 · OBS-LLM-METRICS/OBS-OTEL-OFF/LLM-NO-FAILOVER · D-01/D-05 · PRD-ADR017-OWNERSHIP/ADR019-LGPD-ORPHAN · STREAM-01/RAG-NO-RUNTIME-INDEXER/MCP-cluster** (SOBREVIVEM, vários LATENT atrás de flags/contratos). `OBS-OTEL-OFF` re-confirmado `[✓ 20]` no manifest (`:146 OTEL_ENABLED:"false"`). `REFLEXION-NOTES-UNREAD` é parcialmente endereçado por `op-reasoning-quality` (fix VIVO). Detalhe no 07-17.

### 🟡 MÉDIO — degrada qualidade (SOBREVIVEM do 07-17/07-19)

- **EXEC-MODE-FAIL-OPEN (SOBREVIVE, `[✓ 20]`, vs canon) — `execution_mode` cai default no ÚNICO modo de mutação real, contra a ADR-018 (harness) / ADR-006 (_shared) "obrigatório".** `execution-handler.ts:673` (`ExecutionModeSchema.optional().default("autonomous_supervised")`). Backend **sempre envia** (required) mas o schema do harness inverte a garantia — um replay/legado que omita executa create/cancel/send **sem aprovação**. Fix: required (fail-closed) OU default `manual_assisted` (fail-safe). `Eh≈0.5h`.
- **Demais MÉD (SOBREVIVEM):** `NEW-CTX-01` (🔧 fix vivo em `op-ctx-tokenizer-budget`), `MCP-MUTATION-UNGATED`, `CB-BASEURL-IGNORED` (backend envia `callback_base_url` required, harness parseia e nunca lê), `USAGE-TABLE-DEAD` (PRD §5.17 — `execution_usage` nunca escrita), `WF-COMPLETE-DOUBLE`/`WF-SUSPEND-CLOSES`, `DOUBLE-COMPLETE-REQHUMAN`, `PHASE-TIMEOUT-TERMINAL`, `LLM-MODEL-DOWNGRADE`, `IDOR-WRITE`(inalcançável), `SYNTH-STOP-REACT-ONLY`, `IDEMP-NONDET-PARAMS`, `CP-03`, `TRUNC-DOCTRINE-DROP`, `TOKENIZER-UNDERCOUNT`(🔧), `CALENDAR-NO-RETRY`, `QUEUE-NAME-OBS-TRAP`, `D-02`/`D-03`, `MEM-INDEXER-DUP`, `MEM-CONDENSE-NO-CONSUMER`, `CTX-SILENT-DEGRADE`/`TRACES-01`/`STATUS-01-PAUSED`, `SEC-AUDIT-RED`, `CI-LINT-RED`. Detalhe no 07-17.

### 🟢 BAIXO — higiene (SOBREVIVEM do 07-17/07-19)

- **DOC-DRIFT (SOBREVIVE, `[✓ 20]` re-confirma `CLAUDE.md` §Infraestrutura):** (a) accounts-FK trap descrito ABERTO com workaround `CREATE TABLE accounts…; DROP…` — **OBSOLETO e CONFLITA** com `000_accounts_stub.sql`+`012_drop_accounts_stub.sql` (em `origin/main` `[✓ 20]` — trap FECHADO); (b) "Dockerfile single-stage" — FALSO (2-stage); (c) "7 estágios" — FALSO (**≥9**: +`start-dev-ws`+`init-evals` `[✓ 20]`); (d) "3 agentes" (4, +MemoryCondenser); (e) `calendar-health` "faz HEAD" — é **GET `/health`** (`stages.ts:485`) e tolera qualquer status HTTP (só `.catch` em rejeição de rede/timeout `[✓ 20]`). `Eh≈1h`.
- **🔧 OPENAPI drift (SOBREVIVE; fix VIVO não-mergeado em `op-openapi-sync`):** `SENTIMENT-ENUM-DOC-DRIFT` (openapi lista 3, backend aceita 6); `OPENAPI-REQUEST-LEXICON-STALE` (request ainda `account_id`/`account`); `OPENAPI-COMPLETE-FIELD-DRIFT` (`response` vs `response_text`). `op-openapi-sync` (`docs(openapi): sync… to current dispatch/callback contract`) já reescreve o spec — 0 mudança de src, doc-only, fora de `main`. `Eh` (merge)`≈S`.
- **MARCO1-VERSIONING / CENSUS-PRD-STALE (SOBREVIVEM):** payload sem campo de versão; PRD §5.1 `HARNESS_QUEUE_NAME` stale, §11 "7 migrations" (real: 15 arquivos 000–013, dois `013_`). **Código é o lado correto.** `Eh≈2h`.
- **Demais BAIXO (SOBREVIVEM):** `WORKFLOW-FWD-DEAD`, `PERM-BLACKLIST-ORPHAN` (`account_denied_tools` ausente do `dispatch.schema.ts` backend → blacklist inbound morta; Layer-2 enforça só via complemento do allowlist `skills`), `NEW-RWO-01`, `CP-04`, cluster de testes-máscara, `OBS-REDACT-SHALLOW`, `MIG-DUP013` (non-hazard), `ACCOUNT-LEXICON` (`src/`=**0** `[✓ 20]`).

---

## 🆕 Achado novo desta rodada — a constelação de fixes não-mergeados (o delta material)

**`UNMERGED-CONSTELLATION` (NOVO, `[✓ 20]` por git-archaeology; severidade: oportunidade ALTA / dívida de integração MÉDIA).** O 07-19 encontrou UM item fora de `main` (a rede de invariantes). Esta rodada mapeia a constelação inteira das **41 refs `fix/`/`op-`** e a classifica com `git diff --numstat origin/main...<branch> -- src/` + leitura dos diffs:

### Branches MORTAS (`fix/*`) — deletar, não integrar

| Branch | Conteúdo | Veredito `[✓ 20]` |
|---|---|---|
| `fix/migration-accounts-stub` | `000_accounts_stub.sql`+`012_drop_accounts_stub.sql` | **JÁ EM `main` por conteúdo** (`git cat-file -e origin/main:migrations/000_…` = presente). Redundante. |
| `fix/skill-loader-esm-import` | `skill-loader.ts`: `createRequire`→`await import(pathToFileURL(...))` | **JÁ EM `main` por conteúdo** (`skill-loader.ts:104` = `await import(...)`; comentário `:102` documenta o motivo `ERR_REQUIRE_ESM`). Redundante. |
| `fix/complete-callback-contract` | `bevox-callback.ts`+`execution-handler.ts`+`react.ts`+`*.tool.ts` | **STALE pré-SKILLS-05** — mexe em `send-message.tool.ts`/`request-human.tool.ts` **já deletados de `main`**; **NÃO** corrige o C-01 (seu `updateStatus` continua `method:"POST"` em `/status`); seu único ganho (`response`→`response_text`) já está em `main`. Não-mergeável sem reescrita total. |
| `fix/rules-payload-organization-id` | `.claude/rules/harness-payload.md` | Doc-only. |

### Branches VIVAS (`op-*` + `finding-j10`) — fixes de produto escritos, verdes, fora de `main`

> Todas pós-SKILLS-05 (baseadas na estrutura atual — tocam `unified-registry.test.ts`/`*.mutation.ts`), datadas **2026-06-03/04**, dormentes ~47d. São **106–145 commits à frente** de `main` e **se sobrepõem em `execution-handler.ts`** → precisam de **triagem/cherry-pick/rebase por-fix**, NÃO merge em bloco.

| Branch | src delta (vs `origin/main`) | Fecha/mitiga | Verificação `[✓ 20]` |
|---|---|---|---|
| `finding-j10-running-status` | `execution-handler.ts` (+11) | **C-01 raio de dano** | Envolve `updateStatus(…, "running")` em `.catch()` best-effort — o blip do `/status` deixa de ser fatal. |
| `op-reasoning-quality` | `react.ts`+`reflexion.ts`+`errors.ts`+`execution-context.ts`+`execution-handler.ts` (+175) | **R-01/R-02**, REFLEXION-NOTES, ReWOO-cíclico | Threading de `reflexionPreamble` no `systemPrompt`; novo `AbortReason "invalid_plan"`. Head: `docs(audit): mark a-reasoning-01/02/03 resolved`. |
| `op-ctx-tokenizer-budget` | `tokenizer.ts`+`budget-enforcer.ts`+`calibration.ts`+`execution-handler.ts` (+207) | **TOKENIZER-UNDERCOUNT/NEW-CTX-01** | Emite `token_estimate_ratio`+`tokenizer_fallback` telemetry (CTX-04). |
| `op-pipeline-json-robustness` | `extract-json.ts`(+133)+3 pipeline agents (+145) | **C-07-adjacente** | Extração JSON robusta p/ MessageAnalyzer/MemoryExtractor/MemoryCondenser. |
| `op-openapi-sync` | 0 src (openapi/docs) | OPENAPI-*-DRIFT | Reescreve o spec p/ o contrato atual. |
| `op-ctx-semantic-recall` | 0 src | (test-only; recall já inert em main) | — |

### `NET-UNMERGED` (do 07-19, re-confirmado `[✓ 20]`) — a rede de segurança de teste

A branch atual `test/execution-handler-coverage-uplift` carrega **19 commits não-doc, TODOS `test(harness):`** (datados 2026-06-03/04) — a rede de invariantes de handler + helper + smoke round-trip, **verde e nunca em `main`** (`git log origin/main -- tests/unit/runtime/invariants/` = **0** `[✓ 20]`):

| Teste | Invariante guardada | Blindaria o fix de |
|---|---|---|
| `perm-03-ordering.test.ts` | audit escrito mesmo quando `sendComplete` lança | C-01/STATUS-02 |
| `x-execution-token-header.test.ts` | `X-Execution-Token` em TODO callback | C-01 (contrato) |
| `em-03-proposals-end-to-end.test.ts` | tool propose chega em `/complete.proposals[]` | C-02 (draft) |
| `proposals-accumulator-isolation.test.ts` | proposals isolados entre execuções | acumulador per-execução |
| `ctx-02-budget-enforce.test.ts` | `enforceBudget` roda antes do surface loop | CP-02/NEW-CTX-01 (🔧 `op-ctx-tokenizer-budget`) |
| `engine-swap-mid-loop.test.ts` | observações preservadas na escalação | R-01/R-02 (🔧 `op-reasoning-quality`) |
| `otel-root-span-hierarchy.test.ts` | um root span `execution.handle` | OBS-OTEL |

Além disso, `scripts/smoke/01-execution-roundtrip.{ts,sh}` dá um **round-trip local via BullMQ** (enqueue → worker → `job.getState()==="completed"`, exit codes discriminados) — a ferramenta exata de verificação manual pós-`docker:up` para os fixes de deploy.

**Impacto integrado:** o caminho de destravamento é claro e barato: **(0a)** mergear a rede de teste (substrato de regressão, test-only, verde) → **(0b)** triar as branches VIVAS por-fix sobre a rede → **(1-3)** escrever os 3 blockers incondicionais sem-branch. **A dívida é de governança de integração, não de autoria.** *Duvidoso/verificar (não visível em disco):* por que a constelação travou — PRs abertas em review? trabalho local nunca promovido? — **confirmar com o dono das branches**; e se há regressão conhecida que motivou o abandono ~47d atrás.

---

## Cobertura por categoria do prompt (a–k)

| Cat | Tema | Veredito desta rodada (2026-07-20, `[✓ 20]`) |
|---|---|---|
| **a** | PRD vs implementado | PRD `2026-05-15-…-v1` (retroativo) majoritariamente em sincronia (§5.7 perms-3-camadas, §5.8 5-engines, §5.12/§10.2 callbacks, §5.13/§10.3 MCP, §5.14 RAG, §5.15 workflow, §5.17 OTel, §5.19 streaming, §5.20 evals — todos presentes no código). Gate do piloto = **§16 "EM ANDAMENTO"** (não cumprido): falta contrato versionado, contract-test e2e, OpenAPI atualizado (🔧 `op-openapi-sync`). **PRD termina no §17 — "PRD §212" do prompt = fantasma `[✓ 20]`.** |
| **b** | execution_mode (ADR-018 harness / ADR-006 _shared) | 3 modos parseados e propagados (`AgentExecutionContext.executionMode`→`mutationExecute`→`executeOrPropose`). **`EXEC-MODE-FAIL-OPEN`** (MÉD): `execution-handler.ts:673` default no modo de mutação-real. Backend sempre envia (required). C-02 mata retorno draft. Guardado por `em-03-proposals-end-to-end.test.ts` (não-mergeado). |
| **c** | Léxico `account_id`/`workspace_id` | **`src/` = 0** (`grep -rEn "(account_id\|workspace_id)" src/` = 0 `[✓ 20]`). `resolveOrganizationId` = **0** (bridge colapsada — confirmado `[✓ 20]`). Migrations 001–010 têm `account_id` histórico (superseded por 011, preservado por regra). Resíduo só no openapi request (🔧 `op-openapi-sync` já corrige). |
| **d** | Testes faltando | Suíte **verde: 1236 passed / 57 skipped** (`[✓ 20]`, `vitest run`, exit 0, 190 arquivos). "cobertura mínima" (CLAUDE.md) **super-dimensionado**. **Rede de invariante existe mas NÃO em `main`.** Gaps reais: `state-store.ts` (C-04), `resume-server`/`subscriber` (dead), `error-classifier` input-timeout numérico (CLASSIFIER-TIMEOUT — **sem** fix vivo). **#1 faltante: contract-e2e vs Zod IMPORTADO do backend.** |
| **e** | Dívida conhecida | `grep TODO\|FIXME\|HACK\|XXX\|@deprecated src/` = **6** (`[✓ 20]`, benignos). Dívida real = dead-code (ReWOO waves, Reflexion notes [🔧 op-reasoning-quality], resume-server/subscriber, condense-worker não-deployado). |
| **f** | Migrations accounts(id) FK | **FECHADO** (`[✓ 20]`: `git cat-file -e origin/main:migrations/000_accounts_stub.sql` E `:012_drop_accounts_stub.sql` = presentes; `ls migrations/` = 15 arquivos c/ 000+011+012). **A categoria (f) do prompt E os workarounds do CLAUDE.md (harness+hub) estão OBSOLETOS e CONFLITAM** — remover os passos manuais `CREATE TABLE accounts…; DROP…`. `MIG-DUP013` non-hazard. |
| **g** | MCP server | **Funcional, fail-closed** (`[✓ 20]`: `src/mcp/` = `server.ts`/`client.ts`/`client-registry.ts`/`adapters/`/`mcp-tool-adapter.ts`/`bootstrap.ts`/`health.ts`; `env.ts:86 MCP_EXPOSED_SKILLS` optional, vazio = nada exposto; `send-message`/`request-human` nunca expostos — README `:278-282`). PRD §5.13/§10.3 (não "§212"). Cluster LATENT se exposto (`MCP-MUTATION-UNGATED`). |
| **h** | Callbacks (X-Execution-Token) | **4 endpoints, paridade de SET `[✓ 20]` dos-dois-lados:** harness `updateStatus→/status`(`:141`, **POST — bug C-01**), `sendTrace→/traces`(`:103`), `sendStream→/stream`(`:113`), `sendComplete→/complete`(`:155`); backend serve exatamente `/status`(PATCH,`:57`)/`/traces`(`:88`)/`/stream`(`:110`)/`/complete`(`:139`). **`/artifact`,`/tool-result`,`/turn` do prompt NÃO EXISTEM em NENHUM lado.** Defeitos: **verbo** (`/status` POST vs PATCH = C-01) + **body** de `/complete` (C-02/C-07/CB-NEW-03/AUD-PROPOSAL/USAGE). |
| **i** | Bootstrap stages | **≥9 blocos `name:`** (`[✓ 20]`: infra-check`:177`/load-config`:187`/register-agents`:202`/warmup-pipeline`:280`/load-tools-permissions`:302`/calendar-health`:483`/**start-dev-ws**`:494`/**init-evals**`:508`/start-consumer`:578`) — CLAUDE.md "7" stale. `calendar-health` faz **GET `/health`**(`:485`, `AbortSignal.timeout(5000)`) e **tolera qualquer status HTTP** (só `.catch` em rejeição de rede `:487`). Todos gate por throw. |
| **j** | Alçapões p/ piloto | **MANIFEST-DB-ENV + NO-MIGRATOR = o deploy não sobe/não processa (sem branch, `[✓ 20]` dos-dois-lados).** Depois: **C-01** (raiz sem branch; raio-de-dano mitigado por `finding-j10` não-mergeado), **C-07**, **CP-02+R-01/R-02+REFLEXION** (🔧 fix vivo `op-reasoning-quality`), **CLASSIFIER-TIMEOUT-CRASH** (sem fix vivo), `LLM-MODEL-DOWNGRADE`/`PHASE-TIMEOUT-TERMINAL`/`DOUBLE-COMPLETE-REQHUMAN`, `CAL-*` (se Calendar ligado), `IDOR-read`, `CP-01`, `USAGE-01`, `OBS-OTEL-OFF` (`[✓ 20]` manifest `:146`). |
| **k** | Delta vs audit anterior | **0 CRÍT/ALTO fechados/abertos** (0 commits de produto). Freeze de 3 repos re-provado em disco. **Delta material = `UNMERGED-CONSTELLATION`** (positivo: fixes de produto vivos+verdes fora de `main`, mapeados por-fix). Backend moveu `105fb50`→`6f6867d` (só audit-docs). Demais variações imateriais (§Delta). |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. **NOVO nesta rodada:** distinção explícita entre *MERGEAR/TRIAR* (existe, verde) e *ESCREVER* (sem branch).

0a. **MERGEAR a rede de invariantes já-verde em `main`** (`~0.5-1h`, rebase + CI). Test-only, verde, substrato de regressão para tudo abaixo. Primeiro commit não-doc para `main` desde 2026-06-04.
0b. **META — PAUSAR as auditorias autônomas até haver commit de produto** (`0h`). 14 rodadas sobre código byte-idêntico; valor marginal ≈ 0. Redirecionar o slot diário para (0a)/(0c)/1-3.
0c. **TRIAR a constelação VIVA** (`op-reasoning-quality`, `op-ctx-tokenizer-budget`, `op-pipeline-json-robustness`, `op-openapi-sync`, `finding-j10`) — cherry-pick por-fix, rebase em `main`, resolver a sobreposição em `execution-handler.ts`, CI verde. **Confirmar antes por que travaram ~47d.** Ordem sugerida: `finding-j10` (11 linhas, mitiga C-01) → `op-openapi-sync` (0 src) → `op-pipeline-json-robustness` → `op-ctx-tokenizer-budget` → `op-reasoning-quality` (maior, mais sobreposto). `Eh≈4-8h` de integração (vs muito mais de reescrita).
1. **MANIFEST-DB-ENV — `DATABASE_URL: .optional()` + fallback `?? BEVOX_DB_URL` no `env.ts`** (+ relaxar/suprir `CALENDAR_SERVICE_URL`) (`0.5h`). Fecha o crash-loop sem tocar o hub. **Sem branch — ESCREVER.**
2. **NO-MIGRATOR — copiar `scripts/`+`migrations/`+deps no runner OU job de migração no deploy** (`~1.5h`). **Sem branch — ESCREVER.**
3. **C-01 raiz + C-07 — `/status` por PATCH (helper `patch()`) E clamp de `sentiment`** (`~2h`). C-01 isolado é o maior ROI mas expõe C-07; fecha STATUS-02 de graça. **Sem branch — ESCREVER** (embora `finding-j10` [0c] já neutralize o desfecho fatal do C-01 no caminho `running`). Guardado por `perm-03-ordering`+`x-execution-token-header` (0a).
4. **CLASSIFIER-TIMEOUT-CRASH — `String(e.code ?? "").toUpperCase()`** (`0.25h`). 1 linha, restaura retry + circuit-breaker p/ timeouts de LLM. **Sem fix vivo — ESCREVER.**
5. **STRATEGY-FAILED-AS-DONE — mapear falha genuína p/ desfecho `error`** (`~2h`). Impede que falha transiente vire `done` silencioso.
6. **CP-02 — add `contact_id` ao `conversation` no schema de dispatch do backend + destravar o gate** (`~1-2h` + 1 PR backend). Pré-requisito de TODO valor do ContextBuilder. Guardado por `ctx-02-budget-enforce` (0a).
7. **EXEC-MODE-FAIL-OPEN — default fail-safe (`manual_assisted`) ou required** (`0.5h`). Fecha o buraco de mutação-sem-aprovação vs ADR-018/006.
8. **Leva de endurecimento barata (~3.5h):** `LLM-MODEL-DOWNGRADE` + `NEW-COST-01` (pricing por prefixo → restaura teto J9) + `PHASE-TIMEOUT-TERMINAL` + `DOUBLE-COMPLETE-REQHUMAN`/`WF-*` (`completeSent=true` nas branches terminais) + `MCP-MUTATION-UNGATED` + CI-LINT (`npm run format`) + OBS-OTEL (flip flag manifest `:146`).
9. **C-02 + AUD-PROPOSAL(014) — `idempotency_key` no BODY do proposal + migration 014 admitindo `'proposal'`+`'proposed'`** (`~1h`). Desbloqueia modos draft. Guardado por `em-03-proposals-end-to-end` (0a).
10. **PRD-CONTRACT-E2E-TEST contra os schemas Zod IMPORTADOS do backend** (`~8h`). Pega C-01(verbo)/C-02(key)/C-07(enum)/CB-NEW-03(enum)/CAL(path) num só lugar. **#1 teste faltante.** + rebase/re-review de `fix/sdr-ultrareview-findings` (C-06).

> **Pacotes:** **0a+0c+1-5 ≈ "rede mergeada → constelação triada → deploy sobe, processa, retria timeouts, não mente sobre o desfecho"** (~10-14h, majoritariamente integração de trabalho já-escrito). **+6-9 ≈ endurecimento de piloto** (~7h, ~2 no backend). **+10 ≈ mínimo de piloto + contract-test** (+ 1 PR backend + 1 rebase). **+ ADR-017/019-LGPD + Calendar (CAL-IDOR antes de expor) + LLM-failover + MCP-hardening + streaming ≈ GA.**

---

## Dependências cruzadas

- **hub-infra (`bevox-PRD-consolidation/infra/`)** → **MANIFEST-DB-ENV** (fallback harness-side OU renomear var), **NO-MIGRATOR** (job/assets de migração), **D-05** (`stop_grace_period`), **OBS-OTEL-OFF** (`:146`), **QUEUE-NAME-OBS-TRAP**, **DOC-DRIFT(a)** (hub CLAUDE.md accounts-FK). **P0 operacional — o pacote não sobe sem (1)+(2), que precisam ser ESCRITOS.** Manifest congelado (`fd1373b`; bug relido `[✓ 20]`).
- **bevox-backend** (@ `6f6867d`, congelado a-menos-de-audit-docs) → **CP-02** (add `contact_id`), **CP-01** (janelar histórico), **STRATEGY-FAILED-AS-DONE**, **C-01/STATUS-02/CB-NEW-03** (verbo PATCH `[✓ 20]` + enum abort/dead_letter), **C-02/AUD-PROPOSAL** (`idempotency_key` + `waiting_approval`), **C-07/SENTIMENT** (backend aceita 6), **USAGE/PRD-COST**.
- **Calendar Service / backend Calendar module** → **CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN + CAL-IDOR-XTENANT**: **NÃO expor o Calendar Service antes de threading token + `organization_id` pelo `ToolContext`** — corrigir o contrato sem org-scope transforma o IDOR de latente em CRÍTICO cross-tenant vivo.
- **canon (bevox-knowledge / hub)** @ `0317985` → **EXEC-MODE-FAIL-OPEN** (código diverge da ADR-018 harness / ADR-006 _shared — alinhar código ou emendar ADR), **C-03/RESUME** (promover ADR-012 ao canon), **STREAM-01** (ADR-016), **CENSUS-PRD-STALE** (PRD retroativo defasado do código pós-2026-06-02).
- **Governança de branches** (o nó desta rodada) → **`test/execution-handler-coverage-uplift`** (rede de invariantes verde — **promover a PR/mergear**); **`op-reasoning-quality`/`op-ctx-tokenizer-budget`/`op-pipeline-json-robustness`/`op-openapi-sync`/`finding-j10-running-status`** (fixes VIVOS — **triar/rebase/mergear por-fix**); **`fix/migration-accounts-stub`+`fix/skill-loader-esm-import`+`fix/complete-callback-contract`+`fix/rules-payload-organization-id`** (MORTAS — **deletar**); **rebase+re-review de `origin/fix/sdr-ultrareview-findings`** (real, C-06).

---

## Delta vs audit anterior (07-19)

**Linhagem de tally:** 06-02 `13·20·46·34` → 06-04 `6·17·23·22` → 06-23 `7·~20·~27·~30` → 07-04 `~7·~18·~29·~19` → 07-05 `~8·~15·~27·~22` → 07-07 `~8·~16·~28·~20` → 07-08 `~8·~18·~30·~26` → 07-14 `~8·~18·~32·~28` → 07-15 `~8·~19·~33·~30` → 07-16 `~8·~20·~36·~33` → 07-17 `~8·~21·~42·~36` → 07-18 `~8·~21·~42·~36` → 07-19 `~8·~21·~42·~36` → **07-20 `~8·~21·~42·~36` (INALTERADO)**.

### FECHADOS desde 07-19
**Nenhum.** `git log 2d70002..HEAD` (produto) = vazio; `git diff origin/main..HEAD -- src/ migrations/` = 0 `[✓ 20]`. **Veredito de piloto/GA inalterado e pré-determinado.**

### NOVOS/refinados desde 07-19
1. **`UNMERGED-CONSTELLATION` (refina o `NET-UNMERGED` do 07-19)** — não é UM item fora de `main`, é uma **constelação**: 5 branches VIVAS de fix de produto (`op-*`+`finding-j10`) + a rede de teste + 4 branches MORTAS (`fix/*`). Reframe do gap dominante de *autoria* → *integração*. Detalhe: §"Achado novo".
2. **Verificação cross-repo dos-dois-lados FRESCA `[✓ 20]`** — C-01 (backend `PATCH /status` @ `harness-callbacks.routes.ts:57`) e MANIFEST-DB-ENV (hub manifest omite `DATABASE_URL`+`CALENDAR_SERVICE_URL`) confirmados lendo os repos-alvo, não só o harness.
3. **Backend moveu `105fb50`→`6f6867d`** — mas só com doc de auditoria autônoma (mesma estase; a cadência autônoma é cross-repo).

### Variações time-sensitive (as únicas possíveis em código congelado)
| Métrica | 07-19 | 07-20 (`[✓ 20]`) | Nota |
|---|---|---|---|
| `npm audit --omit=dev` | 32 (28 mod, 4 high) | **32 (28 mod, 4 high)** | idêntico (lockfile congelado) |
| `TODO/FIXME/…` em `src/` | 6 | **6** | idêntico |
| `find tests -name '*.test.ts'` | 190 | **190** | idêntico |
| Suíte `vitest run` | 1236 passed / 57 skipped | **1236 passed / 57 skipped, 0 fail** | verde, re-rodada fresca |
| `git diff origin/main -- src/` | 0 | **0** | freeze intacto (~47d) |
| backend HEAD | `105fb50` | **`6f6867d`** | +audit-docs only |

**Conclusão do delta:** material de produto = **zero**. A mudança de estado acionável é o mapeamento fino da `UNMERGED-CONSTELLATION`. A 14ª rodada não move nenhum gate de piloto/GA por si só.

---

## Correções pendentes ao prompt-mãe e ao CLAUDE.md (byte-verificadas `[✓ 20]`)

1. **prompt-mãe (h)** — "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`": os 3 últimos **não existem em NENHUM dos lados** (`[✓ 20]` harness `bevox-callback.ts` + backend `harness-callbacks.routes.ts`). Reais: `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`.
2. **prompt-mãe (f)** — trata a FK `accounts(id)` como **aberta**: está **FECHADA** (`000`+`012` em `origin/main` por `git cat-file -e` `[✓ 20]`). Remover a pergunta "como fechar definitivamente".
3. **prompt-mãe (g)** — "PRD §212": **fantasma** (o PRD termina no §17 `[✓ 20]`; o gate do piloto é §16; MCP é §5.13/§10.3).
4. **prompt-mãe (b)** — cita "ADR-006 execution_mode": é **_shared/ADR-006** (autonomy-permissions-approval) **E harness/ADR-018** (modos-de-autonomia-execution-mode) — ambos existem no canon `[✓ 20]`; a fail-open diverge de ambos.
5. **CLAUDE.md §Infraestrutura** — accounts-FK workaround obsoleto/conflitante; "Dockerfile single-stage" (é 2-stage `[✓ 20]`); "7 estágios" (**≥9** `[✓ 20]`); "3 agentes" (4, +MemoryCondenser); "HEAD em CALENDAR_SERVICE_URL" (é GET `/health`, tolera 404).
6. **CLAUDE.md** — "cobertura Vitest é mínima": **super-dimensionado** (1236 testes passando `[✓ 20]`; hot-path 97-100%).

---

## Notas de método

**Decisão deliberada de NÃO re-executar o fan-out multi-agente de descoberta.** Com o código **byte-idêntico** re-verificado (`git diff origin/main..HEAD -- src/ migrations/`=0 `[✓ 20]`), um novo fan-out de descoberta reproduziria o mesmo backlog — a **exata inércia** que o prompt-mãe proíbe ("não invocar [agents] por inércia — só os que se aplicam à varredura") e que a memória de projeto (`harness-audit-stasis-pause`) + a recomendação #0 das 4 rodadas anteriores mandam evitar. **A varredura desta rodada foi verificação-de-freeze + git-archaeology + leitura cross-repo, não descoberta de domínio** — nenhum dos agents de domínio (`ai-engineer`/`backend-architect`/`mcp-builder`/`security-engineer`) melhora um fato de `git`. Effort-max foi gasto onde há valor marginal real: o **mapeamento por-fix da constelação não-mergeada** (que nenhum fan-out de leitura de src frozen produziria melhor) + a **verificação dos-dois-lados** dos blockers dependentes de backend/hub.

**O que fiz (tudo `[✓ 20]`, leitura própria nesta sessão):**
- **git-archaeology / freeze:** `git diff origin/main..HEAD -- src/ migrations/`=0; `git rev-list --count main..<branch>` e `git diff --numstat origin/main...<branch> -- src/` p/ cada uma das 10 branches `fix/`/`op-`/`finding-`; leitura dos diffs de `bevox-callback.ts`/`skill-loader.ts`/`react.ts`/`errors.ts`/`execution-handler.ts` nas branches; `git cat-file -e origin/main:migrations/000…/012…`.
- **Suíte:** `npx vitest run` → 173 files / 1236 passed, 17/57 skipped, exit 0 (linhas `level:50` = fixtures negativas propositais).
- **harness em disco:** `env.ts:8-12/203-207`, `Dockerfile:1-18`, `bevox-callback.ts:15/28/103/113/133/141/155`, `execution-handler.ts:565/673`, `bootstrap/stages.ts:177..578` (≥9 stages; calendar-health GET `/health`), `src/mcp/` (server/client/adapters/health), `skill-loader.ts:104` (`await import`), grep lexicon `src/`=0, grep `resolveOrganizationId`=0, grep TODO=6, `ls migrations/`=15.
- **backend em disco (`6f6867d`):** `harness-callbacks.routes.ts:57/88/110/139` (`/status`=**PATCH**; sem `/artifact`,`/tool-result`,`/turn`).
- **hub em disco (`53faef2`):** `bevox-prod-manifest.yaml:105/132/146/155-162` (harness omite `DATABASE_URL`+`CALENDAR_SERVICE_URL`; `OTEL_ENABLED:"false"`; imagem v1.0.0 pinada).
- **canon em disco (`0317985`):** PRD `2026-05-15-…-v1.md` (§§ até 17, sem "212", MCP §5.13/§10.3); `30_adr/bevox-harness/ADR-018` + `30_adr/_shared/ADR-006` (execution_mode).
- **Métricas time-sensitive:** `npm audit --omit=dev` (32), branches `fix/`/`op-` (41).

**Agents locais.** Nenhum agente `.claude/agents/` foi invocado — deliberadamente, alinhado às 4 rodadas anteriores E ao qualificador do próprio prompt-mãe ("só os que se aplicam à varredura"). A próxima invocação de agente de valor é para **IMPLEMENTAR** (0a mergear a rede; 0c triar a constelação viva com `engineering-ai-engineer` p/ `op-reasoning-quality`/`op-ctx-tokenizer-budget` e `engineering-backend-architect` p/ o contrato C-01/CP-02; 1-3 escrever os fixes sem-branch), **não auditar** código congelado.

**Confiança.** Alta em todo achado acionável — cada `arquivo:linha` dos blockers foi lido nesta sessão dos-dois-lados; a constelação é verificada por `git diff --numstat` (fixes NÃO estão em `main`) + leitura dos diffs (fixes fazem o que o nome/commit diz). **Residual/Duvidoso:** (1) `MANIFEST-DB-ENV`/`NO-MIGRATOR` repousam no manifest+runbook do hub — se a Hetzner injeta `DATABASE_URL`/roda `migrate` out-of-band, rebaixa; **confirmar com o dono do hub** (memória `manifest-db-env-deploy-blocker`). (2) por que a `UNMERGED-CONSTELLATION` travou ~47d (PRs em review? nunca promovidas? regressão que motivou abandono?) não é visível em disco — **confirmar com o dono das branches antes de triar** (uma branch pode ter sido abandonada por bom motivo). (3) `CAL-*` dependem do alvo real de `CALENDAR_SERVICE_URL`. (4) escopo do piloto (draft/SDR/teto-de-custo) condiciona C-02..C-06.

**Meta-nota ao revisor humano (14ª rodada, ~47 dias de estase, 0 commit de produto).** Nos últimos ~47 dias, **os únicos commits em harness+backend+canon foram documentos de auditoria autônoma** — três repos gastando o slot diário a relatar em vez de fechar. A cadência de auditoria autônoma é toil de valor marginal decrescente, **auto-confirmado por 5 rodadas consecutivas**. A diferença desta 14ª rodada é que ela **transforma "pausar e escrever tudo" em um plano de integração concreto e barato**: **(0a)** mergear a rede de invariantes verde; **(0c)** triar a constelação de fixes de produto **que já está escrita, verde e apenas não-mergeada** (`op-reasoning-quality`/`op-ctx-tokenizer-budget`/`op-pipeline-json-robustness`/`op-openapi-sync`/`finding-j10`); **(1-3)** escrever os 3 blockers incondicionais sem-branch (`env.ts` fallback ~0.5h; `Dockerfile`/migração ~1.5h; `/status` PATCH + clamp `sentiment` ~2h); **deletar** as 4 branches `fix/*` mortas. **A próxima ação de valor não é uma 15ª auditoria — é o primeiro commit de produto para `main` desde 2026-06-03.** Enquanto o slot diário produzir docs e não código, este relatório e os 13 anteriores dizem a mesma coisa — só que agora com o mapa de integração explícito para encurtar o caminho.
