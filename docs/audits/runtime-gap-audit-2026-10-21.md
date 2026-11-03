# Gap Analysis — bevox-harness — 2026-10-21

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-07-22.md` (linhagem: `07-22`/`07-21`/…/`06-04`/`06-02` — 16 rodadas prévias). Esta é a **17ª rodada — e a PRIMEIRA após um hiato de ~3 meses** (última auditoria 2026-07-22; sem nenhuma auditoria entre 07-23 e 10-20).
> **HEAD auditado:** `e55e653` (branch `test/execution-handler-coverage-uplift`) — o commit do doc 07-22. `origin/main` = `2979eb0` (snapshot `integration-dryrun`, 2026-06-03), **inalterado**.
>
> **O fato central desta rodada é um experimento natural de ~3 meses.** As 7 rodadas finais (07-16..07-22) e a memória de projeto `harness-audit-stasis-pause` recomendaram **explicitamente PAUSAR a cadência de auditoria autônoma** e, em vez disso, executar o plano de destravamento (mergear + escrever 3 blockers). **A cadência de fato PAUSOU por ~3 meses — mas o plano de destravamento NÃO foi executado.** Resultado: o módulo está no **estado idêntico de NÃO-GO** que estava em 2026-06-03, agora **~140 dias congelado**, e **materialmente MENOS seguro** (ver §Delta). Pausar sozinho não destravou nada; só execução destrava.
>
> **Freeze re-verificado FRESCO nesta sessão (leitura própria em disco, marcada `[✓ 10-21]` — não citada de memória nem do 07-22):**
> 1. **harness** — `git diff origin/main..HEAD -- src/ migrations/ openapi/ package.json` = **0 / 0 / 0 / 0 linhas**. HEAD `e55e653`, `origin/main` `2979eb0`, último commit de produto em `src/` = `4e103b9` (2026-06-03). **Zero commits de produto em ~140 dias.** Tudo que a branch adiciona sobre `main` (7.060 linhas) é **test-only + smoke + docs de auditoria** (`git diff --stat origin/main..HEAD`: 12 docs, `tests/helpers/invariant-harness.ts`, 7 invariantes, +5 outros testes, 3 arquivos de smoke — 0 linhas de `src/`). **Suíte verde re-rodada `[✓ 10-21]`:** `npx vitest run` = **173 files / 1236 tests passed**, 17/57 skipped, **0 falhas**, exit 0, 18.8s. As linhas `level:50` no log são fixtures de caminho-negativo propositais (ex. `perm-03-ordering.test.ts:224` "backend down", `phase_timeout` abort, `instance-A failure` do permission-audit, `22P02` uuid-inválido) — **não** erros.
> 2. **backend** `bevox-backend` @ `7e2a33a` — moveu de `5b5b835` (07-22), mas o HEAD é ele próprio um **doc de auditoria autônoma** (`docs(audit): runtime gap audit 2026-07-22`). Estase cross-repo idêntica.
> 3. **canon** `bevox-knowledge` @ `0317985` (2026-06-02) — congelado.
> 4. **hub** `bevox-PRD-consolidation` @ `53faef2` (2026-06-04) — congelado; surgiram **specs/planos** do harness (`5f8267d spec(harness): execution-handler split + DI refactor (C+ faseado, 8 PRs)`, `19da0ce plan(harness): PR 0 de 8 — coverage uplift`) — alguém **planejou** um refactor de 8 PRs, mas **nenhum PR aterrissou** em `main`.
>
> **Método (effort-max redirecionado):** dado o freeze de ~140 dias re-confirmado, **NÃO** re-executei o fan-out multi-agente de *descoberta* (reproduziria backlog byte-idêntico — a exata inércia que o prompt-mãe proíbe e que a memória `harness-audit-stasis-pause` manda evitar). O effort-max foi para **re-verificação first-hand em disco dos 3 blockers incondicionais, re-prova da topologia de merge da constelação (`git merge-tree` + `git cherry` por branch), o fechamento definitivo da FK `accounts(id)` (agora incluindo a tabela `sdr_account_state` de 008 que rodadas anteriores não auditaram), e o delta time-sensitive de ~3 meses**. Ver §Notas de método.
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

**Nada de produto mudou em ~140 dias; o veredito é pré-determinado — PILOTO: NÃO-GO · GA: NÃO-GO — e esta 17ª rodada não o move.** O cluster CRÍTICO/ALTO/MÉDIO/BAIXO do 07-22 (`~8·~21·~42·~36`) sobrevive integralmente por construção (código byte-idêntico). **0 CRÍTICO/ALTO fechados** (0 commits de produto). Os 3 blockers de deploy **incondicionais** (`MANIFEST-DB-ENV`, `NO-MIGRATOR`, `C-01`) foram **re-lidos linha-a-linha nesta sessão `[✓ 10-21]`** e **sobrevivem sem branch de remediação**.

**O delta material desta rodada é a confirmação de que a pausa, isolada, não resolveu nada — e o custo passivo de segurança disparou.** O experimento natural de ~3 meses prova a tese central das rodadas 10–16: **auditar é barato, mergear também seria barato, mas ninguém mergeia.** Enquanto isso, `npm audit --omit=dev` (árvore de runtime) saltou de **36 (8 HIGH, 0 crítico) @ 07-22 → 48 (12 HIGH, 1 CRÍTICO) `[✓ 10-21]`** (árvore completa: **88 — 3 críticos, 34 HIGH**). O lockfile está **congelado** → 100% drift da base de advisories em ~3 meses. A aceleração que o 07-22 previu ("super-linear") **concretizou-se**. A remediação parcial (dependabot `pg`/`pino`/`dotenv` +1 cada) também está **presa unmerged** — mesmo nó de governança.

**A constelação de fixes já-escritos segue PROVADA-MERGEÁVEL `[✓ 10-21]`.** Re-rodei `git merge-tree --write-tree origin/main origin/<branch>`: **6/6 branches vivas mergeiam LIMPO** em `origin/main`; os 3 pares que tocam `execution-handler.ts` mergeiam LIMPO entre si (hunks disjuntos). A rede de invariantes verde (`tests/unit/runtime/invariants/`, 7 arquivos) segue **ausente de `origin/main`**. O caminho de destravamento é **inalterado e barato**: (0a) mergear a rede-de-teste, (0c) mergear a constelação em sequência limpa atrás de CI, (1–3) escrever os 3 blockers sem-branch.

**O achado dominante é de PROCESSO, e agora com evidência decisiva.** 17 rodadas, ~140 dias, 0 commit de produto. A recomendação não é mais "pausar a cadência" (ela já pausou ~3 meses e isso, sozinho, não moveu o gate). A recomendação agora é binária: **ou se aloca a equipe para executar o plano de destravamento (0a→0c→1-3, ~8–12h de trabalho majoritariamente já-escrito), ou o módulo é formalmente arquivado — mas NÃO se deve retomar a cadência diária de auditoria.** Outra auditoria sobre código byte-idêntico produziria o 18º relatório dizendo o mesmo que os 17 anteriores.

**Correções duráveis re-confirmadas `[✓ 10-21]` (o prompt-mãe E o CLAUDE.md continuam desatualizados — ver §Correções):** (f) FK `accounts(id)` tratada como aberta — **FECHADA** (`000`+`011`+`012`; agora verificado que 011 também dropa a FK de `sdr_account_state`/008 e `message_embeddings`/007 → o `DROP TABLE accounts` sem CASCADE em 012 sucede); (g) "PRD §212" é **fantasma**; (h) "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`" — os 3 últimos **não existem**; "cobertura Vitest mínima" (CLAUDE.md) é **super-dimensionado** (1236 testes verdes); "Dockerfile single-stage"/"7 estágios"/"3 agentes" são **falsos** (2-stage; 16 estágios; 4 agentes).

