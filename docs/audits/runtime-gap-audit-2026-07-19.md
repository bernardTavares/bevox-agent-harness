# Gap Analysis — bevox-harness — 2026-07-19

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-07-18.md` (linhagem: `07-18`/`07-17`/`07-16`/`07-15`/`07-14`/`07-08`/`07-07`/`07-05`/`07-04`/`06-23`/`06-04`/`06-02` — esta é a **13ª rodada**).
> **HEAD auditado:** `0884b43` (branch `test/execution-handler-coverage-uplift`) — o próprio commit do doc 07-18. **Zero commits de produto desde 2026-06-03** (`origin/main` @ `2979eb0`); zero commits de qualquer tipo (exceto docs de auditoria) desde **2026-06-04**.
>
> **Freeze re-verificado FRESCO nos 3 repos em disco NESTA sessão (leitura própria, marcada `[✓ 19]` — não citada de memória nem do 07-18):**
> 1. **harness** — `git diff origin/main..HEAD -- src/ migrations/` = **0 linhas** (produto + schema byte-idênticos a `origin/main` @ `2979eb0`, **~46 dias**). `git status` = só `docs/` + `.claude/worktrees/` untracked. **Suíte verde re-rodada:** `vitest run` = **173 files / 1236 tests passed**, 17/57 skipped, **0 falhas**, exit 0 (as linhas `level:50` no output são fixtures de caminho-negativo propositais — poison payloads, "backend down" do teste perm-03, métricas de dead-letter — não erros reais).
> 2. **backend** `bevox-backend` @ `105fb50` (2026-07-07) — congelado; seu próprio último commit é um doc de auditoria autônoma (o cluster inteiro está na mesma estase).
> 3. **hub** `bevox-PRD-consolidation` — manifest `infra/bevox-prod-manifest.yaml` (arquivo last-touched @ `fd1373b`, 2026-06-03; HEAD do repo `53faef2` só mexe em `.claude/`) relido linha-a-linha (bloco `bevox-harness` `:132-162`).
> 4. **canon** `bevox-knowledge` @ `0317985` (2026-06-02) — congelado.
>
> **Método (deliberadamente enxuto — ver §"Notas de método"):** dado o freeze de ~46 dias re-confirmado em 3 repos, **NÃO** re-executei o fan-out multi-agente do 07-17. Isso reproduziria um backlog byte-idêntico e é a exata inércia que o prompt-mãe proíbe ("não invocar [agents] por inércia") e que a memória de projeto + a recomendação #0 das 3 rodadas anteriores mandam evitar. O effort-max desta rodada foi para: (1) **verificação independente de primeira-mão** do cluster de deploy acionável nos 3 repos; (2) o **achado novo desta rodada** — a rede de testes de invariante desta branch está VERDE e **NUNCA foi mergeada em `main`**; (3) a **escalada do meta-achado de processo** (13ª rodada).
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

**Nada de produto mudou em ~46 dias e em nenhum dos 3 repos do contrato; o veredito é pré-determinado e esta 13ª rodada não o altera — PILOTO: NÃO-GO · GA: NÃO-GO.** Os 3 blockers de deploy **incondicionais** (`MANIFEST-DB-ENV`, `NO-MIGRATOR`, `C-01`) foram **re-lidos e hand-verificados FRESCO dos DOIS lados** (harness `env.ts`/`Dockerfile`/`bevox-callback.ts` + hub manifest) nesta sessão e **sobrevivem sem branch de remediação** — precisam ser **ESCRITOS**, não re-auditados. Todo o cluster CRÍTICO/ALTO/MÉDIO/BAIXO do 07-18 (`~8·~21·~42·~36`) sobrevive por construção (código congelado). **0 CRÍTICO/ALTO fechados** (0 commits de produto).

**Achado NOVO desta rodada (o único delta material em 46 dias, e ele é *positivo*):** a branch auditada (`test/execution-handler-coverage-uplift`) carrega uma **rede de 7 testes de invariante de handler + helper compartilhado** (`tests/unit/runtime/invariants/`, `tests/helpers/invariant-harness.ts`) que está **VERDE** e guarda EXATAMENTE as invariantes de hot-path que os fixes de deploy vão tocar — mas **NUNCA foi mergeada em `origin/main`** (`git log origin/main -- tests/unit/runtime/invariants/` = **0**). Ela foi construída em **2026-06-03/04** e está dormente há ~46 dias. Isso **muda a recomendação #0**: não é "pausar e não fazer nada" — é **(0a) mergear a rede de testes já pronta em `main`** (baixo risco, test-only, verde) para servir de rede de segurança, **e então (1-3) landar os 3 fixes de deploy sobre um substrato guardado**.

**O achado dominante continua sendo de PROCESSO.** A 13ª auditoria sobre código byte-idêntico confirma que a cadência autônoma diária virou toil de valor marginal ≈ 0. As 3 rodadas anteriores (07-16/17/18) elevaram "pausar a cadência" a recomendação #0; **eu concordo e a mantenho**, agora refinada com a ação positiva de mergear a rede de testes. Nos últimos ~46 dias, **os únicos commits em qualquer dos 3 repos foram documentos de auditoria autônoma** — o harness, o backend e o canon todos gastam o slot diário gerando relatórios em vez de fechar gaps.

**Correções duráveis re-confirmadas (o prompt-mãe E o CLAUDE.md continuam desatualizados — ver §Correções):** (1) categoria **(f)** trata a FK `accounts(id)` como aberta — **FECHADA** (`000_accounts_stub.sql`+`012_drop_accounts_stub.sql` em disco, `[✓ 19]`); (2) categoria **(h)** cita 4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn` — os 3 últimos **não existem** (`[✓ 19]`); os reais são `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`; (3) **"PRD §212"** é fantasma; (4) "cobertura Vitest é mínima" (CLAUDE.md) é **super-dimensionado** — **1236 testes passando**, hot-path 97-100%.

