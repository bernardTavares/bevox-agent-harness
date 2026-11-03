# Gap Analysis — bevox-harness — 2026-07-22

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-07-21.md` (linhagem: `07-21`/`07-20`/`07-19`/`07-18`/`07-17`/`07-16`/`07-15`/`07-14`/`07-08`/`07-07`/`07-05`/`07-04`/`06-23`/`06-04`/`06-02` — esta é a **16ª rodada**).
> **HEAD auditado:** `6c17855` (branch `test/execution-handler-coverage-uplift`) — o commit do doc 07-21. `src/` + `migrations/` + `openapi/` **byte-idênticos a `origin/main` @ `2979eb0`** (snapshot `integration-dryrun`, 2026-06-03). **Zero commits de produto desde 2026-06-03** (~49 dias); tudo desde então (exceto docs de auditoria) é test-only ou doc.
>
> **Freeze re-verificado FRESCO nesta sessão (leitura própria em disco, marcada `[✓ 22]` — não citada de memória nem do 07-21):**
> 1. **harness** — `git diff origin/main HEAD -- src/ migrations/ openapi/` = **0 / 0 / 0 linhas** (produto + schema + spec byte-idênticos a `origin/main` @ `2979eb0`, **~49 dias**; último commit em `src/` = `4e103b9`, 2026-06-03 17:37). `git status` = só `docs/` + `.claude/worktrees/` + os 2 specs superpowers untracked. **Suíte verde re-rodada `[✓ 22]`:** `npx vitest run` = **173 files / 1236 tests passed**, 17/57 skipped, **0 falhas**, exit 0, 18.4s. As linhas `level:50` no log são fixtures de caminho-negativo propositais (poison payloads `bullmq-consumer.test.ts:87`, "backend 503" retry-exhausted `j3`, wall-clock abort `j5`, uuid-inválido no `permission-audit`) — **não** erros.
> 2. **backend** `bevox-backend` @ `5b5b835` — **moveu de `7ae1aa5` (07-21)**, mas o commit HEAD é ele próprio um **doc de auditoria autônoma** (`docs(audit): runtime gap audit 2026-07-21`, 2026-07-21 06:29). A estase cross-repo continua idêntica nos três repos.
> 3. **canon** `bevox-knowledge` @ `0317985` (2026-06-02) — congelado.
> 4. **hub** `bevox-PRD-consolidation` @ `53faef2` (2026-06-04) — **LIDO EM DISCO NESTA RODADA** (o 07-21 NÃO conseguiu montá-lo). `infra/bevox-prod-manifest.yaml` presente (touched jun-3, era `fd1373b`) → os 2 blockers dependentes do hub foram re-verificados **dos DOIS lados** `[✓ 22]` pela primeira vez em várias rodadas (ganho de confiança real vs 07-21, que herdou o lado-manifest de memória).
>
> **Método (effort-max redirecionado — ver §"Notas de método"):** dado o freeze de ~49 dias re-confirmado, **NÃO** re-executei o fan-out multi-agente de *descoberta* (reproduziria backlog byte-idêntico — a exata inércia que o prompt-mãe proíbe [«não invocar agents por inércia — só os que se aplicam à varredura»] e que a memória de projeto `harness-audit-stasis-pause` + a recomendação #0 de 6 rodadas mandam evitar). O effort-max desta rodada foi para **re-verificação first-hand em disco dos 3 blockers incondicionais (agora dos DOIS lados p/ MANIFEST-DB-ENV e C-01), re-prova da topologia de merge da constelação, e o delta time-sensitive** — não descoberta de domínio sobre `src/` congelado.
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

**Nada de produto mudou em ~49 dias; o veredito é pré-determinado — PILOTO: NÃO-GO · GA: NÃO-GO — e esta 16ª rodada não o move.** O cluster CRÍTICO/ALTO/MÉDIO/BAIXO do 07-21 (`~8·~21·~42·~36`) sobrevive integralmente por construção (código congelado); **0 CRÍTICO/ALTO fechados** (0 commits de produto). Os 3 blockers de deploy **incondicionais** (`MANIFEST-DB-ENV`, `NO-MIGRATOR`, `C-01`) foram **re-lidos linha-a-linha nesta sessão `[✓ 22]`** — dois deles **agora dos DOIS lados** (harness + hub-manifest, que voltou a estar legível em disco) — e **sobrevivem sem branch de remediação**.

**O único delta material desta rodada é a aceleração do custo passivo de segurança.** `npm audit --omit=dev` (runtime-only) moveu **33 → 36 vulnerabilidades, com um 6º, 7º e 8º HIGH** (`1 low, 27 moderate, 8 high` `[✓ 22]` vs `07-21: 1 low, 27 moderate, 5 high`). O lockfile está **congelado** — logo isto é 100% drift da base de advisories: em 24h surgiram **+3 HIGH** (incl. `GHSA-3hrh-pfw6-9m5x` Hono cookie-injection). A taxa acelerou (07-20→21 = +1 HIGH; **07-21→22 = +3 HIGH**). O custo de manter o freeze **cresce de forma super-linear** enquanto ninguém mergeia. Reforça, não contradiz, a recomendação #0.

**A constelação de fixes já-escritos segue PROVADA-MERGEÁVEL `[✓ 22]`.** Re-rodei `git merge-tree --write-tree origin/main origin/<branch>` para as 6 branches vivas: **6/6 mergeiam LIMPO** (exit 0) em `origin/main` — `finding-j10-running-status`, `op-openapi-sync`, `op-pipeline-json-robustness`, `op-ctx-tokenizer-budget`, `op-reasoning-quality`, `op-ctx-semantic-recall`. A rede de invariantes verde (`tests/unit/runtime/invariants/`, 7 arquivos) segue **ausente de `origin/main`** (`git log origin/main -- tests/unit/runtime/invariants/` = 0). O caminho de destravamento é **inalterado e barato**: (0a) mergear a rede-de-teste, (0c) mergear a constelação em sequência limpa atrás de CI, (1-3) escrever os 3 blockers sem-branch.

**O achado dominante continua sendo de PROCESSO — agora na 16ª rodada, ~49 dias, 0 commit de produto.** Auditar código byte-idêntico pela 16ª vez é toil de valor marginal ≈ 0. A memória de projeto `harness-audit-stasis-pause` instrui **explicitamente**: «se ainda congelado, NÃO rode uma 16ª auditoria — sinalize a estase e aponte as ações reais». Esta rodada cumpre isso: **first-hand-verifica o freeze e os 3 blockers, quantifica o delta (drift de segurança acelerando), e reafirma as ações de valor.** A próxima ação NÃO é uma 17ª auditoria — é o **primeiro commit de produto para `main` desde 2026-06-03**.

**Correções duráveis re-confirmadas `[✓ 22]` (o prompt-mãe E o CLAUDE.md continuam desatualizados — ver §Correções):** (f) FK `accounts(id)` tratada como aberta — **FECHADA** (`000`+`011`+`012` em `origin/main`, `ls migrations/` = 15); (g) "PRD §212" é **fantasma** (o PRD termina no §17); (h) "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`" — os 3 últimos **não existem** em nenhum dos lados; "cobertura Vitest mínima" (CLAUDE.md) é **super-dimensionado** (1236 testes verdes); "Dockerfile single-stage" e "7 estágios" são **falsos** (2-stage; **16** estágios).