---

## Achados por severidade

> Convenção: `arquivo:linha` no HEAD `e55e653` (== `origin/main` em `src/`). **`[✓ 10-21]`** = **lido e hand-verificado por mim NESTA sessão (2026-10-21)**, em disco. `SOBREVIVE` = re-aberto e confirmado por freeze de código. `Eh` = esforço estimado. O latent-tail herdado (~42 MÉD + ~36 BAIXO) **NÃO é re-derivado aqui** por disciplina anti-toil; o freeze byte-idêntico de `src/` garante paridade 1:1 — detalhe exaustivo em `runtime-gap-audit-2026-07-17.md` §"Achados por severidade" e no sumário do 07-22.

### 🔴 CRÍTICO — bloqueia o piloto

> Os 3 incondicionais foram **re-lidos linha-a-linha `[✓ 10-21]`**. Coluna "branch" distingue *sem-branch* (precisa escrita) de *mitigado por branch viva provada-mergeável*.

#### Incondicionais (bloqueiam o piloto em QUALQUER escopo)

- **MANIFEST-DB-ENV (SOBREVIVE, `[✓ 10-21]`) — o pacote de deploy pinado crash-loopa no boot.**
  - **Harness** `src/config/env.ts` (relido `[✓ 10-21]`): `:8 DATABASE_URL: z.string().url()` **(required)**, `:11 BEVOX_DB_URL: z.string().url().optional()` **(opcional; o pg pool usa `env.DATABASE_URL`, nunca `BEVOX_DB_URL`)**, `:12 CALENDAR_SERVICE_URL: z.string().url()` **(required)**. `getEnv()` faz `safeParse` → `process.exit(1)` em falha, antes do stage 1 (`infra-check`).
  - **Hub** (manifest `fd1373b`-era, estado congelado do 07-22 `[✓ 22]`): o bloco `bevox-harness` supre `BEVOX_DB_URL` mas **OMITE `DATABASE_URL` e `CALENDAR_SERVICE_URL`**; imagem harness pinada = `v1.0.0` (anterior ao baseline do freeze). → 2 required ausentes → crash-loop das 2 réplicas → 0 jobs → 100% timeout-scan backend → handoff.
  - **Fix harness-side ~1 linha:** `DATABASE_URL: z.string().url().optional()` + refino `DATABASE_URL ?? BEVOX_DB_URL`, e relaxar/suprir `CALENDAR_SERVICE_URL`. `Eh≈0.5h`. **Sem branch — ESCREVER.** *(Residual: se a Hetzner injeta `DATABASE_URL` ou roda `migrate` out-of-band, rebaixa — confirmar no runbook do hub; o manifest pinado NÃO injeta.)*

- **NO-MIGRATOR (SOBREVIVE, `[✓ 10-21]`) — o schema do harness nunca é criado no deploy pinado.**
  - `Dockerfile` (relido `[✓ 10-21]`, **2-stage**): `builder` (`:1`) copia `src`(`:6`)+`scripts`(`:7`) e roda `npm run build`(`:8`); `runner` (`:10`) copia **só** `COPY --from=builder /app/dist ./dist`(`:16`), `CMD ["node","dist/index.js"]`(`:18`). → `migrations/` E `scripts/migrate.mjs` (que é `.mjs`, nem compilado pelo tsc — só alcançável via `npm run db:migrate` `package.json:42`) estão **fisicamente ausentes** da imagem de prod. Sem sidecar de migração do harness no manifest. **CLAUDE.md §Infra diz "Dockerfile single-stage" — FALSO (é 2-stage `[✓ 10-21]`).** **Fix:** copiar `scripts/`+`migrations/`(+deps) no runner, OU job de migração no deploy do hub. `Eh≈1.5h`. **Sem branch — ESCREVER.**

- **C-01 (SOBREVIVE, `[✓ 10-21]`) — `updateStatus` por POST contra rota PATCH-only → 404 no 1º callback.**
  - **Harness** `src/integration/bevox-callback.ts` (relido `[✓ 10-21]`): o helper de POST crava `method:"POST"`(`:28`); `updateStatus`(`:133`) chama `/api/v1/executions/${id}/status`(`:141`) por esse helper. **`grep PATCH bevox-callback.ts` = 0** → TODOS os 4 callbacks são POST.
  - **Backend** (estado `[✓ 22]`): rota `/status` é **PATCH** (`harness-callbacks.routes.ts:57`). → `updateStatus(...,"running")` é o 1º `await` do try → 404 → error-boundary. **`finding-j10-running-status` já resolve o DESFECHO fatal** (`.catch()` best-effort — o blip não mata mais a execução) mas **NÃO corrige a RAIZ** (verbo) nem o `STATUS-02` (o `dead_letter` autoritativo nunca é escrito → a UI de replay de staff nunca acende). **Fix raiz:** helper `patch()` para `/status`. `Eh≈1h` (co-fixar com C-07). **Sem branch para a raiz.**

- **C-07 (SOBREVIVE) — `sentiment` da pipeline não-validado → `/complete` 400 em output malformado (co-fix do C-01).** Enum backend = 6 valores (byte-idêntico à union do analyzer — `frustrated/angry/confused` são VÁLIDOS); o gatilho real é o cast cru `JSON.parse(...) as ClassificationOutput` que não força o enum → só um valor MALFORMADO da LLM 400a. Mascarado hoje pelo C-01. **`op-pipeline-json-robustness` (+1, `extract-json.ts` + 3 pipeline agents) endurece o parsing adjacente** — não é o clamp de enum exato. Fix: `safeParse`+clamp. `Eh≈1-2h`.

#### Condicionais ao escopo do piloto (CRÍTICO **se** o piloto inclui modos draft e/ou cadência SDR; senão ALTO)

> **Ação ao revisor: confirmar se o piloto usa `manual_assisted`/`copilot` (aciona C-02/AUD-PROPOSAL) ou a esteira SDR/Model-C (aciona C-03..C-06).**

- **C-02 (SOBREVIVE) — `proposals[]` sem `idempotency_key` → `/complete` 400 nos modos draft.** `Eh≈0.5h`. Guardado por `em-03-proposals-end-to-end.test.ts` (rede não-mergeada).
- **C-03 (SOBREVIVE) — esteira SDR/cadência/Model-C/resume morta na fiação viva** (`scheduler.agent.ts` sem `workflow:`; `resume-server`/`subscriber` dead-code flag default-off). `Eh≈6-8h`.
- **C-04 (SOBREVIVE) — timeout de não-resposta marca cadência `failed` em vez de avançar** (cobertura real 0% em `state-store.ts`). `Eh≈4-6h`.
- **C-05 (SOBREVIVE) — Model-C sem error boundary + dedup key retida → execução perdida.** `Eh≈3-5h`.
- **C-06 (SOBREVIVE) — respostas vivas nunca qualificam lead nem honram opt-out (risco LGPD/ADR-019).** `execution-handler.ts:565` crava `observedSignals:{}`. Substância UNMERGED em `origin/fix/sdr-ultrareview-findings` (+15, base-drift). `Eh≈8h`.