---

## Achados por severidade

> Convenção: `arquivo:linha` no HEAD `0884b43`. **`[✓ 19]`** = **lido e hand-verificado por mim NESTA sessão (2026-07-19)**, em disco — não citado de memória nem de auditoria anterior. `SOBREVIVE` = re-aberto e confirmado por freeze de código. `Eh` = esforço estimado. Para o detalhe exaustivo item-a-item do latent-tail herdado, ver `runtime-gap-audit-2026-07-17.md` §"Achados por severidade" (não re-derivado aqui por disciplina anti-toil; o freeze garante paridade 1:1).

### 🔴 CRÍTICO — bloqueia o piloto

> Nenhum tem branch de remediação em voo. Os 3 incondicionais foram **re-lidos linha-a-linha dos dois lados nesta sessão `[✓ 19]`**.

#### Incondicionais (bloqueiam o piloto em QUALQUER escopo)

- **MANIFEST-DB-ENV (SOBREVIVE, `[✓ 19]` harness + hub) — o pacote de deploy pinado crash-loopa no boot.**
  Harness `src/config/env.ts` (relido): `:8 DATABASE_URL: z.string().url()` **(required)**, `:11 BEVOX_DB_URL: z.string().url().optional()` **(opcional; grep confirma que `src/` nunca a lê — o pool sempre usa `env.DATABASE_URL`)**, `:12 CALENDAR_SERVICE_URL: z.string().url()` **(required)**.
  Hub `infra/bevox-prod-manifest.yaml` (bloco `bevox-harness` `:132`, relido): supre `BEVOX_DB_URL`(`:155`) + `REDIS_URL`(`:156`) + `BEVOX_CALLBACK_BASE_URL`(`:157`) + `BEVOX_DEFAULT_ORGANIZATION_ID`(`:158`) + chaves LLM, mas **OMITE `DATABASE_URL` E `CALENDAR_SERVICE_URL`** (o `DATABASE_URL:` em `:105` está no bloco **backend**, não harness). Imagem pinada `sha256:b4c66bb…` = **v1.0.0 runtime (2026-06-01)** — anterior até ao baseline do freeze.
  → `getEnv()` `safeParse` (`env.ts`) falha em 2 required → `process.exit(1)` **antes do stage 1** → 2 réplicas em crash-loop → 0 jobs consumidos → 100% backend 120s-timeout→handoff. **Fix harness-side ~1 linha:** aceitar `DATABASE_URL ?? BEVOX_DB_URL` (tornar `DATABASE_URL` `.optional()` com refino) + suprir/relaxar `CALENDAR_SERVICE_URL` (o stage `calendar-health` já aceita 404). `Eh≈0.5h`. **Sem branch.**
- **NO-MIGRATOR (SOBREVIVE, `[✓ 19]`) — o schema do harness nunca é criado no deploy pinado.**
  `Dockerfile` (relido, **2-stage**): `builder`(`:1`) copia `src`(`:6`)+`scripts`(`:7`) e roda `npm run build`(`:8`); `runner`(`:10`) copia **só** `COPY --from=builder /app/dist ./dist`(`:16`) → `migrations/` E `scripts/migrate.mjs` estão **fisicamente ausentes** da imagem de prod (`CMD ["node","dist/index.js"]` `:18`; nem `docker exec` migraria). O manifest não tem sidecar de migração para o harness. **CLAUDE.md §Infra diz "Dockerfile single-stage (sem split runtime/migrator)" — FALSO** (é 2-stage; essa misdescrição é a raiz da confusão). **Fix:** copiar `scripts/`+`migrations/`+deps no runner OU job de migração no deploy. `Eh≈1.5h`. **Sem branch.**
- **C-01 (SOBREVIVE, `[✓ 19]` harness) — `updateStatus` por POST contra rota PATCH-only → 404 mata TODA execução do caminho genérico.**
  Harness `src/integration/bevox-callback.ts` (relido): helper `post()`(`:15`) crava `method:"POST"`(`:28`); `updateStatus`(`:133`) chama `post('/api/v1/executions/${id}/status', ...)`(`:141`). Backend (07-18, dois lados) serve `PATCH /api/v1/executions/:id/status`. `await updateStatus(...,"running")` é o 1º `await` do try genérico → 404 → error-boundary → desfecho `done` silencioso (via `STRATEGY-FAILED-AS-DONE`). Os outros 3 verbos batem: `sendTrace→POST /traces`(`:103`), `sendStream→POST /stream`(`:113`), `sendComplete→POST /complete`(`:155`). `Eh≈1h` (co-fixar com C-07).
  - **STATUS-02 (SOBREVIVE)** — o mesmo POST-vs-PATCH mata o `dead_letter` autoritativo (`updateStatus(...,"dead_letter")` 404a → UI de replay nunca acende). Fechado ao corrigir o C-01.
- **C-07 (SOBREVIVE) — `sentiment` da pipeline não-validado → `/complete` 400 em output malformado (co-fix obrigatório do C-01).** Enum backend = 6 valores; `message-analyzer.agent.ts` faz cast cru (`JSON.parse(...) as ClassificationOutput`) — só valor fora-dos-6 400a. Mascarado hoje pelo C-01. Fix: `safeParse`+clamp. `Eh≈1-2h`.

#### Condicionais ao escopo do piloto (CRÍTICO **se** o piloto inclui modos draft e/ou cadência SDR; senão ALTO)

> **Ação ao revisor: confirmar se o piloto usa `manual_assisted`/`copilot` (aciona C-02/AUD-PROPOSAL) ou a esteira SDR/Model-C (aciona C-03..C-06).**