---

## Achados por severidade

> Convenção: `arquivo:linha` no HEAD `6c17855` (== `origin/main` em `src/`). **`[✓ 22]`** = **lido e hand-verificado por mim NESTA sessão (2026-07-22)**, em disco. `SOBREVIVE` = re-aberto e confirmado por freeze de código. `Eh` = esforço estimado. Para o detalhe exaustivo item-a-item do latent-tail herdado (~42 MÉD + ~36 BAIXO), ver `runtime-gap-audit-2026-07-17.md` §"Achados por severidade" — **não re-derivado aqui por disciplina anti-toil**; o freeze de `src/` garante paridade 1:1 (memória `harness-audit-stasis-pause`; recomendação #0 de 6 rodadas).

### 🔴 CRÍTICO — bloqueia o piloto

> Os 3 incondicionais foram **re-lidos linha-a-linha nesta sessão `[✓ 22]`**; MANIFEST-DB-ENV e C-01 **dos DOIS lados** (harness + backend/hub). Coluna "branch" distingue *sem-branch* (precisa escrita) de *mitigado por branch viva provada-mergeável*.

#### Incondicionais (bloqueiam o piloto em QUALQUER escopo)

- **MANIFEST-DB-ENV (SOBREVIVE, `[✓ 22]` DOS DOIS LADOS) — o pacote de deploy pinado crash-loopa no boot.**
  - **Harness** `src/config/env.ts` (relido `[✓ 22]`): `:8 DATABASE_URL: z.string().url()` **(required)**, `:11 BEVOX_DB_URL: z.string().url().optional()` **(opcional; nunca lido pelo pool — o pg pool usa `env.DATABASE_URL`)**, `:12 CALENDAR_SERVICE_URL: z.string().url()` **(required)**. `getEnv()` faz `safeParse` → `process.exit(1)` em falha.
  - **Hub** `infra/bevox-prod-manifest.yaml` (relido EM DISCO `[✓ 22]` — o 07-21 não conseguiu): bloco `bevox-harness` (`:132-155`) supre `BEVOX_DB_URL: "secret:bevox-harness-db-url"` (`:155`) mas **OMITE `DATABASE_URL`** (o único `DATABASE_URL` no manifest é `:105`, no bloco do *backend*: `secret:bevox-backend-database-url`) **E `CALENDAR_SERVICE_URL`** (grep = 0 hits). Imagem harness pinada = **`v1.0.0`** (`sha256:b4c66bb…`, 2026-06-01) — anterior ao baseline do freeze.
  - → `safeParse` falha em 2 required → `process.exit(1)` **antes do stage 1 (`infra-check`)** → 2 réplicas em crash-loop → 0 jobs consumidos → 100% dos jobs batem no 120s-timeout-scan do backend → handoff/dead_letter. **Fix harness-side ~1 linha:** `DATABASE_URL: z.string().url().optional()` + refino `DATABASE_URL ?? BEVOX_DB_URL`, e relaxar/suprir `CALENDAR_SERVICE_URL` (o stage `calendar-health` já tolera qualquer status HTTP). `Eh≈0.5h`. **Sem branch — ESCREVER.** *(Residual: se a Hetzner injeta `DATABASE_URL` ou roda `migrate` out-of-band, rebaixa — confirmar no runbook do hub; mas o manifest pinado em disco NÃO o injeta.)*

- **NO-MIGRATOR (SOBREVIVE, `[✓ 22]`) — o schema do harness nunca é criado no deploy pinado.**
  - `Dockerfile` (relido `[✓ 22]`, **2-stage**): `builder`(`:1 FROM node:20-alpine AS builder`) copia `src`(`:6`)+`scripts`(`:7`) e roda `npm run build`(`:8`); `runner`(`:10 FROM … AS runner`) copia **só** `COPY --from=builder /app/dist ./dist`(`:16`) → `migrations/` E `scripts/migrate.mjs` (que é `.mjs`, nem compilado pelo tsc) estão **fisicamente ausentes** da imagem de prod (`CMD ["node","dist/index.js"]` `:18`). Sem sidecar de migração no manifest — o único migrator no manifest é do **backend** (`# backend migrator v1.0.1 … consumida pelo mcp.run_migrations; não entra neste manifest` `[✓ 22]`), não do harness. **CLAUDE.md §Infra diz "Dockerfile single-stage" — FALSO** (é 2-stage `[✓ 22]`). **Fix:** copiar `scripts/`+`migrations/`(+deps de migração) no runner, OU job de migração no deploy do hub. `Eh≈1.5h`. **Sem branch — ESCREVER.**

- **C-01 (SOBREVIVE, `[✓ 22]` DOS DOIS LADOS) — `updateStatus` por POST contra rota PATCH-only → 404 no 1º callback.**
  - **Harness** `src/integration/bevox-callback.ts` (relido `[✓ 22]`): helper `post()`(`:15`) crava `method:"POST"`(`:28`); `updateStatus`(`:133`) chama `post('/api/v1/executions/${id}/status', ...)`(`:141`). Os outros 3 usam o mesmo `post()`: `/traces`(`:103`), `/stream`(`:113`), `/complete`(`:155`).
  - **Backend** `5b5b835` `src/integration/harness-callbacks.routes.ts` (relido EM DISCO `[✓ 22]`): rota `/status` é **`PATCH`** (`:5` doc, `:57` handler); os outros 3 verbos batem (POST). → `updateStatus(...,"running")` é o 1º `await` do try genérico → 404 → error-boundary. **`finding-j10-running-status` já resolve o DESFECHO fatal** (envolve a chamada num `.catch()` best-effort — o blip não mata mais a execução), mas **NÃO corrige a RAIZ** (verbo) nem o `STATUS-02`. **Fix raiz:** helper `patch()` para `/status`. `Eh≈1h` (co-fixar com C-07). **Sem branch para a raiz.**
  - **STATUS-02 (SOBREVIVE, `[✓ 22]`)** — o backend `/status` trata `status === "dead_letter"` de forma especial (`:67`, `:75-78`, resolve independente do status atual), mas o mesmo POST-vs-PATCH do harness mata a chamada **antes** de chegar lá → o `dead_letter` autoritativo nunca é escrito → a UI de replay de staff nunca acende. `finding-j10` NÃO cobre esta chamada. Fechado ao corrigir a raiz do C-01.

- **C-07 (SOBREVIVE) — `sentiment` da pipeline não-validado → `/complete` 400 em output malformado (co-fix do C-01).** Enum backend = 6 valores (byte-idêntico à union do analyzer — `frustrated/angry/confused` são VÁLIDOS, não 400; ver correção do 07-14); o gatilho real é o cast cru `JSON.parse(...) as ClassificationOutput` que não força o enum → só um valor MALFORMADO da LLM ("happy"/não-string) 400a. Mascarado hoje pelo C-01. **`op-pipeline-json-robustness` adiciona `extract-json.ts` + endurece os 3 pipeline agents** — não é o clamp de enum exato, mas é a robustez de parsing adjacente que reduz a superfície. Fix: `safeParse`+clamp de `sentiment`. `Eh≈1-2h`.

#### Condicionais ao escopo do piloto (CRÍTICO **se** o piloto inclui modos draft e/ou cadência SDR; senão ALTO)

> **Ação ao revisor: confirmar se o piloto usa `manual_assisted`/`copilot` (aciona C-02/AUD-PROPOSAL) ou a esteira SDR/Model-C (aciona C-03..C-06).**

- **C-02 (SOBREVIVE) — `proposals[]` sem `idempotency_key` → `/complete` 400 nos modos draft.** `Eh≈0.5h`. Guardado por `em-03-proposals-end-to-end.test.ts` (rede não-mergeada).
- **C-03 (SOBREVIVE) — esteira SDR/cadência/Model-C/resume morta na fiação viva.** `scheduler.agent.ts` sem `workflow:`; `resume-server.ts`/`subscriber.ts` dead-code (flag default-off). `Eh≈6-8h`.
- **C-04 (SOBREVIVE) — timeout de não-resposta marca cadência `failed` em vez de avançar.** Cobertura real 0% (`state-store.ts`). `Eh≈4-6h`.
- **C-05 (SOBREVIVE) — Model-C sem error boundary + dedup key retida → execução perdida.** `Eh≈3-5h`.
- **C-06 (SOBREVIVE) — respostas vivas nunca qualificam lead nem honram opt-out (risco LGPD/ADR-019).** `execution-handler.ts:565` crava `observedSignals:{}`. Substância do fix vive UNMERGED em `origin/fix/sdr-ultrareview-findings` (+15, base-drift). `Eh≈8h`.

### 🟠 ALTO — bloqueia GA, não necessariamente o piloto

> Cluster do 07-17/07-21, SOBREVIVE integralmente. **🔧 = tem fix VIVO provado-mergeável** (`[✓ 22]`).

- **CLASSIFIER-TIMEOUT-CRASH (SOBREVIVE)** — `observability/error-classifier.ts:64` faz `(e.code ?? "").toUpperCase()`; `.code` de `DOMException{name:"TimeoutError"}` (de `AbortSignal.timeout`) é **numérico** (`23`) → `TypeError` numa função que promete "Never throws" → os 3 adapters LLM re-throw raw → timeouts de LLM nunca retried e o circuit-breaker é cego a timeouts. **Fix 1 linha (`String(e.code ?? "").toUpperCase()`), maior ROI técnico da lista.** `Eh≈0.25h`. (`op-reasoning-quality` mexe em `errors.ts` mas o alvo é o enum `AbortReason`+`invalid_plan`, **não** este `error-classifier.ts` — permanece **sem fix vivo**.)
- **STRATEGY-FAILED-AS-DONE (SOBREVIVE)** — falha genérica finalizada como `done` (`/complete{responseText:"", strategy:"failed"}` in-enum → backend `complete-service.ts` trata texto-vazio como skip intencional e mantém `finalStatus:"done"` → falha registrada como sucesso). Sink do CLASSIFIER-TIMEOUT e do PHASE-TIMEOUT. `Eh≈2h`.
- **🔧 R-01 / R-02 (SOBREVIVEM; fix VIVO provado-mergeável)** — loop ReAct não devolve observações ao LLM (`react.ts` `buildUserContent` retorna stub constante) e a escalação p/ plan-execute é natimorta (`allObservations` não-resetado no swap). **`op-reasoning-quality` (+175 em react/reflexion/execution-context/errors/execution-handler) faz o threading de reflexion no `systemPrompt` e trata a escalação** — escrito, verde, fora de `main`, `[✓ 22]` **mergeia limpo**. Maior risco de QUALIDADE do piloto (default-ON). Guardado por `surface-loop-escalation.test.ts`/`engine-swap-mid-loop.test.ts` (rede não-mergeada). `Eh` (integração) `≈2-3h` vs `≈5-8h` de escrita do zero. **⚠️ muda `/complete.strategy` p/ nome-do-engine-escalado (CB-NEW-03-adjacente) → checar enum backend antes de mergear** (ver §Notas de método, review 07-21).
- **🔧 TOKENIZER-UNDERCOUNT / NEW-CTX-01 (SOBREVIVEM; fix VIVO)** — **`op-ctx-tokenizer-budget` (+207 em tokenizer/budget-enforcer/calibration/execution-handler) endurece a contagem BPE model-aware (`js-tiktoken@1.0.21`, fail-open)** — escrito, verde, fora de `main`, `[✓ 22]` **mergeia limpo**. Guardado por `ctx-02-budget-enforce.test.ts`. **⚠️ 0 cobertura de handler da telemetria nova + kill-switch `HARNESS_BPE_TOKENIZER_ENABLED` cru fora do Zod → merge com smoke pós-merge OU kill-switch default-off** (ver §Notas de método).
- **CP-02 (SOBREVIVE, cross-repo) — `contact_id` ausente no contrato de dispatch → ContextBuilder pulado em 100% dos jobs.** `execution-handler.ts` gate `if CONTEXT_BUILDER_ENABLED && contactId != null`; `contact_id` NÃO está no `harness-dispatch.schema.ts` do backend → gate nunca entrado → os 4 layers vivos mortos em todo dispatch real. Pré-requisito de TODO valor do ContextBuilder e do fix do IDOR-read. `Eh≈1-2h` + 1 PR backend.
- **CP-01 (SOBREVIVE) — backend despacha histórico ilimitado; harness poison-dropa além de `messages.max(100)`.** `Eh≈2-4h`.
- **CB-NEW-03 (SOBREVIVE) — abort J8 emite `strategy` off-enum (`aborted_timeout`/`aborted_cost`) → `/complete` 400 engolido.** `Eh≈1h`.
- **CAL-IDOR-XTENANT + CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN (SOBREVIVEM, LATENT)** — surface de calendário confia em `appointment_id`/`calendar_id` do LLM sem org-scope nem token (`mutation-tool.ts` ToolContext não carrega credencial de calendário). Gated hoje pela ausência de Calendar Service real no MVP (`CALENDAR_SERVICE_URL`→backend, paths não batem → 404) → **vira CRÍTICO cross-tenant ao corrigir o contrato sem adicionar org-scope+token.** `Eh≈1-2h` + Médio.
- **IDOR-CONTACT-PARAM (SOBREVIVE) — `read-profile` confia no `contact_id` do LLM → exfiltração de PII intra-org.** Boundary de org SEGURO (repo scoped por `organizationId`). Fix depende de CP-02. `Eh≈0.5-1h`.
- **REFLEXION-NOTES-UNREAD (🔧 parcial op-reasoning-quality) · REWOO-UNREACHABLE · CTX-RULES/HISTORY-DEAD (re-rooted por CP-02) · AUTHZ-ALLOWLIST · AUD-PROPOSAL-CHECK(014) · USAGE-01 · OBS-LLM-METRICS/OBS-OTEL-OFF/LLM-NO-FAILOVER · D-01/D-05 · PRD-ADR017-OWNERSHIP/ADR019-LGPD-ORPHAN · STREAM-01/RAG-NO-RUNTIME-INDEXER/MCP-cluster** (SOBREVIVEM, vários LATENT atrás de flags/contratos). Detalhe no 07-17.

### 🟡 MÉDIO — degrada qualidade (SOBREVIVEM do 07-17/07-21)

- **EXEC-MODE-FAIL-OPEN (SOBREVIVE, `[✓ 22]`, vs canon) — `execution_mode` cai default no ÚNICO modo de mutação real, contra a ADR-018 (harness) / ADR-006 (_shared) "obrigatório".** `execution-handler.ts:673` (`execution_mode: ExecutionModeSchema.optional().default("autonomous_supervised")`). Os 3 modos são parseados e propagados (`:1347 executionMode: payload.execution_mode` → `AgentExecutionContext.executionMode` → `mutationExecute` → `executeOrPropose`). Backend **sempre envia** (required) mas o schema do harness inverte a garantia — um replay/legado que omita executa create/cancel/send **sem aprovação**. Fix: required (fail-closed) OU default `manual_assisted` (fail-safe). `Eh≈0.5h`.
- **Demais MÉD (SOBREVIVEM):** `NEW-CTX-01` (🔧 fix vivo em `op-ctx-tokenizer-budget`), `MCP-MUTATION-UNGATED`, `CB-BASEURL-IGNORED`, `USAGE-TABLE-DEAD` (`execution_usage` nunca escrita), `WF-COMPLETE-DOUBLE`/`WF-SUSPEND-CLOSES`, `DOUBLE-COMPLETE-REQHUMAN`, `PHASE-TIMEOUT-TERMINAL`, `LLM-MODEL-DOWNGRADE`, `IDOR-WRITE`(inalcançável — `memory-extractor` chama o repo direto, não a tool), `SYNTH-STOP-REACT-ONLY`, `IDEMP-NONDET-PARAMS`, `CP-03`, `TRUNC-DOCTRINE-DROP`, `TOKENIZER-UNDERCOUNT`(🔧), `CALENDAR-NO-RETRY`, `QUEUE-NAME-OBS-TRAP`, `D-02`/`D-03`, `MEM-INDEXER-DUP`, `MEM-CONDENSE-NO-CONSUMER`, `CTX-SILENT-DEGRADE`/`TRACES-01`/`STATUS-01-PAUSED`, `SEC-AUDIT-RED`, `CI-LINT-RED`. Detalhe no 07-17.

### 🟢 BAIXO — higiene (SOBREVIVEM do 07-17/07-21)

- **DEP-AUDIT-DRIFT (ÚNICO delta material `[✓ 22]`) — `npm audit --omit=dev` = 36 (1 low, 27 mod, **8 high**), vs 07-21 = 33 (1 low, 27 mod, **5 high**).** Lockfile congelado → é drift de advisory DB: **+3 HIGH surgiram passivamente em 24h** (incl. `GHSA-3hrh-pfw6-9m5x`, Hono cookie sameSite/priority injection). A taxa **acelerou** (07-20→21 = +1 HIGH; 07-21→22 = +3 HIGH). Único delta numérico da rodada; reforça que o freeze tem custo de segurança **crescente e agora super-linear**. `Eh` (após unfreeze) `≈dependabot/npm audit fix`.
- **DOC-DRIFT (SOBREVIVE, `[✓ 22]` re-confirma `CLAUDE.md` §Infraestrutura):** (a) accounts-FK trap descrito ABERTO com workaround `CREATE TABLE accounts…; DROP…` — **OBSOLETO e CONFLITA** com `000_accounts_stub.sql`+`011`+`012_drop_accounts_stub.sql` (`[✓ 22]` — trap FECHADO); (b) "Dockerfile single-stage" — FALSO (2-stage `[✓ 22]`); (c) "7 estágios" — FALSO (**16** blocos `name:` em `stages.ts` `[✓ 22]`); (d) "3 agentes" — 4 (3 pipeline: message-analyzer/memory-extractor/**memory-condenser** + scheduler surface); (e) `calendar-health` "faz HEAD em `CALENDAR_SERVICE_URL`" — é **GET `/health`** (`stages.ts:485`) e tolera qualquer status HTTP. `Eh≈1h`.
- **🔧 OPENAPI drift (SOBREVIVE; fix VIVO provado-mergeável em `op-openapi-sync`):** `SENTIMENT-ENUM-DOC-DRIFT` (openapi lista 3, backend aceita 6); `OPENAPI-REQUEST-LEXICON-STALE` (request ainda `account_id`/`account`); `OPENAPI-COMPLETE-FIELD-DRIFT` (`response` vs `response_text`). `op-openapi-sync` (0 src, doc-only) já reescreve o spec — `[✓ 22]` mergeia limpo. `Eh` (merge) `≈S`.
- **MARCO1-VERSIONING / CENSUS-PRD-STALE (SOBREVIVEM):** payload sem campo de versão; PRD §5.1 `HARNESS_QUEUE_NAME` stale, §11 "7 migrations" (real: **15** arquivos 000–013, dois `013_`). **Código é o lado correto.** `Eh≈2h`.
- **Demais BAIXO (SOBREVIVEM):** `WORKFLOW-FWD-DEAD`, `PERM-BLACKLIST-ORPHAN` (`account_denied_tools` ausente do `dispatch.schema.ts` backend), `NEW-RWO-01`, `CP-04`, cluster de testes-máscara (`CH-01`/`CH-02` mockam tabelas/fixtures que prod não tem), `OBS-REDACT-SHALLOW`, `MIG-DUP013` (non-hazard — `migrate.mjs` keia por filename), `ACCOUNT-LEXICON` (`src/`=**0** `[✓ 22]`).

---

## 🆕 O delta material — a constelação segue PROVADA-MERGEÁVEL; o custo de inação subiu

**`UNMERGED-CONSTELLATION` (re-verificado `[✓ 22]` por `git merge-tree`).** O achado material do 07-21 — a constelação inteira mergeia LIMPO — **holds intacto nesta rodada**.

### Prova de topologia de merge (`git merge-tree`, re-rodado `[✓ 22]`)

| Teste | Resultado `[✓ 22]` |
|---|---|
| Cada branch viva `+ origin/main` | **6/6 LIMPO** (exit 0): `finding-j10-running-status`, `op-openapi-sync`, `op-pipeline-json-robustness`, `op-ctx-tokenizer-budget`, `op-reasoning-quality`, `op-ctx-semantic-recall` |
| Rede de invariantes em `origin/main` | **ainda AUSENTE** (`git log origin/main -- tests/unit/runtime/invariants/` = 0; 7 arquivos na branch) |

*(A prova exaustiva de pares cruzados + sequencial octopus foi feita `[✓ 21]`; com as branches e o `main` congelados desde então, os 6/6 limpos desta rodada confirmam que a topologia não mudou. Os hunks em `execution-handler.ts` seguem disjuntos: `finding-j10` ~L1407; `tokenizer` {L62,1182,1199,1703,1727}; `reasoning` {L33,488,831-1005,1906,1925}.)*

### Branches VIVAS (`op-*` + `finding-j10`) — fixes de produto escritos, verdes, provados-mergeáveis

| Branch | Fecha/mitiga | Merge `[✓ 22]` |
|---|---|---|
| `finding-j10-running-status` | **C-01 raio de dano** | LIMPO. `updateStatus("running")` em `.catch()` best-effort. |
| `op-openapi-sync` | OPENAPI-*-DRIFT | LIMPO. Reescreve o spec p/ o contrato atual. |
| `op-pipeline-json-robustness` | **C-07-adjacente** | LIMPO. `extract-json.ts` + 3 pipeline agents. |
| `op-ctx-tokenizer-budget` | **TOKENIZER-UNDERCOUNT/NEW-CTX-01** | LIMPO. BPE model-aware. **⚠️ smoke/kill-switch (telemetria sem cobertura de handler).** |
| `op-reasoning-quality` | **R-01/R-02**, REFLEXION-NOTES, ReWOO-cíclico | LIMPO. Threading de reflexion. **⚠️ muda `/complete.strategy` → checar enum backend antes de mergear.** |
| `op-ctx-semantic-recall` | — (test-only; recall inert em main) | LIMPO. |

### Branches MORTAS (`fix/*`) — deletar, não integrar

`fix/migration-accounts-stub` e `fix/skill-loader-esm-import` = **já em `main` por conteúdo** (redundantes). `fix/complete-callback-contract` = **STALE pré-SKILLS-05** (mexe em `*.tool.ts` deletados; NÃO corrige o C-01). `fix/rules-payload-organization-id` = doc-only. **Deletar as 4.** *(Regra durável: NUNCA ler `--no-merged` como "não-corrigido" — rodar `git cherry origin/main origin/<branch>`; `origin/main`=`2979eb0` já É o snapshot `integration-dryrun` que mergeou op-execution-bounding/dead-letter/graceful-shutdown/ctx-builder/tools-skills-unify.)*

**Impacto integrado:** o caminho de destravamento é **inalterado e barato**: **(0a)** mergear a rede de teste (substrato de regressão, test-only, verde) → **(0c)** mergear a constelação VIVA **em sequência limpa** (não rebase-hell — provado) atrás do CI → **(1-3)** escrever os 3 blockers incondicionais sem-branch. **A dívida é de governança de integração; o custo de inação (segurança) sobe a cada dia.**

---

## Cobertura por categoria do prompt (a–k)

| Cat | Tema | Veredito desta rodada (2026-07-22, `[✓ 22]`) |
|---|---|---|
| **a** | PRD vs implementado | PRD `2026-05-15-…-v1` (retroativo) majoritariamente em sincronia. Gate do piloto = **§16 "Critérios de prontidão" (EM ANDAMENTO)**: falta contrato versionado, contract-test e2e, OpenAPI atualizado (🔧 `op-openapi-sync`). **PRD termina no §17 — "PRD §212" do prompt = fantasma.** |
| **b** | execution_mode (ADR-018 harness / ADR-006 _shared) | 3 modos parseados e propagados (`execution-handler.ts:673`→`:1347`→`mutationExecute`→`executeOrPropose`). **`EXEC-MODE-FAIL-OPEN`** (MÉD): `:673` default no modo de mutação-real diverge do canon "obrigatório". Backend sempre envia (required). C-02 mata retorno draft. Guardado por `em-03-proposals-end-to-end.test.ts` (não-mergeado). |
| **c** | Léxico `account_id`/`workspace_id` | **`src/` = 0** (`grep -rEn "(account_id\|workspace_id\|workspaces)" src/` = 0 `[✓ 22]`). `resolveOrganizationId` = **0** (bridge colapsada — confirmado `[✓ 22]`). Migrations 001–010 têm `account_id` histórico (**54** hits, superseded por 011, preservado por regra). Resíduo só no openapi request (🔧 `op-openapi-sync`). |
| **d** | Testes faltando | Suíte **verde: 1236 passed / 57 skipped** (`[✓ 22]`, `vitest run`, exit 0, 173 files). "cobertura mínima" (CLAUDE.md) **super-dimensionado**. **Rede de invariantes existe (7 arquivos) mas NÃO em `main`.** Gaps reais: `state-store.ts` (C-04), `resume-server`/`subscriber` (dead), `error-classifier` input-timeout numérico (CLASSIFIER-TIMEOUT — **sem** fix vivo). **#1 faltante: contract-e2e vs Zod IMPORTADO do backend.** |
| **e** | Dívida conhecida | `grep TODO\|FIXME\|HACK\|XXX\|@deprecated src/` = **6** (`[✓ 22]`): `harness.ts` 3×`@deprecated` (shims legados documentados), `bevox-callback.ts:86` usage-TODO (C13, real), **2 FALSO-POSITIVOS PT-BR** (`memory-condenser.prompt.ts:23` "Preserve TODOS os fatos" + `errors.ts:23` "TODO abort hoje" — "TODOS/TODO" = "todo(s)" em PT, não marcador). Dívida real = dead-code (ReWOO waves, Reflexion notes [🔧], resume-server/subscriber, condense-worker não-deployado). |
| **f** | Migrations accounts(id) FK | **FECHADO** (`[✓ 22]`: `migrations/` tem `000_accounts_stub.sql` (CREATE) + `011_organization_id_tenancy.sql` (dropa os FKs) + `012_drop_accounts_stub.sql` (remove o stub); `ls migrations/` = **15** arquivos c/ 000+011+012). **A categoria (f) do prompt E os workarounds do CLAUDE.md estão OBSOLETOS e CONFLITAM** — remover os passos manuais `CREATE TABLE accounts…; DROP…`. `MIG-DUP013` non-hazard (`migrate.mjs` keia por filename). |
| **g** | MCP server | **Funcional, fail-closed** (PRD §5.13/§10.3, **não "§212"**). `env.ts MCP_EXPOSED_SKILLS` optional, vazio = nada exposto; `send-message`/`request-human` nunca expostos. Cluster LATENT se exposto (`MCP-MUTATION-UNGATED`). |
| **h** | Callbacks (X-Execution-Token) | **4 endpoints reais:** harness `updateStatus→/status`(`:141`, **POST — bug C-01**), `sendTrace→/traces`(`:103`), `sendStream→/stream`(`:113`), `sendComplete→/complete`(`:155`); backend serve `/status`(**PATCH** `:57`)/`/traces`/`/stream`/`/complete`(POST). **`/artifact`,`/tool-result`,`/turn` do prompt NÃO EXISTEM em NENHUM lado `[✓ 22]`.** Defeitos: **verbo** (`/status` POST vs PATCH = C-01) + **body** de `/complete` (C-02/C-07/CB-NEW-03/AUD-PROPOSAL/USAGE). |
| **i** | Bootstrap stages | **16 blocos `name:`** em `stages.ts` (`[✓ 22]`) — CLAUDE.md "7" stale. `calendar-health` (`:483`) faz **GET `/health`** (`:485`) e **tolera qualquer status HTTP** (só `.catch` em rejeição de rede/timeout). Todos gate por throw. |
| **j** | Alçapões p/ piloto | **MANIFEST-DB-ENV + NO-MIGRATOR = o deploy não sobe/não processa (sem branch, `[✓ 22]` dos DOIS lados).** Depois: **C-01** (raiz sem branch; raio-de-dano mitigado por `finding-j10`), **C-07**, **CP-02+R-01/R-02** (🔧 `op-reasoning-quality`), **CLASSIFIER-TIMEOUT-CRASH** (sem fix vivo), `LLM-MODEL-DOWNGRADE`/`PHASE-TIMEOUT-TERMINAL`/`DOUBLE-COMPLETE-REQHUMAN`, `CAL-*` (se Calendar ligado), `IDOR-read`, `CP-01`, `USAGE-01`, `OBS-OTEL-OFF`. |
| **k** | Delta vs audit anterior | **0 CRÍT/ALTO fechados/abertos** (0 commits de produto). Freeze re-provado em disco. **Delta material = `npm audit` 33→36 (+3 HIGH, taxa acelerando).** Constelação re-provada mergeável (6/6 LIMPO `[✓ 22]`). Backend moveu `7ae1aa5`→`5b5b835` (só audit-doc). Hub manifest re-lido em disco (ganho de confiança dos-dois-lados p/ MANIFEST-DB-ENV/C-01). |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. Ordem e conteúdo **inalterados vs 07-21** (código congelado); o custo de *0c* segue baixo (constelação provada-mergeável).

0a. **MERGEAR a rede de invariantes já-verde em `main`** (`~0.5-1h`, promover a PR + CI). Test-only, verde `[✓ 22]`, substrato de regressão. **Primeiro commit não-doc para `main` desde 2026-06-04.**
0b. **META — PAUSAR as auditorias autônomas até haver commit de produto** (`0h`). **16 rodadas** sobre código byte-idêntico; valor marginal ≈ 0. Redirecionar o slot diário para (0a)/(0c)/1-3.
0c. **MERGEAR a constelação VIVA em sequência limpa** (`op-openapi-sync` → `finding-j10` → `op-pipeline-json-robustness` → `op-ctx-tokenizer-budget` → `op-reasoning-quality`), **cada um atrás do CI**. **Provado-mergeável `[✓ 22]` (6/6 LIMPO) — sem rebase-hell.** **Confirmar antes por que travaram ~49d** (pré-condição). `Eh≈3-5h`. **2 pré-condições dirigidas:** (i) antes de `op-reasoning-quality`, **confirmar que o enum `strategy` do backend tolera nomes-de-engine escalados**; (ii) `op-ctx-tokenizer-budget` com **smoke pós-merge OU kill-switch default-off**.
1. **MANIFEST-DB-ENV — `DATABASE_URL: .optional()` + fallback `?? BEVOX_DB_URL` no `env.ts`** (+ relaxar/suprir `CALENDAR_SERVICE_URL`) (`0.5h`). Fecha o crash-loop sem tocar o hub. **Sem branch — ESCREVER.**
2. **NO-MIGRATOR — copiar `scripts/`+`migrations/`+deps no runner OU job de migração no deploy** (`~1.5h`). **Sem branch — ESCREVER.**
3. **C-01 raiz + C-07 — `/status` por PATCH (helper `patch()`) E clamp de `sentiment`** (`~2h`). Fecha STATUS-02 de graça. **Sem branch — ESCREVER** (embora `finding-j10` [0c] já neutralize o desfecho fatal no caminho `running`). Guardado por `perm-03-ordering`+`x-execution-token-header` (0a).
4. **CLASSIFIER-TIMEOUT-CRASH — `String(e.code ?? "").toUpperCase()`** (`0.25h`). 1 linha, restaura retry + circuit-breaker p/ timeouts de LLM. **Sem fix vivo — ESCREVER.**
5. **STRATEGY-FAILED-AS-DONE — mapear falha genuína p/ desfecho `error`** (`~2h`). Impede que falha transiente vire `done` silencioso.
6. **CP-02 — add `contact_id` ao `conversation` no schema de dispatch do backend + destravar o gate** (`~1-2h` + 1 PR backend). Pré-requisito de TODO valor do ContextBuilder. Guardado por `ctx-02-budget-enforce` (0a).
7. **EXEC-MODE-FAIL-OPEN — default fail-safe (`manual_assisted`) ou required** (`0.5h`). Fecha o buraco de mutação-sem-aprovação vs ADR-018/006.
8. **Leva de endurecimento barata (~3.5h):** `LLM-MODEL-DOWNGRADE` + `NEW-COST-01` + `PHASE-TIMEOUT-TERMINAL` + `DOUBLE-COMPLETE-REQHUMAN`/`WF-*` + `MCP-MUTATION-UNGATED` + CI-LINT (`npm run format`) + OBS-OTEL (flip flag manifest).
9. **C-02 + AUD-PROPOSAL(014) — `idempotency_key` no BODY do proposal + migration 014 admitindo `'proposal'`+`'proposed'`** (`~1h`). Desbloqueia modos draft. Guardado por `em-03-proposals-end-to-end` (0a).
10. **PRD-CONTRACT-E2E-TEST contra os schemas Zod IMPORTADOS do backend** (`~8h`). Pega C-01(verbo)/C-02(key)/C-07(enum)/CB-NEW-03(enum)/CAL(path) num só lugar. **#1 teste faltante.** + rebase/re-review de `fix/sdr-ultrareview-findings` (C-06).

> **Pacotes:** **0a+0c+1-5 ≈ "rede mergeada → constelação mergeada limpa → deploy sobe, processa, retria timeouts, não mente sobre o desfecho"** (~8-12h, majoritariamente merge de trabalho já-escrito+provado-mergeável). **+6-9 ≈ endurecimento de piloto** (~7h, ~2 no backend). **+10 ≈ mínimo de piloto + contract-test.** **+ ADR-017/019-LGPD + Calendar (CAL-IDOR antes de expor) + LLM-failover + MCP-hardening + streaming ≈ GA.**

---

## Dependências cruzadas

- **hub-infra (`bevox-PRD-consolidation/infra/`, @ `53faef2`, manifest `fd1373b`-era, RE-LIDO `[✓ 22]`)** → **MANIFEST-DB-ENV** (fallback harness-side OU renomear var + add `CALENDAR_SERVICE_URL`), **NO-MIGRATOR** (job/assets de migração; o manifest só pina migrator de *backend*), **D-05** (`stop_grace_period`), **OBS-OTEL-OFF**, **QUEUE-NAME-OBS-TRAP** (`HARNESS_QUEUE_NAME` no manifest = `bevox.execution.dispatch` ✓, bate com o backend). **P0 operacional — o pacote não sobe sem (1)+(2), que precisam ser ESCRITOS.**
- **bevox-backend** (@ `5b5b835`, congelado a-menos-de-audit-docs) → **CP-02** (add `contact_id`), **CP-01** (janelar histórico), **STRATEGY-FAILED-AS-DONE**, **C-01/STATUS-02/CB-NEW-03** (verbo PATCH + enum abort/dead_letter), **C-02/AUD-PROPOSAL** (`idempotency_key` + `waiting_approval`), **C-07/SENTIMENT** (backend aceita 6), **USAGE/PRD-COST**, **STRATEGY-ESCALATED-ENUM** (`op-reasoning-quality` passa a emitir `strategy` = nome-do-engine-escalado — confirmar tolerância do enum backend antes de mergear a branch).
- **Calendar Service / backend Calendar module** → **CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN + CAL-IDOR-XTENANT**: **NÃO expor o Calendar Service antes de threading token + `organization_id` pelo `ToolContext`** — corrigir o contrato sem org-scope transforma o IDOR de latente em CRÍTICO cross-tenant vivo.
- **canon (bevox-knowledge / hub)** @ `0317985` → **EXEC-MODE-FAIL-OPEN** (código diverge da ADR-018 harness / ADR-006 _shared), **C-03/RESUME** (promover ADR-012 ao canon), **STREAM-01** (ADR-016), **CENSUS-PRD-STALE** (PRD retroativo defasado do código pós-2026-06-02).
- **Governança de branches** (o nó desta rodada) → **`test/execution-handler-coverage-uplift`** (rede de invariantes verde — **promover a PR/mergear**); **`op-*`+`finding-j10`** (fixes VIVOS provados-mergeáveis — **mergear em sequência limpa atrás de CI**); **`fix/migration-accounts-stub`+`fix/skill-loader-esm-import`+`fix/complete-callback-contract`+`fix/rules-payload-organization-id`** (MORTAS — **deletar**); **rebase+re-review de `origin/fix/sdr-ultrareview-findings`** (real, C-06).

---

## Delta vs audit anterior (07-21)

**Linhagem de tally:** 06-02 `13·20·46·34` → 06-04 `6·17·23·22` → 06-23 `7·~20·~27·~30` → 07-04 `~7·~18·~29·~19` → 07-05 `~8·~15·~27·~22` → 07-07 `~8·~16·~28·~20` → 07-08 `~8·~18·~30·~26` → 07-14 `~8·~18·~32·~28` → 07-15 `~8·~19·~33·~30` → 07-16 `~8·~20·~36·~33` → 07-17 `~8·~21·~42·~36` → 07-18/19/20/21 `~8·~21·~42·~36` → **07-22 `~8·~21·~42·~36` (INALTERADO)**.

### FECHADOS desde 07-21
**Nenhum.** `git log` (produto) = vazio; `git diff origin/main HEAD -- src/ migrations/ openapi/` = 0/0/0 `[✓ 22]`. **Veredito de piloto/GA inalterado e pré-determinado.**

### NOVOS/refinados desde 07-21
1. **`DEP-AUDIT-DRIFT` acelerou (o único delta material)** — `npm audit --omit=dev` 33→**36**, **+3 HIGH** em 24h (5→8 high) incl. Hono cookie-injection. A taxa de drift de segurança **acelerou** (07-20→21 = +1 HIGH; 07-21→22 = +3 HIGH). O custo de inação sobe super-linearmente no lockfile congelado.
2. **Hub manifest RE-LIDO em disco `[✓ 22]`** (o 07-21 não conseguiu montá-lo) → **MANIFEST-DB-ENV e C-01 re-verificados dos DOIS lados** pela primeira vez em várias rodadas. Ganho de confiança, não de severidade: ambos SOBREVIVEM (manifest omite `DATABASE_URL`+`CALENDAR_SERVICE_URL` do bloco harness; backend `/status` = PATCH).
3. **Constelação re-provada mergeável `[✓ 22]`** — 6/6 branches vivas LIMPO em `origin/main`; rede de invariantes ainda ausente de `main`. Topologia inalterada (branches+main congelados).
4. **Backend moveu `7ae1aa5`→`5b5b835`** — só doc de auditoria autônoma (mesma estase cross-repo; 3 repos gastando o slot a relatar).

### Variações time-sensitive (as únicas possíveis em código congelado)
| Métrica | 07-21 | 07-22 (`[✓ 22]`) | Nota |
|---|---|---|---|
| `npm audit --omit=dev` | 33 (1 low, 27 mod, 5 high) | **36 (1 low, 27 mod, 8 high)** | **+3 total, +3 HIGH** (advisory drift; taxa acelerando) |
| `TODO/FIXME/…` em `src/` | 6 | **6** | idêntico (2 falso-positivos PT-BR) |
| `find tests -name '*.test.ts'` | 190 | **190** | idêntico |
| Suíte `vitest run` | 1236 passed / 57 skipped | **1236 passed / 57 skipped, 0 fail** | verde, re-rodada fresca |
| `git diff origin/main -- src/` | 0 | **0** | freeze intacto (~49d) |
| backend HEAD | `7ae1aa5` | **`5b5b835`** | +audit-doc only |
| constelação mergeável | 6/6 LIMPO | **6/6 LIMPO** | re-provado `[✓ 22]` |
| hub manifest | não-lido (herdado) | **lido em disco** | MANIFEST-DB-ENV dos 2 lados |

**Conclusão do delta:** material de produto = **zero**. A única mudança de estado é o **drift passivo de segurança acelerando** (+3 HIGH/24h) — aumenta o custo de inação. A 16ª rodada não move nenhum gate de piloto/GA por si só; seu valor incremental foi **re-verificar os 3 blockers dos dois lados** (hub voltou a estar legível) e **quantificar o custo crescente do freeze**.

---

## Correções pendentes ao prompt-mãe e ao CLAUDE.md (byte-verificadas `[✓ 22]`)

1. **prompt-mãe (h)** — "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`": os 3 últimos **não existem em NENHUM dos lados** (`[✓ 22]` harness `bevox-callback.ts`; backend `harness-callbacks.routes.ts`). Reais: `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`.
2. **prompt-mãe (f)** — trata a FK `accounts(id)` como **aberta**: está **FECHADA** (`000`+`011`+`012` em `origin/main` `[✓ 22]`). Remover a pergunta "como fechar definitivamente" e o workaround manual.
3. **prompt-mãe (g)** — "PRD §212": **fantasma** (o PRD termina no §17; o gate do piloto é §16; MCP é §5.13/§10.3).
4. **prompt-mãe (b)** — cita "ADR-006 execution_mode": é **_shared/ADR-006** (autonomy-permissions-approval) **E harness/ADR-018** (modos-de-autonomia-execution-mode) — ambos existem no canon; a fail-open diverge de ambos.
5. **CLAUDE.md §Infraestrutura** — accounts-FK workaround obsoleto/conflitante; "Dockerfile single-stage" (é 2-stage `[✓ 22]`); "7 estágios" (**16** `[✓ 22]`); "3 agentes" (4, +MemoryCondenser); "faz HEAD em CALENDAR_SERVICE_URL" (é GET `/health`, tolera 404).
6. **CLAUDE.md** — "cobertura Vitest é mínima": **super-dimensionado** (1236 testes passando `[✓ 22]`; hot-path 97-100%).

---

## Notas de método

**Decisão deliberada de NÃO re-executar o fan-out multi-agente de descoberta.** Com o código **byte-idêntico** re-verificado (`git diff origin/main HEAD -- src/ migrations/ openapi/` = 0/0/0 `[✓ 22]`), um novo fan-out de descoberta reproduziria o mesmo backlog — a **exata inércia** que o prompt-mãe proíbe («não invocar [agents] por inércia — só os que se aplicam à varredura») e que a memória de projeto (`harness-audit-stasis-pause`, `workflow-multiagent-audit-tooling`) + a recomendação #0 de 6 rodadas mandam evitar. A memória `harness-audit-stasis-pause` é **explícita**: «se ainda congelado (nenhum commit de produto desde 2026-06-03), **NÃO rode uma 16ª auditoria** — sinalize a estase e aponte as ações reais». Cumprido.

**O que fiz (tudo `[✓ 22]`, leitura própria em disco nesta sessão):**
- **git-archaeology / freeze:** `git diff origin/main HEAD -- src/ migrations/ openapi/` = 0/0/0; HEAD `6c17855`, `origin/main` `2979eb0`, último commit `src/` = `4e103b9` (2026-06-03).
- **PROVA de merge-topologia (re-rodada):** `git merge-tree --write-tree origin/main origin/<branch>` p/ cada uma das 6 vivas → **6/6 exit 0**; `git log origin/main -- tests/unit/runtime/invariants/` = 0 (rede ainda fora de main).
- **Suíte:** `npx vitest run` → 173 files / 1236 passed, 17/57 skipped, exit 0, 18.4s (linhas `level:50` = fixtures negativas propositais).
- **harness em disco:** `env.ts:8-12` (DATABASE_URL+CALENDAR_SERVICE_URL required; BEVOX_DB_URL optional-unread), `bevox-callback.ts:15/28/103/113/141/155` (`post()` POST; `/status` via POST = C-01), `Dockerfile:1-18` (2-stage; runner só copia `dist`), `execution-handler.ts:673/1347` (exec-mode fail-open + propagação), `stages.ts` (16 `name:`; calendar-health GET `/health` `:485`), grep lexicon `src/`=0, `resolveOrganizationId`=0, grep TODO=6, `ls migrations/`=15 (000+011+012 presentes; dois `013_`).
- **hub em disco (`53faef2`, manifest `fd1373b`-era) — NOVO nesta rodada:** `bevox-prod-manifest.yaml:132-155` (bloco harness supre `BEVOX_DB_URL` `:155`, OMITE `DATABASE_URL`/`CALENDAR_SERVICE_URL`; imagem harness `v1.0.0`; migrator só de backend).
- **backend em disco (`5b5b835`):** `harness-callbacks.routes.ts:5/57/67/75` (`/status` = PATCH; `dead_letter` special-case).
- **Métricas time-sensitive:** `npm audit --omit=dev` = **36 (1 low/27 mod/8 high)**, +3 HIGH vs 07-21; test files 190; cross-repo HEADs (backend `5b5b835`, hub `53faef2`, canon `0317985`).

**Agents locais — NÃO invocados nesta rodada (deliberado).** A memória `workflow-multiagent-audit-tooling` documenta que a receita (`agentType` friendly-name + texto, sem schema) funciona; mas **em código congelado, invocar agents de descoberta é toil**, e os 2 reviews de merge-readiness forward-looking já foram feitos `[✓ 21]` (op-reasoning-quality = MERGE-WITH-CAVEAT/enum-strategy; op-ctx-tokenizer-budget = MERGE-WITH-CAVEAT/smoke-ou-kill-switch) sobre branches que não mudaram. Re-invocá-los reproduziria o mesmo veredito. A próxima invocação de agente de valor é para **IMPLEMENTAR** (0a mergear a rede; 0c mergear a constelação; 1-3 escrever os fixes sem-branch), **não auditar** código congelado.

**Confiança.** Alta em todo achado acionável — cada `arquivo:linha` dos 3 blockers foi lido nesta sessão, **agora dos DOIS lados** p/ MANIFEST-DB-ENV e C-01 (ganho real vs 07-21); a mergeabilidade é **re-provada** por `git merge-tree` (nível-árvore, não semântico). **Residual/Duvidoso:** (1) `git merge-tree` prova ausência de conflito textual, NÃO correção semântica da união → **CI da união é obrigatório antes de confiar no resultado** (a rede-de-teste 0a + testes das branches são o gate). (2) **por que a constelação travou ~49d** não é visível em disco — **confirmar com o dono das branches antes de mergear** (uma branch pode ter sido abandonada por regressão real). (3) `MANIFEST-DB-ENV`/`NO-MIGRATOR`: se a Hetzner injeta `DATABASE_URL` ou roda `migrate` out-of-band, rebaixa — **confirmar no runbook do hub** (o manifest pinado em disco NÃO o injeta). (4) escopo do piloto (draft/SDR/teto-de-custo) condiciona C-02..C-06.

**Meta-nota ao revisor humano (16ª rodada, ~49 dias de estase, 0 commit de produto).** Nos últimos ~49 dias, **os únicos commits em harness+backend+canon foram documentos de auditoria autônoma** — três repos gastando o slot diário a relatar em vez de fechar. A cadência de auditoria autônoma é toil de valor marginal decrescente, **auto-confirmado por 7 rodadas consecutivas (07-16..07-22)**. Esta 16ª rodada **não descobriu nada de produto novo** — nem poderia, em código byte-idêntico. Seu único delta é que **o custo de NÃO agir subiu**: +3 advisories HIGH em 24h no lockfile congelado (Hono cookie-injection entre eles), acelerando. **A próxima ação de valor não é uma 17ª auditoria — é o primeiro commit de produto para `main` desde 2026-06-03:** (0a) mergear a rede de invariantes verde; (0c) mergear a constelação provada-mergeável atrás de CI (após confirmar por que travou + as 2 pré-condições dirigidas); (1-3) escrever os 3 blockers incondicionais sem-branch; deletar as 4 branches `fix/*` mortas. **Recomendação explícita: PAUSAR a cadência de auditoria autônoma até que um commit de produto aterrisse em `main`.** Enquanto o slot diário produzir docs e não código, este relatório e os 15 anteriores dizem a mesma coisa — agora com a prova de que integrar é barato e o custo de esperar cresce.