### 🟠 ALTO — bloqueia GA, não necessariamente o piloto

> Cluster do 07-17/07-22, SOBREVIVE integralmente. **🔧 = tem fix VIVO provado-mergeável** (`[✓ 10-21]`).

- **CLASSIFIER-TIMEOUT-CRASH (SOBREVIVE) — maior ROI técnico da lista.** `observability/error-classifier.ts:64` faz `(e.code ?? "").toUpperCase()`; o `.code` do `DOMException{name:"TimeoutError"}` (de `AbortSignal.timeout`) é **numérico** (`23`) → `TypeError` numa função que promete "Never throws" → os 3 adapters LLM re-throw raw → timeouts de LLM nunca retried e o circuit-breaker é cego a timeouts. **Fix 1 linha (`String(e.code ?? "").toUpperCase()`).** `Eh≈0.25h`. **Sem fix vivo** (o `op-reasoning-quality` toca `errors.ts`, mas no enum `AbortReason`, não neste arquivo).
- **STRATEGY-FAILED-AS-DONE (SOBREVIVE)** — falha genérica finalizada como `done` (`/complete{responseText:"", strategy:"failed"}` in-enum → backend `complete-service.ts` trata texto-vazio como skip e mantém `finalStatus:"done"` → falha registrada como sucesso). Sink do CLASSIFIER-TIMEOUT e do PHASE-TIMEOUT. `Eh≈2h`.
- **🔧 R-01 / R-02 (SOBREVIVEM; fix VIVO) — maior risco de QUALIDADE do piloto (default-ON).** Loop ReAct não devolve observações ao LLM (`react.ts` `buildUserContent` retorna stub constante) e a escalação é natimorta (`allObservations` não-resetado no swap). **`op-reasoning-quality` (+8; react/reflexion/execution-context/errors/execution-handler +175/-25) faz o threading de reflexion e trata a escalação** — escrito, verde, `[✓ 10-21]` **mergeia LIMPO**. Guardado por `engine-swap-mid-loop.test.ts` (rede não-mergeada). `Eh` (integração) `≈2-3h`. **⚠️ muda `/complete.strategy` p/ o nome-do-engine-escalado → checar enum backend antes de mergear.**
- **🔧 TOKENIZER-UNDERCOUNT / NEW-CTX-01 (SOBREVIVEM; fix VIVO)** — **`op-ctx-tokenizer-budget` (+8; tokenizer/budget-enforcer/calibration/execution-handler +207/-37) endurece a contagem BPE model-aware (`js-tiktoken`, fail-open)** — `[✓ 10-21]` **mergeia LIMPO**. Guardado por `ctx-02-budget-enforce.test.ts`. **⚠️ 0 cobertura de handler da telemetria nova + kill-switch `HARNESS_BPE_TOKENIZER_ENABLED` cru fora do Zod → merge com smoke pós-merge OU kill-switch default-off.**
- **CP-02 (SOBREVIVE, cross-repo) — `contact_id` ausente no contrato de dispatch → ContextBuilder pulado em 100% dos jobs.** Gate `if CONTEXT_BUILDER_ENABLED && contactId != null`; `contact_id` não está no `harness-dispatch.schema.ts` do backend → os 4 layers vivos mortos em todo dispatch real. Pré-requisito de TODO valor do ContextBuilder e do fix do IDOR-read. `Eh≈1-2h` + 1 PR backend.
- **CP-01 (SOBREVIVE) — backend despacha histórico ilimitado; harness poison-dropa além de `messages.max(100)`.** `Eh≈2-4h`.
- **CB-NEW-03 (SOBREVIVE) — abort J8 emite `strategy` off-enum (`aborted_timeout`/`aborted_cost`) → `/complete` 400 engolido.** `Eh≈1h`.
- **CAL-IDOR-XTENANT + CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN (SOBREVIVEM, LATENT)** — surface de calendário confia em `appointment_id`/`calendar_id` do LLM sem org-scope nem token (`mutation-tool.ts` ToolContext não carrega credencial de calendário). Gated hoje pela ausência de Calendar Service real (paths 404) → **vira CRÍTICO cross-tenant ao corrigir o contrato sem adicionar org-scope+token.** `Eh≈1-2h`.
- **IDOR-CONTACT-PARAM (SOBREVIVE) — `read-profile` confia no `contact_id` do LLM → exfiltração de PII intra-org.** Boundary de org SEGURO (repo scoped por `organizationId`). Fix depende de CP-02. `Eh≈0.5-1h`.
- **REFLEXION-NOTES-UNREAD (🔧 parcial op-reasoning-quality) · REWOO-UNREACHABLE · CTX-RULES/HISTORY-DEAD (re-rooted por CP-02) · AUTHZ-ALLOWLIST · AUD-PROPOSAL-CHECK(014) · USAGE-01 · OBS-LLM-METRICS/OBS-OTEL-OFF/LLM-NO-FAILOVER · D-01/D-05 · PRD-ADR017-OWNERSHIP/ADR019-LGPD-ORPHAN · STREAM-01/RAG-NO-RUNTIME-INDEXER/MCP-cluster** (SOBREVIVEM, vários LATENT atrás de flags/contratos). Detalhe no 07-17.

### 🟡 MÉDIO — degrada qualidade (SOBREVIVEM do 07-17/07-22)

- **EXEC-MODE-FAIL-OPEN (SOBREVIVE, `[✓ 10-21]`, vs canon) — `execution_mode` cai default no ÚNICO modo de mutação real.** `execution-handler.ts:673` (`ExecutionModeSchema.optional().default("autonomous_supervised")`), contra ADR-018 (harness) / ADR-006 (_shared) "obrigatório". Os 3 modos SÃO parseados e propagados (`:1347`→`AgentExecutionContext.executionMode`→`mutationExecute`→`executeOrPropose`); o backend sempre envia (required), mas um replay/legado que omita executa create/cancel/send **sem aprovação**. Fix: required (fail-closed) OU default `manual_assisted` (fail-safe). `Eh≈0.5h`. *(Nota: os fixes `fix/issue-44-em-03`, `fix/issue-42-perm-03`, `fix/issue-43-perm-05` são **+0** `[✓ 10-21]` → já em `main`; a fiação EM-03 + 3-camadas de permissão está LANDED, como o CLAUDE.md anota.)*
- **Demais MÉD (SOBREVIVEM):** `NEW-CTX-01` (🔧), `MCP-MUTATION-UNGATED`, `CB-BASEURL-IGNORED`, `USAGE-TABLE-DEAD`, `WF-COMPLETE-DOUBLE`/`WF-SUSPEND-CLOSES`, `DOUBLE-COMPLETE-REQHUMAN`, `PHASE-TIMEOUT-TERMINAL`, `LLM-MODEL-DOWNGRADE`, `IDOR-WRITE`(inalcançável — `memory-extractor` chama o repo direto), `SYNTH-STOP-REACT-ONLY`, `IDEMP-NONDET-PARAMS`, `CP-03`, `TRUNC-DOCTRINE-DROP`, `CALENDAR-NO-RETRY`, `QUEUE-NAME-OBS-TRAP`, `D-02`/`D-03`, `MEM-INDEXER-DUP`, `MEM-CONDENSE-NO-CONSUMER`, `CTX-SILENT-DEGRADE`/`TRACES-01`/`STATUS-01-PAUSED`, `SEC-AUDIT-RED`, `CI-LINT-RED`. Detalhe no 07-17.