- **C-02 (SOBREVIVE) — `proposals[]` sem `idempotency_key` → `/complete` 400 nos modos draft.** `ProposalSchema.idempotency_key` é required no backend; o `extractProposal` do harness hoista `{action, params}` sem a key. `Eh≈0.5h`.
- **C-03 (SOBREVIVE) — esteira SDR/cadência/Model-C/resume morta na fiação viva.** `scheduler.agent.ts` não declara `workflow:` → porta START inalcançável; `resume-server.ts`/`subscriber.ts` dead-code (`WORKFLOW_RESUME_ENABLED` default-off). `Eh≈6-8h`.
- **C-04 (SOBREVIVE) — timeout de não-resposta marca cadência `failed` em vez de avançar.** `state-store.ts` (`claimForExpiry`→`SET status='failed'`). Cobertura real 0%. `Eh≈4-6h`.
- **C-05 (SOBREVIVE) — Model-C sem error boundary + dedup key retida → execução permanentemente perdida.** `dispatchModelC` roda ANTES do único try; o único `del(dedupKey)` vive no catch nunca-entrado → re-entrega bate no `SET NX` → return silencioso. `Eh≈3-5h`.
- **C-06 (SOBREVIVE) — respostas vivas nunca qualificam lead nem honram opt-out (risco LGPD).** `execution-handler.ts` crava `observedSignals:{}`. A substância do fix vive UNMERGED em `origin/fix/sdr-ultrareview-findings`. `Eh≈8h`.

### 🟠 ALTO — bloqueia GA, não necessariamente o piloto

> Cluster do 07-17/07-18, SOBREVIVE integralmente (código congelado). Resumo — detalhe completo no 07-17 §ALTO.

- **CLASSIFIER-TIMEOUT-CRASH (SOBREVIVE)** — `error-classifier.ts` faz `(e.code ?? "").toUpperCase()`; o `.code` de um `DOMException{name:"TimeoutError"}` (de `AbortSignal.timeout`) é numérico → `TypeError` numa função que promete "Never throws". → timeouts de LLM nunca retried e breaker cego a timeouts. **Fix 1 linha (`String(e.code ?? "")`), maior ROI técnico da lista.** `Eh≈0.25h`.
- **STRATEGY-FAILED-AS-DONE (SOBREVIVE)** — falha genérica finalizada como `done` (`/complete{responseText:"", strategy:"failed"}` in-enum → 200; backend trata texto vazio como skip que mantém `done`). Sink do CLASSIFIER-TIMEOUT e do PHASE-TIMEOUT. `Eh≈2h`.
- **CP-02 (SOBREVIVE, cross-repo) — `contact_id` NÃO existe no contrato de dispatch → ContextBuilder inteiro pulado em 100% dos jobs.** Backend `harness-dispatch.schema.ts`: `conversation:{id, channel_account_id}`, `context:{...}` — **`contact_id` ausente em ambos**. Pré-requisito de TODO valor do ContextBuilder e do fix do IDOR-read. `Eh≈1-2h` + 1 PR backend.
- **CP-01 (SOBREVIVE) — backend despacha histórico ilimitado; harness poison-dropa além do cap.** Backend `messages.min(1)` sem LIMIT; harness `messages.max(100)` → `UnprocessablePayloadError` (poison, sem retry/`/complete`; `dead_letter` 404a). `Eh≈2-4h`.
- **CB-NEW-03 (SOBREVIVE) — abort J8 emite `strategy` off-enum → `/complete` 400 engolido.** `strategy` enum backend não inclui `aborted_timeout`/`aborted_cost`. `Eh≈1h`.
- **R-01 / R-02 (SOBREVIVEM) — loop ReAct não devolve observações ao LLM, e a escalação p/ plan-execute é natimorta (`fix/issue-47` só carimba PlanExecute).** Maior risco de QUALIDADE do piloto (default-ON). `Eh≈3-5h` + `2-3h`. **Guardado por `engine-swap-mid-loop.test.ts` (rede não-mergeada — ver §NOVO).**
- **CAL-IDOR-XTENANT + CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN (SOBREVIVEM, LATENT)** — surface de calendário confia em `appointment_id`/`calendar_id` do LLM sem org-scope nem token; paths não-org-scoped 404am no backend. Gated hoje pela ausência de Calendar Service no MVP → **vira CRÍTICO cross-tenant ao corrigir o contrato sem adicionar org-scope+token.** `Eh≈1-2h` + Médio.
- **IDOR-CONTACT-PARAM (SOBREVIVE) — `read-profile` confia no `contact_id` do LLM → exfiltração de PII intra-org.** Boundary de org SEGURO (repo scoped por `organizationId`). Fix depende de CP-02. `Eh≈0.5-1h`.
- **REFLEXION-NOTES-UNREAD · REWOO-UNREACHABLE · CTX-RULES/HISTORY-DEAD · AUTHZ-ALLOWLIST · AUD-PROPOSAL-CHECK(014) · USAGE-01 · OBS-LLM-METRICS/OBS-OTEL-OFF/LLM-NO-FAILOVER · D-01/D-05 · PRD-ADR017-OWNERSHIP/ADR020-LGPD-ORPHAN · STREAM-01/RAG-NO-RUNTIME-INDEXER/MCP-cluster** (SOBREVIVEM, vários LATENT atrás de flags/contratos). `OBS-OTEL-OFF` re-confirmado `[✓ 19]` no manifest (`:146 OTEL_ENABLED:"false"`). Detalhe no 07-17.

### 🟡 MÉDIO — degrada qualidade (SOBREVIVEM do 07-17/07-18)

- **EXEC-MODE-FAIL-OPEN (SOBREVIVE, vs canon) — `execution_mode` cai default no ÚNICO modo de mutação real, contra a ADR-018 "obrigatório".** `execution-handler.ts` (`ExecutionModeSchema.optional().default("autonomous_supervised")`). Backend **sempre envia** (required) mas o schema do harness inverte a garantia — um replay/legado que omita executa create/cancel/send **sem aprovação**. Fix: required (fail-closed) OU default `manual_assisted` (fail-safe). `Eh≈0.5h`.
- **Demais MÉD (SOBREVIVEM):** `NEW-CTX-01` (budget conta schemas-fantasma), `MCP-MUTATION-UNGATED` (mutações de calendário via MCP mode-less/unthrottled/unaudited), `CB-BASEURL-IGNORED` (backend envia `callback_base_url` required, harness parseia e nunca lê), `USAGE-TABLE-DEAD` (PRD §5.17 — `execution_usage` nunca escrita), `WF-COMPLETE-DOUBLE`/`WF-SUSPEND-CLOSES`, `DOUBLE-COMPLETE-REQHUMAN`, `PHASE-TIMEOUT-TERMINAL`, `LLM-MODEL-DOWNGRADE`, `IDOR-WRITE`(inalcançável), `SYNTH-STOP-REACT-ONLY`, `IDEMP-NONDET-PARAMS`, `CP-03`, `TRUNC-DOCTRINE-DROP`, `TOKENIZER-UNDERCOUNT`, `CALENDAR-NO-RETRY`, `QUEUE-NAME-OBS-TRAP`, `D-02`/`D-03`, `MEM-INDEXER-DUP`, `MEM-CONDENSE-NO-CONSUMER`, `CTX-SILENT-DEGRADE`/`TRACES-01`/`STATUS-01-PAUSED`, `SEC-AUDIT-RED`, `CI-LINT-RED`. Detalhe no 07-17.

### 🟢 BAIXO — higiene (SOBREVIVEM do 07-17/07-18)

- **DOC-DRIFT (SOBREVIVE, `[✓ 19]` re-confirma `CLAUDE.md` §Infraestrutura):** (a) accounts-FK trap descrito ABERTO com workaround `CREATE TABLE accounts...; DROP...` — **OBSOLETO e CONFLITA** com `000_accounts_stub.sql`+`012_drop_accounts_stub.sql` (relidos em disco `[✓ 19]` — trap FECHADO); (b) "Dockerfile single-stage" — FALSO (2-stage); (c) "7 estágios"; (d) "3 agentes" (4, +MemoryCondenser); (e) `calendar-health` "faz HEAD" — é GET `/health` e aceita 404. `Eh≈1h`.
- **OPENAPI drift (SOBREVIVE):** `SENTIMENT-ENUM-DOC-DRIFT` (openapi lista 3, backend aceita 6); `OPENAPI-REQUEST-LEXICON-STALE` (request ainda `account_id`/`account`, sem `organization_id`/`execution_mode`); `OPENAPI-COMPLETE-FIELD-DRIFT` (`response` vs `response_text`). `Eh≈S`.
- **MARCO1-VERSIONING / MARCO1-OPENAPI-GAP · CENSUS-PRD-STALE (SOBREVIVEM):** payload sem campo de versão; PRD §5.1 `HARNESS_QUEUE_NAME` stale, §11.1 "7 migrations" (real: 14 arquivos 000–013, dois `013_`), §11 ainda `account_id`. **Código é o lado correto.** `Eh≈2h`.
- **Demais BAIXO (SOBREVIVEM):** `WORKFLOW-FWD-DEAD`, `PERM-BLACKLIST-ORPHAN` (`account_denied_tools` ausente do `dispatch.schema.ts` → blacklist inbound morta; Layer-2 enforça só via complemento do allowlist `skills`), `NEW-RWO-01`, `NEW-3`, `CP-04`, cluster de testes-máscara, `OBS-REDACT-SHALLOW`, `MIG-DUP013` (non-hazard), `ACCOUNT-LEXICON` (`src/`=**0** `[✓ 19]`).

---

## 🆕 Achado novo desta rodada — rede de invariantes VERDE não-mergeada (o único delta material em ~46 dias)

**`NET-UNMERGED` (NOVO, `[✓ 19]`, severidade: oportunidade ALTA / dívida BAIXA).** A branch auditada é `test/execution-handler-coverage-uplift` (30 commits à frente de `origin/main`: 13 docs de auditoria + **17 commits de teste** datados **2026-06-03/04**). Ela contém uma rede de regressão de invariantes de handler que **está verde na suíte** mas **nunca entrou em `origin/main`** (`git log origin/main -- tests/unit/runtime/invariants/` = **0**; `git log origin/main -- tests/helpers/invariant-harness.ts` = 0). Arquivos:

| Teste | Invariante guardada | Blindaria o fix de |
|---|---|---|
| `perm-03-ordering.test.ts` | audit é escrito mesmo quando `sendComplete` lança | C-01/STATUS-02 (ordem audit-antes-callback) |
| `x-execution-token-header.test.ts` | `X-Execution-Token` em TODO callback outbound | C-01 (contrato de callback) |
| `em-03-proposals-end-to-end.test.ts` | tool propose chega em `/complete.proposals[]` | C-02 (modos draft) |
| `proposals-accumulator-isolation.test.ts` | proposals isolados entre execuções (seq + concorrente) | acumulador per-execução |
| `ctx-02-budget-enforce.test.ts` | `enforceBudget` roda antes do surface loop; prompt trimado chega ao engine | CP-02 / NEW-CTX-01 (ContextBuilder) |
| `engine-swap-mid-loop.test.ts` | observações preservadas na escalação de engine | R-01/R-02 (ReAct→PlanExecute) |
| `otel-root-span-hierarchy.test.ts` | um root span `execution.handle` carrega `execution.id`, resto descende | OBS-OTEL |

Além disso, `scripts/smoke/01-execution-roundtrip.{ts,sh}` + `README.md` dão um **round-trip local via BullMQ** (enqueue → worker consome → `job.getState()==="completed"`), com exit codes discriminados (0 completed / 1 failed / 2 timeout / 3 erro). É a exata ferramenta de verificação manual para os fixes de deploy pós-`docker:up`, e aponta para as smokes de cluster do hub (`bevox-PRD-consolidation/scripts/smoke/01..16-*.sh`) como o gate pós-deploy.