### 🟢 BAIXO — higiene (SOBREVIVEM do 07-17/07-22)

- **🔺 DEP-AUDIT-DRIFT (ÚNICO delta material — e agora com um CRÍTICO de runtime).** `npm audit --omit=dev` (árvore de runtime) = **48 (1 low, 34 mod, 12 HIGH, 1 CRÍTICO) `[✓ 10-21]`**, vs 07-22 = 36 (1 low, 27 mod, 8 HIGH, 0 crítico). Árvore completa = **88 (2 low, 49 mod, 34 HIGH, 3 críticos)**. Lockfile congelado → 100% drift de advisory DB em ~3 meses. **Ressalva de alcance (honestidade):** muitos HIGH são toolchain de DEV (`@changesets/*`, `lint-staged`, `globby`/`fast-glob`/`braces`/`micromatch`, `browserslist`); os de runtime-tree com alcance plausível incluem `@grpc/grpc-js` (crash via request malformado — só no caminho Gemini), `ws`, `hono`/`proxy-addr`/`ip-address` (SSRF/IP-spoof — **só se houvesse superfície HTTP**, que a topologia worker-only sem porta exposta NÃO tem). → o número cru **cresceu**, mas o blast-radius real é limitado pela topologia; **mesmo assim é o único indicador que piora a cada dia**. **Remediação parcial presa unmerged `[✓ 10-21]`:** `origin/dependabot/npm_and_yarn/{pg-8.21.0,pino-10.3.1,dotenv-17.4.2,zustand-5.0.13}` são todos **+1** (bumps de dependência não-mergeados). `Eh` (após unfreeze) `≈ mergear dependabot + npm audit fix`.
- **DOC-DRIFT (SOBREVIVE, `[✓ 10-21]` re-confirma `CLAUDE.md` §Infraestrutura):** (a) accounts-FK trap descrito ABERTO com workaround `CREATE TABLE accounts…; DROP…` — **OBSOLETO e CONFLITA** com `000`+`011`+`012` (`[✓ 10-21]` — trap FECHADO, ver §Correções item 2); (b) "Dockerfile single-stage" — FALSO (2-stage); (c) "7 estágios" — FALSO (**16** blocos `name:` em `stages.ts` `[✓ 10-21]`); (d) "3 agentes" — 4 (3 pipeline: message-analyzer/memory-extractor/**memory-condenser** + scheduler surface); (e) `calendar-health` "faz HEAD em `CALENDAR_SERVICE_URL`" — é **GET `/health`** e tolera qualquer status HTTP. `Eh≈1h`.
- **🔧 OPENAPI drift (SOBREVIVE; fix VIVO em `op-openapi-sync`):** `SENTIMENT-ENUM-DOC-DRIFT` (openapi lista 3, backend aceita 6); `OPENAPI-REQUEST-LEXICON-STALE` (request ainda `account_id`/`account`); `OPENAPI-COMPLETE-FIELD-DRIFT` (`response` vs `response_text`). `op-openapi-sync` (+1, doc-only, +323/-102) reescreve o spec — `[✓ 10-21]` mergeia LIMPO.
- **VERSION-SKEW (SOBREVIVE, `[✓ 10-21]`):** `package.json.version = 0.1.0`, mas a tag de release / imagem pinada em prod = **`v1.0.0`**. Fonte de verdade de versão inconsistente (parte de MARCO1-VERSIONING: payload sem campo de versão).
- **COMMENT-ENCODING-CORRUPTION (SOBREVIVE, `[✓ 10-21]`, cosmético):** `env.ts` (`:16,35,40,44,49,59`) e o `README.md` têm mojibake em comentários/prosa (bytes UTF-8 corrompidos, ex. "ÃƒÆ'…"). Não afeta runtime; higiene. `Eh≈0.25h`.
- **Demais BAIXO (SOBREVIVEM):** `MARCO1-VERSIONING`/`CENSUS-PRD-STALE` (PRD §11 "7 migrations" — real **15**; §5.1 `HARNESS_QUEUE_NAME` stale — código é o lado correto), `WORKFLOW-FWD-DEAD`, `PERM-BLACKLIST-ORPHAN` (`account_denied_tools` ausente do `dispatch.schema.ts` backend), `NEW-RWO-01`, `CP-04`, cluster de testes-máscara (`CH-01`/`CH-02`), `OBS-REDACT-SHALLOW`, `MIG-DUP013` (non-hazard — `migrate.mjs` keia por filename), `ACCOUNT-LEXICON` (`src/`=**0** `[✓ 10-21]`).

---

## 🆕 O delta material — o experimento natural de ~3 meses + o custo de inação disparou

**`STASIS-NATURAL-EXPERIMENT` (NOVO enquadramento `[✓ 10-21]`).** Entre 07-23 e 10-20 a cadência de auditoria **de fato parou** (0 auditorias em ~3 meses) — exatamente a recomendação #0b de 7 rodadas. **Mas o plano de destravamento NÃO foi executado.** Logo o experimento isola a variável: *pausar a auditoria, sozinho, não move o gate de piloto.* O módulo está **~140 dias congelado**, no mesmo NÃO-GO, com as mesmas 6 branches vivas dormentes e os mesmos 3 blockers sem-branch. A lição para o revisor: **a próxima ação não pode ser "parar de auditar" (já feito) nem "auditar de novo" (inútil) — tem de ser ALOCAR trabalho de integração/escrita, ou arquivar.**

### Prova de topologia de merge (`git merge-tree` + `git cherry`, re-rodado `[✓ 10-21]`)

| Teste | Resultado `[✓ 10-21]` |
|---|---|
| Cada branch viva `+ origin/main` | **6/6 LIMPO** (exit 0): `finding-j10-running-status`, `op-reasoning-quality`, `op-ctx-tokenizer-budget`, `op-pipeline-json-robustness`, `op-openapi-sync`, `op-ctx-semantic-recall` |
| Pares que tocam `execution-handler.ts` entre si | **3/3 LIMPO** (j10×reasoning, j10×tokenizer, reasoning×tokenizer) — hunks disjuntos: `finding-j10` ~L1407; `reasoning` {L33,488,831-1005,1906,1925}; `tokenizer` {L62,1182,1199,1703,1727} |
| `git cherry origin/main origin/<viva>` | genuinamente-ausentes: `finding-j10` **+1**, `op-reasoning-quality` **+8**, `op-ctx-tokenizer-budget` **+8**, `op-pipeline-json-robustness` **+1**, `op-openapi-sync` **+1**, `op-ctx-semantic-recall` **+4** |
| Snapshots já-em-main (sanidade) | `op-dead-letter`/`op-execution-bounding`/`op-graceful-shutdown`/`ctx-builder`/`tools-skills-unify`/`mutation-stack` = **+0** (patch-id idêntico a `main` — `origin/main` É o `integration-dryrun`) |
| Rede de invariantes em `origin/main` | **ainda AUSENTE** (`git log origin/main -- tests/unit/runtime/invariants/` = 0; 7 arquivos na branch) |

### Branches VIVAS (`op-*` + `finding-j10`) — fixes de produto escritos, verdes, provados-mergeáveis

| Branch | Fecha/mitiga | Footprint | Merge `[✓ 10-21]` |
|---|---|---|---|
| `finding-j10-running-status` (+1) | **C-01 raio de dano** | `execution-handler.ts` +11/-1 | LIMPO |
| `op-reasoning-quality` (+8) | **R-01/R-02**, REFLEXION-NOTES, ReWOO | react/reflexion/errors/exec-context/exec-handler +175/-25 | LIMPO. **⚠️ muda `/complete.strategy`.** |
| `op-ctx-tokenizer-budget` (+8) | **TOKENIZER-UNDERCOUNT/NEW-CTX-01** | tokenizer/budget-enforcer/calibration/exec-handler +207/-37 | LIMPO. **⚠️ smoke/kill-switch.** |
| `op-pipeline-json-robustness` (+1) | **C-07-adjacente** | extract-json + 3 pipeline agents +145/-10 | LIMPO |
| `op-openapi-sync` (+1) | OPENAPI-*-DRIFT | openapi +323/-102 (0 src) | LIMPO |
| `op-ctx-semantic-recall` (+4) | — (test+docs; recall inert em main) | 2 docs + 2 testes +2089 (**0 src**) | LIMPO |

### Branches MORTAS (`fix/*`) — deletar, não integrar

`fix/migration-accounts-stub` (+0), `fix/skill-loader-esm-import` (+0), `fix/rules-payload-organization-id` (+0), `fix/lockfile-sync` (+0), `fix/dedup-key-cleanup-on-error` (+0), `fix/idempotency-key-foundation` (+0), e `fix/issue-40/42/43/44/47` (+0) = **já em `main` por conteúdo** (redundantes `[✓ 10-21]`). `fix/complete-callback-contract` (+4) = **STALE pré-SKILLS-05** (mexe em `*.tool.ts` deletados; NÃO corrige o C-01 — `response`→`response_text` já em main). **Deletar.** *(Regra durável: NUNCA ler `--no-merged` como "não-corrigido" — rodar `git cherry origin/main origin/<branch>`.)*

**Impacto integrado:** o caminho de destravamento é **inalterado e barato** — **(0a)** mergear a rede de teste (regressão, test-only, verde) → **(0c)** mergear a constelação VIVA **em sequência limpa** (provado) atrás do CI → **(1-3)** escrever os 3 blockers incondicionais. **A dívida é de governança de integração; o custo de inação (segurança) sobe a cada dia.**

---

## Cobertura por categoria do prompt (a–k)

| Cat | Tema | Veredito desta rodada (2026-10-21, `[✓ 10-21]`) |
|---|---|---|
| **a** | PRD vs implementado | PRD `2026-05-15-…-v1` (retroativo) majoritariamente em sincronia; o código tem **MAIS** do que o PRD/CLAUDE.md descreve (CredentialPool, circuit-breaker/retry LLM, OTEL, eval-worker, workflow-resume, RAG, MCP). Gate do piloto = **§16 "Critérios de prontidão" (EM ANDAMENTO)**: falta contrato versionado, contract-test e2e, OpenAPI atualizado (🔧 `op-openapi-sync`). **"PRD §212" do prompt = fantasma (o PRD termina no §17).** |
| **b** | execution_mode (ADR-018 harness / ADR-006 _shared) | 3 modos parseados e propagados (`:673`→`:1347`→`mutationExecute`→`executeOrPropose`); `fix/issue-44-em-03` + `fix/issue-42/43-perm` são **+0** (LANDED em main `[✓ 10-21]`). **`EXEC-MODE-FAIL-OPEN`** (MÉD): `:673` default no modo de mutação-real diverge do canon "obrigatório". C-02 mata retorno draft. Guardado por `em-03-proposals-end-to-end.test.ts` (não-mergeado). |
| **c** | Léxico `account_id`/`workspace_id` | **`src/` = 0** (`grep -rEn "(account_id\|workspace_id\|workspaces)" src/` = 0 `[✓ 10-21]`). `resolveOrganizationId` = **0** (bridge colapsada — confirmado). Migrations 001–010 têm `account_id` histórico (**54** hits, superseded por 011, preservado por regra do CLAUDE.md). Resíduo só no openapi request (🔧 `op-openapi-sync`). |
| **d** | Testes faltando | Suíte **verde: 1236 passed / 57 skipped** (`[✓ 10-21]`, exit 0, 173 files). "cobertura mínima" (CLAUDE.md) **super-dimensionado**. **Rede de invariantes (7 arquivos) existe mas NÃO em `main`.** Gaps reais: `state-store.ts` (C-04), `resume-server`/`subscriber` (dead), `error-classifier` input-timeout numérico (**sem** fix vivo). **#1 faltante: contract-e2e vs os schemas Zod IMPORTADOS do backend.** |
| **e** | Dívida conhecida | `grep TODO\|FIXME\|HACK\|XXX\|@deprecated src/` = **6** (`[✓ 10-21]`): `harness.ts` 3×`@deprecated` (shims legados documentados), `bevox-callback.ts:86` usage-TODO (C13, real), **2 FALSO-POSITIVOS PT-BR** (`memory-condenser.prompt.ts:23` "TODOS os fatos" + `errors.ts:23` "TODO abort"). Dívida real = dead-code (ReWOO waves, Reflexion notes [🔧], resume-server/subscriber, condense-worker). |
| **f** | Migrations accounts(id) FK | **FECHADO (`[✓ 10-21]`, agora verificado exaustivamente p/ todas as tabelas).** `000_accounts_stub.sql:26` cria `accounts(id)`; `011_organization_id_tenancy.sql` DROPA+RECRIA **todas** as 13 tabelas tenant sem a FK, **incluindo `sdr_account_state` (008) `:381` e `message_embeddings` (007)** — rodadas anteriores só auditaram as 3 tabelas de 001; **confirmado que nenhuma FK para `accounts` sobrevive** → `012_drop_accounts_stub.sql:4 DROP TABLE IF EXISTS accounts` (sem CASCADE) **sucede**. `ls migrations/` = **15**. **A categoria (f) do prompt E os workarounds do CLAUDE.md estão OBSOLETOS e CONFLITAM** — remover os passos manuais. `MIG-DUP013` non-hazard. |
| **g** | MCP server | **Funcional, fail-closed** (PRD §5.13/§10.3, **não "§212"**). `MCP_EXPOSED_SKILLS` optional, vazio = nada exposto; `send-message`/`request-human` nunca expostos. Cluster LATENT se exposto (`MCP-MUTATION-UNGATED`). |
| **h** | Callbacks (X-Execution-Token) | **4 endpoints reais:** `updateStatus→/status`(`:141`, **POST — bug C-01**), `/traces`, `/stream`, `/complete` — todos POST no harness (`grep PATCH`=0 `[✓ 10-21]`); backend serve `/status`(**PATCH**)/`/traces`/`/stream`/`/complete`. **`/artifact`,`/tool-result`,`/turn` do prompt NÃO EXISTEM em NENHUM lado.** Defeitos: **verbo** (C-01) + **body** de `/complete` (C-02/C-07/CB-NEW-03/USAGE). |
| **i** | Bootstrap stages | **16 blocos `name:`** em `stages.ts` (`[✓ 10-21]`) — CLAUDE.md "7" stale. Lista: infra-check, load-config, init-observability, register-agents, register-workflows, warmup-pipeline, load-tools-permissions, load-mcp-clients, init-rag, **calendar-health**, start-dev-ws, init-evals, eval-worker, start-workflow-resume, init-memory-d3, start-consumer. `calendar-health` faz **GET `/health`** e **tolera qualquer status HTTP** (só `.catch` em rede/timeout) — **aceita 404** ✓. |
| **j** | Alçapões p/ piloto | **MANIFEST-DB-ENV + NO-MIGRATOR = o deploy não sobe/não processa (sem branch, `[✓ 10-21]`).** Depois: **C-01** (raiz sem branch; raio-de-dano mitigado por `finding-j10`), **C-07**, **CP-02+R-01/R-02** (🔧 `op-reasoning-quality`), **CLASSIFIER-TIMEOUT-CRASH** (sem fix vivo), `LLM-MODEL-DOWNGRADE`/`PHASE-TIMEOUT-TERMINAL`/`DOUBLE-COMPLETE-REQHUMAN`, `CAL-*` (se Calendar ligado), `IDOR-read`, `CP-01`, `USAGE-01`, `OBS-OTEL-OFF`. |
| **k** | Delta vs audit anterior | **0 CRÍT/ALTO fechados/abertos** (0 commits de produto em ~140 dias). Freeze re-provado em disco. **Delta material = `npm audit` runtime 36→48 (+4 HIGH, +1 CRÍTICO) + o experimento natural de ~3 meses provando que pausar≠destravar.** Constelação re-provada mergeável (6/6 + 3/3 pares LIMPO `[✓ 10-21]`). Ver §Delta vs 07-22. |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. Ordem e conteúdo **inalterados vs 07-22** (código congelado); a constelação segue provada-mergeável.

0a. **MERGEAR a rede de invariantes já-verde em `main`** (`~0.5-1h`, promover a PR + CI). Test-only, verde `[✓ 10-21]`, substrato de regressão. **Seria o primeiro commit não-doc para `main` desde 2026-06-04.**
0b. **META — DECIDIR: executar o destravamento OU arquivar o módulo; em qualquer caso, NÃO retomar a cadência diária de auditoria** (`0h`). 17 rodadas sobre código byte-idêntico; a pausa de ~3 meses provou que auditar/pausar não move o gate — só execução move.
0c. **MERGEAR a constelação VIVA em sequência limpa** (`op-openapi-sync` → `finding-j10` → `op-pipeline-json-robustness` → `op-ctx-tokenizer-budget` → `op-reasoning-quality`), **cada um atrás do CI**. **Provado-mergeável `[✓ 10-21]` (6/6 + 3/3 pares LIMPO) — sem rebase-hell.** **Confirmar antes por que travaram ~140d** (uma branch pode ter sido abandonada por regressão real). `Eh≈3-5h`. **2 pré-condições dirigidas:** (i) antes de `op-reasoning-quality`, **confirmar que o enum `strategy` do backend tolera nomes-de-engine escalados**; (ii) `op-ctx-tokenizer-budget` com **smoke pós-merge OU kill-switch default-off**.
1. **MANIFEST-DB-ENV — `DATABASE_URL: .optional()` + fallback `?? BEVOX_DB_URL` no `env.ts`** (+ relaxar/suprir `CALENDAR_SERVICE_URL`) (`0.5h`). Fecha o crash-loop sem tocar o hub. **Sem branch — ESCREVER.**
2. **NO-MIGRATOR — copiar `scripts/`+`migrations/`+deps no runner OU job de migração no deploy** (`~1.5h`). **Sem branch — ESCREVER.**
3. **C-01 raiz + C-07 — `/status` por PATCH (helper `patch()`) E clamp de `sentiment`** (`~2h`). Fecha STATUS-02 de graça. **Sem branch** (embora `finding-j10` [0c] já neutralize o desfecho fatal no caminho `running`).
4. **CLASSIFIER-TIMEOUT-CRASH — `String(e.code ?? "").toUpperCase()`** (`0.25h`). 1 linha, restaura retry + circuit-breaker p/ timeouts de LLM. **Sem fix vivo — ESCREVER.**
5. **STRATEGY-FAILED-AS-DONE — mapear falha genuína p/ desfecho `error`** (`~2h`). Impede que falha transiente vire `done` silencioso.
6. **CP-02 — add `contact_id` ao `conversation` no schema de dispatch do backend + destravar o gate** (`~1-2h` + 1 PR backend). Pré-requisito de TODO valor do ContextBuilder.
7. **EXEC-MODE-FAIL-OPEN — default fail-safe (`manual_assisted`) ou required** (`0.5h`). Fecha o buraco de mutação-sem-aprovação vs ADR-018/006.
8. **Leva de endurecimento barata (~3.5h) + refresh de dependências:** `LLM-MODEL-DOWNGRADE` + `PHASE-TIMEOUT-TERMINAL` + `DOUBLE-COMPLETE-REQHUMAN`/`WF-*` + `MCP-MUTATION-UNGATED` + CI-LINT (`npm run format`, 12 arquivos) + OBS-OTEL (flip flag manifest) + **mergear os dependabot bumps + `npm audit fix`** (ataca o DEP-AUDIT-DRIFT).
9. **C-02 + AUD-PROPOSAL(014) — `idempotency_key` no BODY do proposal + migration 014 admitindo `'proposal'`+`'proposed'`** (`~1h`). Desbloqueia modos draft. Guardado por `em-03-proposals-end-to-end` (0a).
10. **PRD-CONTRACT-E2E-TEST contra os schemas Zod IMPORTADOS do backend** (`~8h`). Pega C-01(verbo)/C-02(key)/C-07(enum)/CB-NEW-03(enum)/CAL(path) num só lugar. **#1 teste faltante.** + rebase/re-review de `fix/sdr-ultrareview-findings` (C-06).

> **Pacotes:** **0a+0c+1-5 ≈ "rede mergeada → constelação mergeada → deploy sobe, processa, retria timeouts, não mente sobre o desfecho"** (~8-12h, majoritariamente merge de trabalho já-escrito+provado-mergeável). **+6-9 ≈ endurecimento de piloto** (~7h). **+10 ≈ mínimo de piloto + contract-test.** **+ ADR-017/019-LGPD + Calendar (CAL-IDOR antes de expor) + LLM-failover + MCP-hardening + streaming ≈ GA.**

---

## Dependências cruzadas

- **hub-infra (`bevox-PRD-consolidation/infra/`, @ `53faef2`)** → **MANIFEST-DB-ENV** (fallback harness-side OU renomear var + add `CALENDAR_SERVICE_URL`), **NO-MIGRATOR** (job/assets de migração; o manifest só pina migrator de *backend*), **D-05** (`stop_grace_period`), **OBS-OTEL-OFF**, **QUEUE-NAME** (`HARNESS_QUEUE_NAME` = `bevox.execution.dispatch` ✓, bate com o backend). Surgiram **specs/planos** no hub (`spec(harness): execution-handler split`, `plan: PR 0 de 8`) mas **nenhum PR landou**. **P0 operacional — o pacote não sobe sem (1)+(2), que precisam ser ESCRITOS.**
- **bevox-backend** (@ `7e2a33a`, congelado a-menos-de-audit-docs) → **CP-02** (add `contact_id`), **CP-01** (janelar histórico), **STRATEGY-FAILED-AS-DONE**, **C-01/STATUS-02/CB-NEW-03** (verbo PATCH + enum abort/dead_letter), **C-02/AUD-PROPOSAL** (`idempotency_key` + `waiting_approval`), **C-07/SENTIMENT** (backend aceita 6), **USAGE/PRD-COST**, **STRATEGY-ESCALATED-ENUM** (`op-reasoning-quality` emite `strategy`=nome-do-engine-escalado — confirmar tolerância do enum antes de mergear).
- **Calendar Service / backend Calendar module** → **CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN + CAL-IDOR-XTENANT**: **NÃO expor o Calendar Service antes de threading token + `organization_id` pelo `ToolContext`** — corrigir o contrato sem org-scope transforma o IDOR de latente em CRÍTICO cross-tenant vivo.
- **canon (bevox-knowledge / hub)** @ `0317985` → **EXEC-MODE-FAIL-OPEN** (código diverge da ADR-018 harness / ADR-006 _shared), **C-03/RESUME** (promover ADR ao canon), **STREAM-01** (ADR-016), **CENSUS-PRD-STALE** (PRD retroativo defasado do código pós-2026-06-02).
- **Governança de branches** (o nó desta rodada) → **`test/execution-handler-coverage-uplift`** (rede de invariantes verde — **promover a PR/mergear**); **`op-*`+`finding-j10`** (6 fixes VIVOS provados-mergeáveis — **mergear em sequência limpa atrás de CI**); **`fix/*` mortas (8+) + `fix/complete-callback-contract` stale** (**deletar**); **dependabot bumps `+1`** (**mergear p/ cortar o DEP-AUDIT-DRIFT**); **rebase+re-review de `origin/fix/sdr-ultrareview-findings`** (real, C-06).

---

## Delta vs audit anterior (07-22, 16ª rodada)

**Linhagem de tally:** …07-16 `~8·~20·~36·~33` → 07-17 `~8·~21·~42·~36` → 07-18/19/20/21/22 `~8·~21·~42·~36` → **10-21 `~8·~21·~42·~36` (INALTERADO após ~3 meses)**.

### FECHADOS desde 07-22
**Nenhum.** `git log` (produto) = vazio; `git diff origin/main..HEAD -- src/ migrations/ openapi/ package.json` = 0/0/0/0 `[✓ 10-21]`. **Veredito de piloto/GA inalterado e pré-determinado.**

### NOVOS/refinados desde 07-22
1. **`STASIS-NATURAL-EXPERIMENT` (novo enquadramento)** — a cadência pausou ~3 meses (07-23→10-20) **e o gate não se moveu**, porque o plano de destravamento não foi executado. Prova empírica de que "parar de auditar" não é a ação de valor; "mergear/escrever" é.
2. **`DEP-AUDIT-DRIFT` cruzou para um CRÍTICO de runtime** — `npm audit --omit=dev` 36→**48** (8→**12 HIGH**, **0→1 CRÍTICO**); árvore completa 44→**88** (3 críticos, 34 HIGH). A previsão "super-linear" do 07-22 concretizou-se em ~3 meses de lockfile congelado. Remediação parcial (dependabot `pg`/`pino`/`dotenv` +1) também presa unmerged.
3. **FK `accounts(id)` verificada exaustivamente `[✓ 10-21]`** — além das 3 tabelas de 001, confirmei que 011 dropa+recria `sdr_account_state` (008) e `message_embeddings` (007) sem a FK → o `DROP TABLE accounts` sem CASCADE de 012 sucede de ponta-a-ponta. Fecha a dúvida "trap-atrás-do-trap" que rodadas anteriores não haviam checado.
4. **`fix/issue-40/42/43/44/47` confirmadas `+0` (LANDED)** `[✓ 10-21]` — as fixes de PERM-02/03/05, CTX-02, EM-03 e reasoning-04 estão em `main` por conteúdo; corrobora as anotações "LANDED" do CLAUDE.md e o enquadramento do 07-15 (os `fix/*` são mortos ou traps, não trabalho pendente).
5. **VERSION-SKEW** (novo BAIXO) — `package.json` = `0.1.0` vs tag/imagem prod `v1.0.0`.
6. **Backend moveu `5b5b835`→`7e2a33a`** — só doc de auditoria autônoma (mesma estase cross-repo).

### Variações time-sensitive (as únicas possíveis em código congelado)
| Métrica | 07-22 | 10-21 (`[✓ 10-21]`) | Nota |
|---|---|---|---|
| `npm audit --omit=dev` (runtime) | 36 (1 low, 27 mod, 8 high, 0 crít) | **48 (1 low, 34 mod, 12 high, 1 crít)** | **+12 total, +4 HIGH, +1 CRÍTICO** (advisory drift em ~3 meses) |
| `npm audit` (árvore completa) | 44 | **88 (2 low, 49 mod, 34 high, 3 crít)** | dobrou (toolchain dev + runtime) |
| `TODO/FIXME/…` em `src/` | 6 | **6** | idêntico (2 falso-positivos PT-BR) |
| prettier `--check src/**/*.ts` | 11 | **12** | +1 (drift de formatação; `npm run format` resolve) |
| Suíte `vitest run` | 1236 passed / 57 skipped | **1236 passed / 57 skipped, 0 fail** | verde, re-rodada fresca |
| `git diff origin/main -- src/` | 0 | **0** | freeze intacto (~140d) |
| migrations / bootstrap stages | 15 / 16 | **15 / 16** | idêntico |
| backend HEAD | `5b5b835` | **`7e2a33a`** | +audit-doc only |
| constelação mergeável | 6/6 LIMPO | **6/6 + 3/3 pares LIMPO** | re-provado `[✓ 10-21]` |

**Conclusão do delta:** material de produto = **zero** em ~140 dias. As únicas mudanças de estado são (1) o **drift passivo de segurança** que cruzou para um CRÍTICO de runtime, e (2) a **prova empírica de que pausar a auditoria não destrava — só execução destrava.** Esta 17ª rodada não move nenhum gate de piloto/GA; seu valor é **re-verificar os 3 blockers, fechar a dúvida da FK/008, quantificar o custo crescente, e reformular a recomendação de "pausar" para "executar ou arquivar".**

---

## Correções pendentes ao prompt-mãe e ao CLAUDE.md (byte-verificadas `[✓ 10-21]`)

1. **prompt-mãe (h)** — "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`": os 3 últimos **não existem em NENHUM dos lados**. Reais: `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`.
2. **prompt-mãe (f)** — trata a FK `accounts(id)` como **aberta**: está **FECHADA** (`000`+`011`+`012` em `origin/main`; 011 cobre TODAS as tabelas, incl. 007/008). Remover a pergunta "como fechar definitivamente" e o workaround manual do CLAUDE.md (que agora **conflita** com `000`).
3. **prompt-mãe (g)** — "PRD §212": **fantasma** (o PRD termina no §17; o gate do piloto é §16; MCP é §5.13/§10.3).
4. **prompt-mãe (b)** — cita "ADR-006 execution_mode": é **_shared/ADR-006** (autonomy-permissions) **E harness/ADR-018** (execution_mode 3-modos) — ambos no canon; a fail-open diverge de ambos.
5. **prompt-mãe (cabeçalho)** — "Sessão será revisada por humano amanhã" + a cadência diária: o histórico mostra que a cadência **pausou ~3 meses** e mesmo assim nenhum humano executou o destravamento. Sugestão: trocar o loop de "auditar" por um item de backlog "executar 0a→0c→1-3" com dono.
6. **CLAUDE.md §Infraestrutura** — accounts-FK workaround obsoleto/conflitante; "Dockerfile single-stage" (é 2-stage); "7 estágios" (**16**); "3 agentes" (4, +MemoryCondenser); "faz HEAD em CALENDAR_SERVICE_URL" (é GET `/health`, tolera 404).
7. **CLAUDE.md** — "cobertura Vitest é mínima": **super-dimensionado** (1236 testes passando; hot-path 97-100%).

---

## Notas de método

**Decisão deliberada de NÃO re-executar o fan-out multi-agente de descoberta.** Com o código **byte-idêntico** re-verificado (`git diff origin/main..HEAD -- src/ migrations/ openapi/ package.json` = 0/0/0/0 `[✓ 10-21]`), um novo fan-out reproduziria o mesmo backlog — a **exata inércia** que o prompt-mãe proíbe («não invocar agents por inércia — só os que se aplicam à varredura») e que a memória de projeto (`harness-audit-stasis-pause`, `workflow-multiagent-audit-tooling`) manda evitar. O effort-max foi redirecionado para re-verificação first-hand e o delta de ~3 meses.

**O que fiz (tudo `[✓ 10-21]`, leitura própria em disco nesta sessão):**
- **git-archaeology / freeze:** `git fetch`; `origin/main` = `2979eb0` (inalterado); HEAD `e55e653`; `git diff origin/main..HEAD -- src/ migrations/ openapi/ package.json` = 0/0/0/0; `git diff --stat origin/main..HEAD` = só docs/tests/smoke (7.060 linhas, 0 src).
- **PROVA de merge-topologia:** `git merge-tree --write-tree origin/main origin/<viva>` → **6/6 exit 0**; os 3 pares que tocam `execution-handler.ts` → **3/3 exit 0** (hunks disjuntos confirmados via `git diff ... | grep '^@@'`); `git cherry origin/main origin/<branch>` por branch (vivas +1..+8; snapshots +0; `fix/*` mortas +0, `fix/complete-callback-contract` +4 stale); `git log origin/main -- tests/unit/runtime/invariants/` = 0.
- **Suíte:** `npx vitest run` → 173 files / 1236 passed, 17/57 skipped, exit 0, 18.8s (linhas `level:50` = fixtures negativas propositais, origem dentro dos `.test.ts`).
- **harness em disco:** `env.ts:8-12` (DATABASE_URL+CALENDAR_SERVICE_URL required; BEVOX_DB_URL optional; + CredentialPool/rate-limit/OTEL/circuit-breaker/recorder — muito além do CLAUDE.md), `bevox-callback.ts:28/141` (`post()` POST; `/status` via POST = C-01; 0 PATCH no arquivo), `Dockerfile:1-18` (2-stage; runner só copia `dist`), `stages.ts` (16 `name:`; calendar-health GET `/health`), `migrations/` (000+011+012 presentes; 011 dropa FK de 007/008 `:381`; dois `013_`), grep lexicon `src/`=0, grep TODO=6, prettier=12, `package.json.version`=0.1.0 vs tag `v1.0.0`.
- **Métricas time-sensitive:** `npm audit --omit=dev` = **48 (1 low/34 mod/12 high/1 crít)**; árvore completa **88 (3 crít)**; dependabot runtime bumps (pg/pino/dotenv) = +1 cada (unmerged).

**Agents locais — NÃO invocados nesta rodada (deliberado).** Em código congelado, invocar agents de descoberta é toil; os 2 reviews de merge-readiness forward-looking (op-reasoning-quality = MERGE-WITH-CAVEAT/enum-strategy; op-ctx-tokenizer-budget = MERGE-WITH-CAVEAT/smoke-ou-kill-switch) já foram feitos `[✓ 21]` sobre branches que não mudaram. A próxima invocação de agente de valor é para **IMPLEMENTAR** (0a/0c/1-3), não auditar código congelado.

**Confiança.** Alta em todo achado acionável — cada `arquivo:linha` dos 3 blockers foi lido nesta sessão; a mergeabilidade é **re-provada** por `git merge-tree` (nível-árvore). **Residual/Duvidoso:** (1) `git merge-tree` prova ausência de conflito textual, NÃO correção semântica da união → **CI da união é obrigatório** (a rede-de-teste 0a + testes das branches são o gate). (2) **por que a constelação travou ~140d** não é visível em disco — **confirmar com o dono das branches antes de mergear**. (3) lado-hub do MANIFEST-DB-ENV/NO-MIGRATOR herdado do estado congelado `[✓ 22]` (não re-montei o hub nesta sessão; o harness-side foi relido fresco); se a Hetzner injeta `DATABASE_URL`/roda `migrate` out-of-band, rebaixa — confirmar no runbook. (4) escopo do piloto (draft/SDR/teto-de-custo) condiciona C-02..C-06.

**Meta-nota ao revisor humano (17ª rodada, ~140 dias de estase, 0 commit de produto, após ~3 meses de cadência pausada).** O experimento natural é conclusivo: **pausar a auditoria — sozinho — não destravou nada.** O módulo está no mesmo NÃO-GO de 2026-06-03, agora menos seguro (drift de advisories cruzou um CRÍTICO de runtime). Alguém no hub chegou a **planejar** um refactor de 8 PRs (`spec/plan(harness)`), mas nenhum PR aterrissou. **A decisão não é mais "auditar vs pausar" — é "executar vs arquivar":**
- **Executar** (recomendado): (0a) mergear a rede de invariantes verde; (0c) mergear a constelação provada-mergeável atrás de CI (após confirmar por que travou + as 2 pré-condições); (1-3) escrever os 3 blockers incondicionais sem-branch; deletar as `fix/*` mortas; mergear os dependabot bumps. **~8-12h, majoritariamente trabalho já-escrito e provado-mergeável.**
- **Arquivar** (se o piloto não é mais prioridade): registrar formalmente o módulo como suspenso, parar o slot diário, e preservar as 6 branches vivas + a rede de teste como ponto de retomada.

**Em qualquer dos dois casos: NÃO retomar a cadência diária de auditoria autônoma.** Este relatório e os 16 anteriores dizem a mesma coisa — agora com a prova empírica de ~3 meses de que integrar é barato, esperar é caro, e repetir a auditoria não move o gate.