**Impacto:** `main` hoje NÃO tem essas guardas — os fixes de deploy (itens 1-3) landariam sem rede. A rede já existe, verde, e cobre precisamente os invariantes que os fixes tocam. **Mergear a rede é baixo risco (test-only, verde), alto valor (substrato de regressão), e é o primeiro "commit não-doc para `main` desde 2026-06-04".** É por isso que a recomendação #0 vira **0a (mergear a rede) + 0b (pausar a cadência de auditoria)**, não só "pausar".

**Duvidoso/verificar:** a rede vive numa branch chamada `test/...` — presumivelmente uma PR aberta que travou em review, OU trabalho local que nunca virou PR. **Ação ao revisor: promover essa branch a PR mergeável (rebase em `main`, CI verde) antes/junto do primeiro fix de deploy.** Confirmar que não há razão de review pendente que a bloqueou (a suíte passa 100% nesta sessão).

---

## Cobertura por categoria do prompt (a–k)

| Cat | Tema | Veredito desta rodada (2026-07-19) |
|---|---|---|
| **a** | PRD vs implementado | PRD v1.1 (retroativo, 2026-05-15) majoritariamente em sincronia com o código expandido (MCP/RAG/workflow/OTel/security/streaming/evals presentes). Gate do piloto = **§16.1 "EM ANDAMENTO"** (NÃO cumprido): falta contrato versionado, contract-test e2e, OpenAPI atualizado. Vários itens de §15/§16 já FECHARAM pós-PRD (idempotência sha256/ADR-023, execution_mode 3-modos/EM-03, `max_cost_usd`/J9, PERM-05, organization_id/ADR-019) — o PRD é o lado stale nesses. **"PRD §212" do prompt = fantasma** (PRD termina §17). |
| **b** | execution_mode (ADR-018) | 3 modos (`manual_assisted`/`copilot`/`autonomous_supervised`) parseados, propagados (`AgentExecutionContext.executionMode`→`mutationExecute`→`executeOrPropose`) e alcançáveis. **`EXEC-MODE-FAIL-OPEN`** (MÉD): default no modo de mutação-real contra ADR-018 "obrigatório". Backend sempre envia (required). C-02 mata retorno draft; AUD-PROPOSAL(014) mata auditoria draft. **`em-03-proposals-end-to-end.test.ts` guarda o caminho (rede não-mergeada).** |
| **c** | Léxico `account_id`/`workspace_id` | **`src/` = 0** (`[✓ 19]` fresco). `workspace_id`=0. `resolveOrganizationId`=**0** (bridge colapsada — **confirmado `[✓ 19]`**). Migrations 001–010 têm `account_id` histórico (superseded por 011, preservado por regra). Resíduo só no **openapi request** (doc-drift, não regressão). |
| **d** | Testes faltando | Suíte **verde: 1236 passed / 57 skipped** (`[✓ 19]`, `vitest run`, exit 0, 190 arquivos `.test.ts`). **"cobertura mínima" (CLAUDE.md) super-dimensionado** — hot-path 97-100%. **Rede de invariante existe mas NÃO em `main` (`NET-UNMERGED`).** Gaps reais: `state-store.ts`, `resume-server`/`subscriber` (dead), input-timeout numérico do `error-classifier`, caminhos Redis-blip dos `WF-*`. **#1 faltante: contract-e2e vs Zod IMPORTADO do backend** (pegaria C-01/C-02/C-07/CB-NEW-03 num lugar). |
| **e** | Dívida conhecida | `grep TODO\|FIXME\|HACK\|XXX\|@deprecated src/` = **6** (`[✓ 19]`, todos benignos: `TODO C13` usage em `bevox-callback.ts:86`, "TODOS" pt-BR falso-positivo em `memory-condenser.prompt.ts:23`, `TODO abort` em `errors.ts:23`, 3 `@deprecated` shims em `harness.ts:39/48/60`). Dívida real = dead-code (ReWOO waves, Reflexion notes, resume-server/subscriber, condense-worker não-deployado). |
| **f** | Migrations accounts(id) FK | **FECHADO** (`[✓ 19]`: `000_accounts_stub.sql` + `011_organization_id_tenancy.sql` + `012_drop_accounts_stub.sql` em disco). **A categoria do prompt E os workarounds do CLAUDE.md (harness E hub) estão OBSOLETOS e CONFLITAM** — remover os passos manuais `CREATE TABLE accounts...; DROP...`. `MIG-DUP013` (dois `013_`) non-hazard (`migrate.mjs .sort()` no filename full; tocam tabelas disjuntas). |
| **g** | MCP server (bevox-mcp) | **Funcional, fail-closed** (`[✓ 19]`: `src/mcp/` completo — `server.ts`, `client.ts`, `client-registry.ts`, `adapters/`, `transports/`, `bootstrap.ts`, `health.ts`; `MCP_EXPOSED_SKILLS` optional, **vazio = nada exposto**; `send-message`/`request-human` nunca expostos). Cluster de segurança LATENT se exposto (`MCP-MUTATION-UNGATED`). PRD §5.13/§10.3 (não "§212", que é fantasma). |
| **h** | Callbacks (X-Execution-Token) | **4 endpoints reais** (`[✓ 19]` harness): `updateStatus→/status`(`:141`, POST — **bug C-01**), `sendTrace→/traces`(`:103`), `sendStream→/stream`(`:113`), `sendComplete→/complete`(`:155`). **`/artifact`,`/tool-result`,`/turn` do prompt NÃO EXISTEM.** Paridade quebrada por **C-01** (verbo `/status`: harness POST vs backend PATCH) + cluster `/complete` (C-02/C-07/CB-NEW-03/AUD-PROPOSAL/USAGE) + OPENAPI-COMPLETE-FIELD-DRIFT. **`x-execution-token-header.test.ts` guarda o header em todo callback (rede não-mergeada).** |
| **i** | Bootstrap stages | Mais que "7" blocos `name:` (DOC-DRIFT). `calendar-health` faz **GET `/health` e aceita 404** (só `.catch` em rejeição de rede). Todos gate por `process.exit(1)` em throw. |
| **j** | Alçapões p/ piloto | **MANIFEST-DB-ENV + NO-MIGRATOR = o deploy não sobe/não processa (sem branch, `[✓ 19]`).** Depois: **C-01 → `done` fantasma** (+C-07), **CP-02+R-01/R-02+REFLEXION = qualidade quebrada**, **CLASSIFIER-TIMEOUT-CRASH**, `LLM-MODEL-DOWNGRADE`/`PHASE-TIMEOUT-TERMINAL`/`DOUBLE-COMPLETE-REQHUMAN`, `CAL-*` (se Calendar Service ligado), `IDOR-read`, `CP-01`, `USAGE-01`, `OBS-OTEL-OFF` (`[✓ 19]` manifest `:146`). |
| **k** | Delta vs audit anterior | **0 CRÍT/ALTO fechados/abertos** (0 commits de produto). Freeze de 3 repos re-provado em disco. **Único delta material = `NET-UNMERGED` (positivo: rede de teste pronta, verde, fora de `main`).** Demais variações só em métricas time-sensitive imateriais (§Delta). |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. **Itens 1-3 NÃO têm branch — precisam ser ESCRITOS. Item 0a JÁ EXISTE — precisa ser MERGEADO.**

0a. **NOVO — MERGEAR a rede de invariantes já-verde em `main`** (`~0.5-1h`, rebase + CI). Test-only, verde, cobre C-01/C-02/CP-02/R-01/OBS. Primeiro commit não-doc para `main` desde 2026-06-04 e o substrato de regressão para os itens 1-3. Ver §"Achado novo".
0b. **META — PAUSAR as auditorias autônomas até haver commit de produto** (`0h`). 13 rodadas sobre código byte-idêntico re-derivam o mesmo backlog; valor marginal ≈ 0. Redirecionar o slot autônomo diário para MERGEAR (0a) e ESCREVER os itens 1-3.
1. **MANIFEST-DB-ENV — fallback `DATABASE_URL ?? BEVOX_DB_URL` no `env.ts`** (+ suprir/relaxar `CALENDAR_SERVICE_URL`) (`0.5h`). Fecha o crash-loop sem tocar o hub. **Sem branch.**
2. **NO-MIGRATOR — copiar `scripts/`+`migrations/`+deps no runner OU job de migração no deploy** (`~1.5h`). Sem schema, nada PG-backed funciona. **Sem branch.**
3. **C-01 + C-07 juntos — `/status` por PATCH E clamp de `sentiment`** (`~2h`). C-01 isolado é o maior ROI mas expõe C-07; corrige STATUS-02 de graça E neutraliza o `STRATEGY-FAILED-AS-DONE` no caminho `running`. **Guardado por `perm-03-ordering` + `x-execution-token-header` (0a).**
4. **CLASSIFIER-TIMEOUT-CRASH — `String(e.code ?? "").toUpperCase()`** (`0.25h`). 1 linha restaura retry E accounting de circuit-breaker p/ timeouts de LLM.
5. **STRATEGY-FAILED-AS-DONE — mapear falha genuína p/ desfecho `error`** (`~2h`). Impede que falha transiente vire `done` silencioso + retry-storm.
6. **CP-02 — add `contact_id` ao `conversation` no `harness-dispatch.schema.ts` do backend + destravar o gate** (`~1-2h` + 1 PR backend). Pré-requisito de TODO valor do ContextBuilder E do fix do IDOR-read. **Guardado por `ctx-02-budget-enforce` (0a).**
7. **R-01 + completar R-02 — threading de observações no `step()` do ReAct + carimbar obs ReAct com `planGeneration`** (`~5-8h`). O fix `issue-47` entrou pela metade. **Guardado por `engine-swap-mid-loop` (0a).**
8. **Leva de endurecimento barata (~3.5h):** `LLM-MODEL-DOWNGRADE` + `NEW-COST-01` (pricing por prefixo → restaura teto J9) + `PHASE-TIMEOUT-TERMINAL` + `DOUBLE-COMPLETE-REQHUMAN`/`WF-COMPLETE-DOUBLE`/`WF-SUSPEND-CLOSES` (`completeSent=true` nas 4 branches terminais) + `EXEC-MODE-FAIL-OPEN`/`MCP-MUTATION-UNGATED` (default fail-safe) + `NEW-CTX-01` + CI-LINT (`npm run format`) + OBS-OTEL (flip flag `:146`).
9. **C-02 + AUD-PROPOSAL(014) — `deriveIdempotencyKey` no BODY do proposal + migration 014 admitindo `'proposal'`+`'proposed'`** (`~1h`). Desbloqueia modos draft + `waiting_approval` + auditoria draft. **Guardado por `em-03-proposals-end-to-end` (0a).**
10. **PRD-CONTRACT-E2E-TEST contra os schemas Zod IMPORTADOS do backend** (`~8h`). Pega C-01(verbo)/C-02(key)/C-07(enum)/CB-NEW-03(enum)/CAL(path)/SENTIMENT num só lugar. **#1 teste faltante.** + rebase/re-review de `fix/sdr-ultrareview-findings` (C-06).

> **Pacotes:** **0a+1-5 ≈ "rede mergeada → deploy sobe, processa, retria timeouts, não mente sobre o desfecho"** (~7h harness-side). **+6-9 ≈ endurecimento de piloto** (~21h, ~2 no backend). **+10 ≈ mínimo de piloto + rede de teste de contrato** (~29h + 1 PR backend + 1 rebase). **+ ADR-017/020 + Calendar (CAL-IDOR-XTENANT antes de expor o Calendar Service) + LLM-failover + MCP-hardening + streaming ≈ GA.**

---

## Dependências cruzadas

- **hub-infra (`bevox-PRD-consolidation/infra/`)** → **MANIFEST-DB-ENV** (renomear var ou fallback harness-side), **NO-MIGRATOR** (job/assets de migração), **D-05** (`stop_grace_period`), **OBS-OTEL-OFF** (`:146`), **QUEUE-NAME-OBS-TRAP**, **DOC-DRIFT(a)** (hub CLAUDE.md accounts-FK). **P0 operacional — o pacote não sobe sem (1)+(2), que precisam ser ESCRITOS.** Manifest last-touched @ `fd1373b` (congelado; bug presente, relido `[✓ 19]`).
- **bevox-backend** → **CP-02** (add `contact_id`), **CP-01** (janelar histórico), **STRATEGY-FAILED-AS-DONE**, **C-01/STATUS-02/CB-NEW-03** (verbo PATCH + enum abort/dead_letter), **C-02/AUD-PROPOSAL** (`idempotency_key` + `waiting_approval`), **C-07/SENTIMENT** (alinhar SPEC ao código — backend aceita 6), **USAGE/PRD-COST** (`cost_usd`). Backend congelado @ `105fb50`.
- **Calendar Service / backend Calendar module** → **CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN + CAL-IDOR-XTENANT**: confirmar o alvo de `CALENDAR_SERVICE_URL` e **NÃO expor o Calendar Service antes de threading token + `organization_id` pelo `ToolContext`** — corrigir o contrato sem org-scope transforma o IDOR de latente em CRÍTICO cross-tenant vivo.
- **canon (bevox-knowledge / hub)** → **EXEC-MODE-FAIL-OPEN** (código diverge da ADR-018 — alinhar código ou emendar ADR), **C-03/RESUME** (promover ADR-012 ao canon), **STREAM-01** (ADR-016), **CENSUS-PRD-STALE** (PRD retroativo defasado do código pós-2026-06-02). Canon congelado @ `0317985`.
- **Governança de branches** → **`test/execution-handler-coverage-uplift`** (esta branch: 30 commits à frente, rede de invariantes verde não-mergeada — **promover a PR**); **41 refs `fix/*`/`op-*`** (local+remote; muitas já-em-`main` por patch-id — deletar); **rebase+re-review de `origin/fix/sdr-ultrareview-findings`** (real, C-06).

---

## Delta vs audit anterior (07-18)

**Linhagem de tally:** 06-02 `13·20·46·34` → 06-04 `6·17·23·22` → 06-23 `7·~20·~27·~30` → 07-04 `~7·~18·~29·~19` → 07-05 `~8·~15·~27·~22` → 07-07 `~8·~16·~28·~20` → 07-08 `~8·~18·~30·~26` → 07-14 `~8·~18·~32·~28` → 07-15 `~8·~19·~33·~30` → 07-16 `~8·~20·~36·~33` → 07-17 `~8·~21·~42·~36` → 07-18 `~8·~21·~42·~36` → **07-19 `~8·~21·~42·~36` (INALTERADO)**.

### FECHADOS desde 07-18
**Nenhum.** `git log 0884b43..HEAD` (produto) = vazio; código, contrato e manifest congelados idênticos nos 3 repos em disco. **Veredito de piloto/GA inalterado e pré-determinado.**

### NOVOS desde 07-18
**Um, e é positivo/oportunidade — `NET-UNMERGED`** (§"Achado novo"): a rede de invariantes verde da branch nunca entrou em `main`. Não é um bug de produto novo (código congelado); é dívida de integração + a alavanca que refina a recomendação #0 para "mergear + pausar". Os 9 NOVOS do 07-17 (`NEW-COST-01`, `NEW-CTX-01`, `MCP-MUTATION-UNGATED`, `CB-BASEURL-IGNORED`, `USAGE-TABLE-DEAD`, `WF-*`, `WORKFLOW-FWD-DEAD`, `PERM-BLACKLIST-ORPHAN`, `NEW-RWO-01`) sobrevivem inalterados.

### Variações time-sensitive (as únicas possíveis em código congelado)
| Métrica | 07-18 | 07-19 (`[✓ 19]`) | Nota |
|---|---|---|---|
| `npm audit` runtime | 32 (28 mod, 4 high) | **32 (28 mod, 4 high)** | idêntico (lockfile congelado) |
| `TODO/FIXME/...` em `src/` | 6 | **6** | idêntico (verbatim listados em §cat e) |
| `find tests -name '*.test.ts'` | 190 | **190** | idêntico |
| `prettier --check src/**/*.ts` | ~12 (tree total) | **0 (só `src/`)** | `src/` limpo; a contagem anterior incluía docs/tests |
| refs `fix/`/`op-` | 41 | **41** | idêntico |
| Suíte `vitest run` | 1236 passed / 57 skipped | **1236 passed / 57 skipped, 0 fail** | verde, re-rodada fresca |

**Conclusão do delta:** material de produto = **zero**. A única mudança de estado acionável é `NET-UNMERGED` (dívida de integração positiva). A 13ª rodada não move nenhum gate de piloto/GA por si só.

---

## Correções pendentes ao prompt-mãe e ao CLAUDE.md (byte-verificadas `[✓ 19]` — a corrigir ANTES da próxima rodada, se houver)

1. **prompt-mãe (h)** — "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`": os 3 últimos **não existem** (`bevox-callback.ts` só exporta `/status`,`/traces`,`/stream`,`/complete`). Reais: `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`.
2. **prompt-mãe (f)** — trata a FK `accounts(id)` como **aberta**: está **FECHADA** (`000`+`012` em disco, PR #25). Remover a pergunta "como fechar definitivamente".
3. **prompt-mãe (g)** — "PRD §212": **fantasma** (o PRD termina no §17; o gate do piloto é §16.1; MCP é §5.13/§10.3).
4. **CLAUDE.md §Infraestrutura** — accounts-FK workaround obsoleto e conflitante; "Dockerfile single-stage" (é 2-stage `[✓ 19]`); "7 estágios"; "3 agentes" (4, +MemoryCondenser); "HEAD em CALENDAR_SERVICE_URL" (é GET `/health`, aceita 404).
5. **CLAUDE.md** — "cobertura Vitest é mínima": **super-dimensionado** (1236 testes passando `[✓ 19]`; hot-path 97-100%).

---

## Notas de método

**Decisão deliberada de NÃO re-executar o fan-out multi-agente.** O 07-17 rodou 5 subagentes (~458K tokens) e concluiu, com evidência, que a superfície de bug ATIVA na hot-path está exaurida e que a cadência virou toil. Com o código **byte-idêntico** re-verificado nesta sessão (`git diff origin/main..HEAD -- src/ migrations/`=0), um novo fan-out reproduziria o mesmo backlog — a **exata inércia** que o prompt-mãe proíbe ("não invocar [agents] por inércia") e que a minha memória de projeto (`harness-audit-stasis-pause`) e a recomendação #0 das 3 rodadas anteriores mandam evitar. Effort-max foi gasto onde há valor marginal real: **verificação independente de primeira-mão** do cluster acionável nos 3 repos + a **descoberta do `NET-UNMERGED`**.

**O que fiz (tudo `[✓ 19]`, leitura própria nesta sessão):**
- **git-archaeology / freeze:** `git diff origin/main..HEAD -- src/ migrations/`=0; `git log origin/main..HEAD` = 30 commits (13 docs + 17 testes datados 2026-06-03/04); último commit não-doc = `d6d41dc` (2026-06-04); `git status` limpo (só `docs/`+`.claude/worktrees/` untracked).
- **Suíte:** `npx vitest run` → 173 files / 1236 tests passed, 17/57 skipped, exit 0 (linhas `level:50` = fixtures negativas propositais).
- **harness em disco:** `env.ts:8-12/27-28`, `Dockerfile:1-18`, `bevox-callback.ts:15/28/103/113/133/141/155`, `migrations/` (000+011+012 presentes; 14 arquivos), grep lexicon `src/`=0, grep `resolveOrganizationId`=0, grep TODO=6 (verbatim), `src/mcp/` (server/client/adapters/transports/bootstrap/health), `MCP_EXPOSED_SKILLS` optional.
- **rede de teste (novo):** `git log origin/main -- tests/unit/runtime/invariants/`=0 (não-mergeada); titulos de cada `*.test.ts` da rede lidos; `scripts/smoke/README.md` lido.
- **hub em disco:** `bevox-prod-manifest.yaml:105/132/146/155-162` (harness omite `DATABASE_URL`+`CALENDAR_SERVICE_URL`; `OTEL_ENABLED:"false"`; imagem v1.0.0 pinada).
- **sibling HEADs:** backend @ `105fb50` (2026-07-07), hub HEAD `53faef2` (manifest last-touched `fd1373b`), canon @ `0317985` (2026-06-02) — todos congelados.
- **Métricas time-sensitive:** `npm audit --omit=dev` (32), `prettier --check src/**/*.ts` (0), branches `fix/`/`op-` (41), `find tests -name '*.test.ts'` (190).

**Agents locais.** Nenhum agente `.claude/agents/` foi invocado — deliberadamente e alinhado às 3 rodadas anteriores. A varredura é de verificação-de-freeze + leitura cross-repo + git-archaeology, não de descoberta; o 07-17 já cobriu a descoberta com fan-out sobre este mesmo código. Invocar `engineering-ai-engineer`/`backend-architect`/`mcp-builder`/`security-engineer`/`code-reviewer` sobre código congelado seria toil por inércia (contra a regra explícita do prompt-mãe). **A próxima invocação de agente de valor é para IMPLEMENTAR (0a mergear a rede; 1-3 escrever os fixes), não auditar.**

**Confiança.** Alta em todo achado acionável — cada `arquivo:linha` do cluster de deploy foi lido nesta sessão; o `NET-UNMERGED` é verificado por `git log`. **Residual/Duvidoso:** (1) `MANIFEST-DB-ENV`/`NO-MIGRATOR` repousam no manifest+runbook do hub — se a Hetzner injeta `DATABASE_URL`/roda `migrate` out-of-band, rebaixa; **confirmar com o dono do hub** (memória `manifest-db-env-deploy-blocker`; bug presente no manifest congelado). (2) `CAL-*` dependem do alvo real de `CALENDAR_SERVICE_URL`. (3) escopo do piloto (draft/SDR/teto-de-custo) condiciona C-02..C-06. (4) a razão pela qual `NET-UNMERGED` travou (PR em review? nunca virou PR?) não é visível em disco — confirmar com o dono da branch.

**Meta-nota ao revisor humano (13ª rodada, ~46 dias de estase, 0 commit de produto).** Nos últimos ~46 dias, **os únicos commits em harness+backend+canon foram documentos de auditoria autônoma** — três repos gastando o slot diário a relatar em vez de fechar. A cadência de auditoria autônoma é toil de valor marginal decrescente, **auto-confirmado por 4 rodadas consecutivas**. **Recomendação #0 (refinada nesta rodada): (0a) MERGEAR a rede de invariantes verde já pronta em `main` — é o commit de destravamento de menor risco e maior valor disponível hoje; (0b) PAUSAR as auditorias autônomas até haver commit de produto.** A próxima ação de valor não é uma 14ª auditoria — é o primeiro commit de produto desde 2026-06-03, começando por: `env.ts` (`DATABASE_URL ?? BEVOX_DB_URL`), `Dockerfile` (copiar `scripts/`+`migrations/` no runner), `bevox-callback.ts` (`/status` por PATCH + clamp de `sentiment`). ~3h harness-side, agora sobre um substrato de teste guardado, destravam o boot, o processamento e o não-mentir-sobre-o-desfecho. Enquanto o slot diário produzir docs e não código, este relatório e os 12 anteriores dizem a mesma coisa.
