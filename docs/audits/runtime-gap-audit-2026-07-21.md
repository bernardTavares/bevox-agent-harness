# Gap Analysis — bevox-harness — 2026-07-21

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-07-20.md` (linhagem: `07-20`/`07-19`/`07-18`/`07-17`/`07-16`/`07-15`/`07-14`/`07-08`/`07-07`/`07-05`/`07-04`/`06-23`/`06-04`/`06-02` — esta é a **15ª rodada**).
> **HEAD auditado:** `1cfed57` (branch `test/execution-handler-coverage-uplift`) — o commit do doc 07-20. `src/` + `migrations/` **byte-idênticos a `origin/main` @ `2979eb0`** (2026-06-03). **Zero commits de produto desde 2026-06-03** (~48 dias); tudo desde então (exceto docs de auditoria) é test-only ou doc.
>
> **Freeze re-verificado FRESCO nesta sessão (leitura própria, marcada `[✓ 21]` — não citada de memória nem do 07-20):**
> 1. **harness** — `git diff origin/main HEAD -- src/ migrations/` = **0 linhas** (produto + schema byte-idênticos a `origin/main` @ `2979eb0`, **~48 dias**). `git status` = só `docs/` + `.claude/worktrees/` untracked. **Suíte verde re-rodada `[✓ 21]`:** `npx vitest run` = **173 files / 1236 tests passed**, 17/57 skipped, **0 falhas**, exit 0 (as linhas `level:50` são fixtures de caminho-negativo propositais — poison payloads, "backend down" do `perm-03-ordering.test.ts:224`, métricas de dead-letter — não erros).
> 2. **backend** `bevox-backend` @ `7ae1aa5` — **moveu de `6f6867d` (07-20)**, mas o commit é ele próprio um **doc de auditoria autônoma** (`docs(audit): runtime gap audit 2026-07-20`). A estase cross-repo continua idêntica nos dois repos.
> 3. **canon** `bevox-knowledge` @ `0317985` (2026-06-02) — congelado; PRD + ADRs relidos `[✓ 21]` (§ até 17, sem "212"; ADR-018 harness + ADR-006 _shared presentes).
> 4. **hub** `bevox-PRD-consolidation` — **NÃO re-lido nesta sessão** (não montado no path esperado em disco). Os 2 blockers dependentes do hub (`MANIFEST-DB-ENV`, `NO-MIGRATOR`) foram re-verificados **do lado harness** `[✓ 21]`; o lado-manifest herda a leitura fresca do 07-20 (`fd1373b`, congelado) + memória `manifest-db-env-deploy-blocker`. **Confirmar com o dono do hub.**
>
> **Método (effort-max redirecionado — ver §"Notas de método"):** dado o freeze de ~48 dias re-confirmado, **NÃO** re-executei o fan-out multi-agente de *descoberta* (reproduziria backlog byte-idêntico — a exata inércia que o prompt-mãe proíbe e que a memória de projeto `harness-audit-stasis-pause` manda evitar). O effort-max desta rodada foi para **provar formalmente a topologia de merge da constelação não-mergeada** (`git merge-tree`) e **verificação de merge-readiness forward-looking** das 2 branches comportamentalmente mais arriscadas (via agents locais). **O achado material desta rodada (o mais forte desde o mapeamento do 07-20): a constelação inteira mergeia LIMPO — em `main`, entre si, e em sequência — provado por `git merge-tree`.** O gap dominante segue de *integração*, mas o custo estimado de integração **caiu** (de "rebase/triagem por-fix" para "merges sequenciais limpos atrás de um gate de CI").
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

**Nada de produto mudou em ~48 dias; o veredito é pré-determinado — PILOTO: NÃO-GO · GA: NÃO-GO — e esta 15ª rodada não o move.** O cluster CRÍTICO/ALTO/MÉDIO/BAIXO do 07-20 (`~8·~21·~42·~36`) sobrevive integralmente por construção (código congelado); **0 CRÍTICO/ALTO fechados** (0 commits de produto). Os 3 blockers de deploy **incondicionais** (`MANIFEST-DB-ENV`, `NO-MIGRATOR`, `C-01`) foram **re-lidos linha-a-linha do lado harness `[✓ 21]`** e **sobrevivem sem branch de remediação**.

**O delta material desta rodada endurece — não repete — o achado do 07-20.** O 07-20 mapeou a `UNMERGED-CONSTELLATION` e advertiu "as 5 branches se sobrepõem em `execution-handler.ts` → NÃO mergear em bloco". **Esta rodada PROVA que essa cautela era conservadora demais: as branches tocam o mesmo arquivo em faixas de linha DISJUNTAS.** Verificação formal `[✓ 21]` via `git merge-tree`:

- **Cada branch viva** (`finding-j10`, `op-openapi-sync`, `op-pipeline-json-robustness`, `op-ctx-tokenizer-budget`, `op-reasoning-quality`, `op-ctx-semantic-recall`) mergeia **LIMPO em `origin/main`** (exit 0, 0 conflitos).
- **Todos os pares** entre as branches que tocam `execution-handler.ts` mergeiam **LIMPO entre si** (`reasoning × tokenizer`, `reasoning × j10`, `tokenizer × j10`, `reasoning × pipeline`, `tokenizer × pipeline` — todos exit 0).
- A **simulação sequencial** `main → reasoning → tokenizer → j10 → pipeline → openapi` (árvores encadeadas via `git merge-tree --write-tree`) é **100% LIMPA** em todos os 5 passos.

**Consequência prática:** o custo de integração da constelação **não é "rebase-hell"** — é **merge sequencial limpo atrás de CI**. A ordem de merge importa só para bisectabilidade/raio-de-dano, não para conflitos. O backlog de *escrita* real segue sendo **apenas 3 itens incondicionais sem branch**: `MANIFEST-DB-ENV` (~0.5h), `NO-MIGRATOR` (~1.5h), e a **raiz** do `C-01` (verbo PATCH, ~1h — `finding-j10` já neutraliza o desfecho fatal no caminho `running`). Tudo o mais de endurecimento de raciocínio/contexto/pipeline **já está escrito, verde e agora provado-mergeável**.

**Ressalva de honestidade:** `git merge-tree` prova ausência de conflito **textual** (nível-árvore), NÃO a correção **semântica** da união — isso exige CI rodando a união (a rede de invariantes já-verde + os testes que cada branch carrega são exatamente esse gate). E **não é visível em disco POR QUE a constelação travou ~48 dias** — uma branch pode ter sido abandonada por um motivo real (regressão pega em review). **Confirmar com o dono das branches antes de mergear** é pré-condição inegociável (ver §Notas de método para o veredito dos 2 reviews de merge-readiness desta rodada).

**Único delta numérico time-sensitive:** `npm audit --omit=dev` moveu **32 → 33 vulnerabilidades, com um 5º HIGH** (`1 low, 27 moderate, 5 high` vs `07-20: 0 low, 28 moderate, 4 high`) — o lockfile está congelado, então isso é **drift da base de advisories**: o custo de segurança do freeze **cresce passivamente** enquanto ninguém mergeia. Reforça, não contradiz, a recomendação #0.

**O achado dominante continua sendo de PROCESSO — agora na 15ª rodada.** Auditar código byte-idêntico pela 15ª vez é toil de valor marginal ≈ 0; 5 rodadas consecutivas (07-16..07-20) elevaram "pausar a cadência" a recomendação #0 e **eu concordo e a mantenho**. A diferença acionável desta rodada é que o caminho de destravamento agora está **formalmente provado como barato** (merges limpos, não rebases) — o que remove a última desculpa técnica para não integrar.

**Correções duráveis re-confirmadas `[✓ 21]` (o prompt-mãe E o CLAUDE.md continuam desatualizados — ver §Correções):** (f) FK `accounts(id)` tratada como aberta — **FECHADA** (`000`+`011`+`012` em `origin/main`); (g) "PRD §212" é **fantasma** (o PRD termina no §17); (h) "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`" — os 3 últimos **não existem**; "cobertura Vitest mínima" (CLAUDE.md) é **super-dimensionado** (1236 testes verdes); "Dockerfile single-stage" e "7 estágios" são **falsos** (2-stage; ≥9 estágios).

---

## Achados por severidade

> Convenção: `arquivo:linha` no HEAD `1cfed57` (== `origin/main` em `src/`). **`[✓ 21]`** = **lido e hand-verificado por mim NESTA sessão (2026-07-21)**, em disco. `SOBREVIVE` = re-aberto e confirmado por freeze de código. `Eh` = esforço estimado. Para o detalhe exaustivo item-a-item do latent-tail herdado (~42 MÉD + ~36 BAIXO), ver `runtime-gap-audit-2026-07-17.md` §"Achados por severidade" — **não re-derivado aqui por disciplina anti-toil**; o freeze de `src/` garante paridade 1:1 (memória `harness-audit-stasis-pause`; recomendação #0 de 5 rodadas).

### 🔴 CRÍTICO — bloqueia o piloto

> Os 3 incondicionais foram **re-lidos linha-a-linha do lado harness nesta sessão `[✓ 21]`**. Coluna "branch" distingue *sem-branch* (precisa escrita) de *mitigado por branch viva provada-mergeável*.

#### Incondicionais (bloqueiam o piloto em QUALQUER escopo)

- **MANIFEST-DB-ENV (SOBREVIVE, `[✓ 21]` lado-harness) — o pacote de deploy pinado crash-loopa no boot.**
  - Harness `src/config/env.ts` (relido `[✓ 21]`): `:8 DATABASE_URL: z.string().url()` **(required)**, `:11 BEVOX_DB_URL: z.string().url().optional()` **(opcional; nunca lido pelo pool)**, `:12 CALENDAR_SERVICE_URL: z.string().url()` **(required)**. `getEnv()` faz `safeParse` → `:206 process.exit(1)` em falha.
  - Hub `infra/bevox-prod-manifest.yaml` (herdado do 07-20 `[✓ 20]`, congelado `fd1373b`): supre `BEVOX_DB_URL` mas **OMITE `DATABASE_URL` E `CALENDAR_SERVICE_URL`**. Imagem pinada = v1.0.0 (2026-06-01), anterior ao baseline do freeze.
  - → `safeParse` falha em 2 required → `process.exit(1)` **antes do stage 1 (`infra-check`)** → 2 réplicas em crash-loop → 0 jobs consumidos → 100% dos jobs batem no 120s-timeout-scan do backend → handoff/dead_letter. **Fix harness-side ~1 linha:** `DATABASE_URL: z.string().url().optional()` + refino `DATABASE_URL ?? BEVOX_DB_URL`, e relaxar/suprir `CALENDAR_SERVICE_URL` (o stage `calendar-health` já tolera qualquer status HTTP). `Eh≈0.5h`. **Sem branch — ESCREVER.**

- **NO-MIGRATOR (SOBREVIVE, `[✓ 21]`) — o schema do harness nunca é criado no deploy pinado.**
  - `Dockerfile` (relido `[✓ 21]`, **2-stage**): `builder`(`:1 FROM node:20-alpine AS builder`) copia `src`(`:6`)+`scripts`(`:7`) e roda build; `runner`(`:10 FROM … AS runner`) copia **só** `COPY --from=builder /app/dist ./dist`(`:16`) → `migrations/` E `scripts/migrate.mjs` estão **fisicamente ausentes** da imagem de prod (`CMD ["node","dist/index.js"]` `:18`). Sem sidecar de migração no manifest. **CLAUDE.md §Infra diz "Dockerfile single-stage" — FALSO** (é 2-stage `[✓ 21]`). **Fix:** copiar `scripts/`+`migrations/`(+deps de migração) no runner, OU job de migração no deploy do hub. `Eh≈1.5h`. **Sem branch — ESCREVER.**

- **C-01 (SOBREVIVE, `[✓ 21]` lado-harness) — `updateStatus` por POST contra rota PATCH-only → 404 no 1º callback.**
  - Harness `src/integration/bevox-callback.ts` (relido `[✓ 21]`): helper `post()`(`:15`) crava `method:"POST"`(`:28`); `updateStatus`(`:133`) chama `post('/api/v1/executions/${id}/status', ...)`(`:141`). Os outros 3 usam o mesmo `post()`: `/traces`(`:103`), `/stream`(`:113`), `/complete`(`:155`).
  - Backend `7ae1aa5` `src/integration/harness-callbacks.routes.ts` (herdado do 07-20, backend só moveu por audit-doc): rota `/status` é **`PATCH`**; os outros 3 verbos batem (POST). → `updateStatus(...,"running")` é o 1º `await` do try genérico → 404 → error-boundary. **`finding-j10-running-status` já resolve o DESFECHO fatal** (envolve a chamada num `.catch()` best-effort — o blip não mata mais a execução), mas **NÃO corrige a RAIZ** (verbo) nem o `STATUS-02` (dead_letter via mesmo POST/status → 404 → UI de replay nunca acende). **Fix raiz:** helper `patch()` para `/status`. `Eh≈1h` (co-fixar com C-07). **Sem branch para a raiz.**
  - **STATUS-02 (SOBREVIVE)** — mesmo POST-vs-PATCH mata o `dead_letter` autoritativo. `finding-j10` NÃO cobre esta chamada. Fechado ao corrigir a raiz do C-01.

- **C-07 (SOBREVIVE) — `sentiment` da pipeline não-validado → `/complete` 400 em output malformado (co-fix do C-01).** Enum backend = 6 valores; `message-analyzer.agent.ts` faz cast cru. Mascarado hoje pelo C-01. **`op-pipeline-json-robustness` adiciona `extract-json.ts` + endurece os 3 pipeline agents** — não é o clamp de enum exato, mas é a robustez de parsing adjacente que reduz a superfície. Fix: `safeParse`+clamp de `sentiment`. `Eh≈1-2h`.

#### Condicionais ao escopo do piloto (CRÍTICO **se** o piloto inclui modos draft e/ou cadência SDR; senão ALTO)

> **Ação ao revisor: confirmar se o piloto usa `manual_assisted`/`copilot` (aciona C-02/AUD-PROPOSAL) ou a esteira SDR/Model-C (aciona C-03..C-06).**

- **C-02 (SOBREVIVE) — `proposals[]` sem `idempotency_key` → `/complete` 400 nos modos draft.** `Eh≈0.5h`. Guardado por `em-03-proposals-end-to-end.test.ts` (rede não-mergeada).
- **C-03 (SOBREVIVE) — esteira SDR/cadência/Model-C/resume morta na fiação viva.** `scheduler.agent.ts` sem `workflow:`; `resume-server.ts`/`subscriber.ts` dead-code (flag default-off). `Eh≈6-8h`.
- **C-04 (SOBREVIVE) — timeout de não-resposta marca cadência `failed` em vez de avançar.** Cobertura real 0%. `Eh≈4-6h`.
- **C-05 (SOBREVIVE) — Model-C sem error boundary + dedup key retida → execução perdida.** `Eh≈3-5h`.
- **C-06 (SOBREVIVE) — respostas vivas nunca qualificam lead nem honram opt-out (risco LGPD).** `execution-handler.ts:565` crava `observedSignals:{}`. Substância do fix vive UNMERGED em `origin/fix/sdr-ultrareview-findings`. `Eh≈8h`.

### 🟠 ALTO — bloqueia GA, não necessariamente o piloto

> Cluster do 07-17/07-20, SOBREVIVE integralmente. **🔧 = tem fix VIVO provado-mergeável** (`[✓ 21]`).

- **CLASSIFIER-TIMEOUT-CRASH (SOBREVIVE)** — `error-classifier.ts` faz `(e.code ?? "").toUpperCase()`; `.code` de `DOMException{name:"TimeoutError"}` é numérico → `TypeError` numa função que promete "Never throws" → timeouts de LLM nunca retried. **Fix 1 linha (`String(e.code ?? "")`), maior ROI técnico da lista.** `Eh≈0.25h`. (Nota: `op-reasoning-quality` mexe em `errors.ts` mas o alvo lá é o enum `AbortReason`+`invalid_plan`, **não** este `error-classifier.ts` — este permanece **sem fix vivo**.)
- **STRATEGY-FAILED-AS-DONE (SOBREVIVE)** — falha genérica finalizada como `done` (`/complete{responseText:"", strategy:"failed"}` in-enum → 200). Sink do CLASSIFIER-TIMEOUT e do PHASE-TIMEOUT. `Eh≈2h`.
- **🔧 R-01 / R-02 (SOBREVIVEM; fix VIVO provado-mergeável)** — loop ReAct não devolve observações ao LLM e a escalação p/ plan-execute é natimorta. **`op-reasoning-quality` (`react.ts` +15/-1, `reflexion.ts`, `execution-context.ts` +15, `errors.ts` +8/-1, `execution-handler.ts` +131/-16) faz o threading de reflexion no `systemPrompt` e trata a escalação** — escrito, verde, **fora de `main`**, e `[✓ 21]` **mergeia limpo**. Maior risco de QUALIDADE do piloto (default-ON). Guardado por `surface-loop-escalation.test.ts`/`surface-loop-rewoo.test.ts` + `engine-swap-mid-loop.test.ts` (rede não-mergeada). `Eh` (integração) `≈2-3h` vs `≈5-8h` de escrita do zero. **Ver §Notas de método para o veredito de merge-readiness.**
- **🔧 TOKENIZER-UNDERCOUNT / NEW-CTX-01 (SOBREVIVEM; fix VIVO)** — **`op-ctx-tokenizer-budget` (`tokenizer.ts` +112/-12, `budget-enforcer.ts` +56/-25, `calibration.ts` +20, `execution-handler.ts` +19) endurece a contagem de tokens e o budget (BPE model-aware via `js-tiktoken@1.0.21`, fail-open)** — escrito, verde, fora de `main`, `[✓ 21]` **mergeia limpo**. Guardado por `budget-enforcer/calibration/tokenizer.test.ts` + `ctx-02-budget-enforce.test.ts`. **Ver §Notas de método.**
- **CP-02 (SOBREVIVE, cross-repo) — `contact_id` ausente no contrato de dispatch → ContextBuilder pulado em 100% dos jobs.** Pré-requisito de TODO valor do ContextBuilder e do fix do IDOR-read. `Eh≈1-2h` + 1 PR backend.
- **CP-01 (SOBREVIVE) — backend despacha histórico ilimitado; harness poison-dropa além de `messages.max(100)`.** `Eh≈2-4h`.
- **CB-NEW-03 (SOBREVIVE) — abort J8 emite `strategy` off-enum (`aborted_timeout`/`aborted_cost`) → `/complete` 400 engolido.** `Eh≈1h`.
- **CAL-IDOR-XTENANT + CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN (SOBREVIVEM, LATENT)** — surface de calendário confia em `appointment_id`/`calendar_id` do LLM sem org-scope nem token. Gated hoje pela ausência de Calendar Service no MVP → **vira CRÍTICO cross-tenant ao corrigir o contrato sem adicionar org-scope+token.** `Eh≈1-2h` + Médio.
- **IDOR-CONTACT-PARAM (SOBREVIVE) — `read-profile` confia no `contact_id` do LLM → exfiltração de PII intra-org.** Boundary de org SEGURO (repo scoped por `organizationId`). Fix depende de CP-02. `Eh≈0.5-1h`.
- **REFLEXION-NOTES-UNREAD · REWOO-UNREACHABLE · CTX-RULES/HISTORY-DEAD · AUTHZ-ALLOWLIST · AUD-PROPOSAL-CHECK(014) · USAGE-01 · OBS-LLM-METRICS/OBS-OTEL-OFF/LLM-NO-FAILOVER · D-01/D-05 · PRD-ADR017-OWNERSHIP/ADR019-LGPD-ORPHAN · STREAM-01/RAG-NO-RUNTIME-INDEXER/MCP-cluster** (SOBREVIVEM, vários LATENT atrás de flags/contratos). `REFLEXION-NOTES-UNREAD` é parcialmente endereçado por `op-reasoning-quality` (🔧). Detalhe no 07-17.

### 🟡 MÉDIO — degrada qualidade (SOBREVIVEM do 07-17/07-20)

- **EXEC-MODE-FAIL-OPEN (SOBREVIVE, `[✓ 21]`, vs canon) — `execution_mode` cai default no ÚNICO modo de mutação real, contra a ADR-018 (harness) / ADR-006 (_shared) "obrigatório".** `execution-handler.ts:673` (`ExecutionModeSchema.optional().default("autonomous_supervised")`). Backend **sempre envia** (required) mas o schema do harness inverte a garantia — um replay/legado que omita executa create/cancel/send **sem aprovação**. Fix: required (fail-closed) OU default `manual_assisted` (fail-safe). `Eh≈0.5h`.
- **Demais MÉD (SOBREVIVEM):** `NEW-CTX-01` (🔧 fix vivo em `op-ctx-tokenizer-budget`), `MCP-MUTATION-UNGATED`, `CB-BASEURL-IGNORED`, `USAGE-TABLE-DEAD` (PRD §5.17 — `execution_usage` nunca escrita), `WF-COMPLETE-DOUBLE`/`WF-SUSPEND-CLOSES`, `DOUBLE-COMPLETE-REQHUMAN`, `PHASE-TIMEOUT-TERMINAL`, `LLM-MODEL-DOWNGRADE`, `IDOR-WRITE`(inalcançável), `SYNTH-STOP-REACT-ONLY`, `IDEMP-NONDET-PARAMS`, `CP-03`, `TRUNC-DOCTRINE-DROP`, `TOKENIZER-UNDERCOUNT`(🔧), `CALENDAR-NO-RETRY`, `QUEUE-NAME-OBS-TRAP`, `D-02`/`D-03`, `MEM-INDEXER-DUP`, `MEM-CONDENSE-NO-CONSUMER`, `CTX-SILENT-DEGRADE`/`TRACES-01`/`STATUS-01-PAUSED`, `SEC-AUDIT-RED`, `CI-LINT-RED`. Detalhe no 07-17.

### 🟢 BAIXO — higiene (SOBREVIVEM do 07-17/07-20)

- **DEP-AUDIT-DRIFT (NOVO numérico `[✓ 21]`) — `npm audit --omit=dev` = 33 (1 low, 27 mod, **5 high**), vs 07-20 = 32 (28 mod, 4 high).** Lockfile congelado → é drift de advisory DB: **um 5º HIGH surgiu passivamente**. Único delta numérico da rodada. Reforça que o freeze tem custo de segurança crescente. `Eh` (após unfreeze)`≈dependabot já abriu PRs`.
- **DOC-DRIFT (SOBREVIVE, `[✓ 21]` re-confirma `CLAUDE.md` §Infraestrutura):** (a) accounts-FK trap descrito ABERTO com workaround `CREATE TABLE accounts…; DROP…` — **OBSOLETO e CONFLITA** com `000_accounts_stub.sql`+`011`+`012_drop_accounts_stub.sql` (`[✓ 21]` — trap FECHADO); (b) "Dockerfile single-stage" — FALSO (2-stage `[✓ 21]`); (c) "7 estágios" — FALSO (**≥9**); (d) "3 agentes" (4, +MemoryCondenser); (e) `calendar-health` "faz HEAD" — é **GET `/health`** e tolera qualquer status HTTP. `Eh≈1h`.
- **🔧 OPENAPI drift (SOBREVIVE; fix VIVO provado-mergeável em `op-openapi-sync`):** `SENTIMENT-ENUM-DOC-DRIFT` (openapi lista 3, backend aceita 6); `OPENAPI-REQUEST-LEXICON-STALE` (request ainda `account_id`/`account`); `OPENAPI-COMPLETE-FIELD-DRIFT` (`response` vs `response_text`). `op-openapi-sync` (0 src, doc-only) já reescreve o spec — `[✓ 21]` mergeia limpo. `Eh` (merge)`≈S`.
- **MARCO1-VERSIONING / CENSUS-PRD-STALE (SOBREVIVEM):** payload sem campo de versão; PRD §5.1 `HARNESS_QUEUE_NAME` stale, §11 "7 migrations" (real: 15 arquivos 000–013, dois `013_`). **Código é o lado correto.** `Eh≈2h`.
- **Demais BAIXO (SOBREVIVEM):** `WORKFLOW-FWD-DEAD`, `PERM-BLACKLIST-ORPHAN` (`account_denied_tools` ausente do `dispatch.schema.ts` backend), `NEW-RWO-01`, `CP-04`, cluster de testes-máscara, `OBS-REDACT-SHALLOW`, `MIG-DUP013` (non-hazard), `ACCOUNT-LEXICON` (`src/`=**0** `[✓ 21]`).

---

## 🆕 O delta material — a constelação não-mergeada é PROVADA-MERGEÁVEL

**`UNMERGED-CONSTELLATION` (endurecido `[✓ 21]` por `git merge-tree`; severidade: oportunidade ALTA / dívida de integração agora BAIXA).** O 07-20 mapeou a constelação e recomendou triagem cuidadosa por temor de sobreposição em `execution-handler.ts`. **Esta rodada refuta o temor com prova formal.**

### Prova de topologia de merge (`git merge-tree`, `[✓ 21]`)

| Teste | Resultado |
|---|---|
| Cada branch viva `+ origin/main` | **6/6 LIMPO** (exit 0) |
| `reasoning × tokenizer`, `× j10`, `× pipeline`; `tokenizer × j10`, `× pipeline` | **5/5 pares LIMPO** (exit 0) |
| Sequencial `main→reasoning→tokenizer→j10→pipeline→openapi` (árvores encadeadas) | **5/5 passos LIMPO** |

**Por que:** os hunks em `execution-handler.ts` são **disjuntos** nas coordenadas-base (`[✓ 21]`, headers `@@`): `finding-j10` toca **só ~L1407**; `op-ctx-tokenizer-budget` toca {L62, L1182, L1199, L1703, L1727}; `op-reasoning-quality` toca {L33, L488, L831–L1005, L1906, L1925}. **Nenhuma faixa se sobrepõe** (o mais próximo, reasoning-L33 vs tokenizer-L62, dista 29 linhas — merge 3-way auto-resolve). `op-pipeline-json-robustness` não toca `execution-handler.ts`. Logo: **a constelação inteira aplica-se em `main` sem um único conflito, em qualquer ordem.**

### Branches VIVAS (`op-*` + `finding-j10`) — fixes de produto escritos, verdes, provados-mergeáveis

| Branch | src delta (vs `origin/main`) | Fecha/mitiga | Merge `[✓ 21]` |
|---|---|---|---|
| `finding-j10-running-status` | `execution-handler.ts` (+11/-1) | **C-01 raio de dano** | LIMPO. `updateStatus("running")` em `.catch()` best-effort. |
| `op-openapi-sync` | 0 src (openapi/docs) | OPENAPI-*-DRIFT | LIMPO. Reescreve o spec p/ o contrato atual. |
| `op-pipeline-json-robustness` | `extract-json.ts`(+133) + 3 pipeline agents | **C-07-adjacente** | LIMPO. Extração JSON robusta (MessageAnalyzer/MemoryExtractor/MemoryCondenser). |
| `op-ctx-tokenizer-budget` | `tokenizer/budget-enforcer/calibration/execution-handler` (+207) | **TOKENIZER-UNDERCOUNT/NEW-CTX-01** | LIMPO. BPE model-aware + `js-tiktoken@1.0.21` + telemetry CTX-04/05. |
| `op-reasoning-quality` | `react/reflexion/execution-context/errors/execution-handler` (+175) | **R-01/R-02**, REFLEXION-NOTES, ReWOO-cíclico | LIMPO. Threading de reflexion + `AbortReason "invalid_plan"`. **⚠️ muda `/complete.strategy` p/ nome-do-engine-escalado (CB-NEW-03-adjacente) → checar enum backend antes de mergear.** |
| `op-ctx-semantic-recall` | 0 src (test-only; recall inert em main) | — | LIMPO. |

### Branches MORTAS (`fix/*`) — deletar, não integrar (herdado do 07-20, inalterado)

`fix/migration-accounts-stub` e `fix/skill-loader-esm-import` = **já em `main` por conteúdo** (redundantes). `fix/complete-callback-contract` = **STALE pré-SKILLS-05** (mexe em `*.tool.ts` deletados; NÃO corrige o C-01). `fix/rules-payload-organization-id` = doc-only. **Deletar as 4.**

### `NET-UNMERGED` — a rede de segurança de teste (re-confirmada `[✓ 21]`)

A branch atual `test/execution-handler-coverage-uplift` carrega **19 commits `test(harness):`** (2026-06-03/04) — invariantes de handler + smoke round-trip, **verde `[✓ 21]` (1236 passed) e nunca em `main`**. `perm-03-ordering` (audit escrito mesmo se `sendComplete` lança), `x-execution-token-header` (token em todo callback), `em-03-proposals-end-to-end` (C-02), `proposals-accumulator-isolation`, `ctx-02-budget-enforce` (🔧 tokenizer), `engine-swap-mid-loop` (🔧 reasoning), `otel-root-span-hierarchy`. Além disso, `scripts/smoke/01-execution-roundtrip.{ts,sh}` dá o round-trip local via BullMQ — a ferramenta de verificação manual pós-`docker:up` para os fixes de deploy.

**Impacto integrado:** o caminho de destravamento é **mais barato do que o 07-20 estimou**: **(0a)** mergear a rede de teste (substrato de regressão, test-only, verde) → **(0c)** mergear a constelação VIVA **em sequência limpa** (não rebase-hell — provado) atrás do CI → **(1-3)** escrever os 3 blockers incondicionais sem-branch. **A dívida é de governança de integração, e agora está quantificada como baixa.**

---

## Cobertura por categoria do prompt (a–k)

| Cat | Tema | Veredito desta rodada (2026-07-21, `[✓ 21]`) |
|---|---|---|
| **a** | PRD vs implementado | PRD `2026-05-15-…-v1` (retroativo) majoritariamente em sincronia. Gate do piloto = **§16 "Critérios de prontidão" (EM ANDAMENTO)**: falta contrato versionado, contract-test e2e, OpenAPI atualizado (🔧 `op-openapi-sync`). **PRD termina no §17 `[✓ 21]` — "PRD §212" do prompt = fantasma.** |
| **b** | execution_mode (ADR-018 harness / ADR-006 _shared) | 3 modos parseados e propagados (`AgentExecutionContext.executionMode`→`mutationExecute`→`executeOrPropose`). **`EXEC-MODE-FAIL-OPEN`** (MÉD): `execution-handler.ts:673` default no modo de mutação-real. Backend sempre envia (required). C-02 mata retorno draft. Guardado por `em-03-proposals-end-to-end.test.ts` (não-mergeado). |
| **c** | Léxico `account_id`/`workspace_id` | **`src/` = 0** (`grep -rEn "(account_id\|workspace_id)" src/` = 0 `[✓ 21]`). `resolveOrganizationId` = **0** (bridge colapsada — confirmado `[✓ 21]`). Migrations 001–010 têm `account_id` histórico (54 hits, superseded por 011, preservado por regra). Resíduo só no openapi request (🔧 `op-openapi-sync`). |
| **d** | Testes faltando | Suíte **verde: 1236 passed / 57 skipped** (`[✓ 21]`, `vitest run`, exit 0, 190 arquivos). "cobertura mínima" (CLAUDE.md) **super-dimensionado**. **Rede de invariante existe mas NÃO em `main`.** Gaps reais: `state-store.ts` (C-04), `resume-server`/`subscriber` (dead), `error-classifier` input-timeout numérico (CLASSIFIER-TIMEOUT — **sem** fix vivo). **#1 faltante: contract-e2e vs Zod IMPORTADO do backend.** |
| **e** | Dívida conhecida | `grep TODO\|FIXME\|HACK\|XXX\|@deprecated src/` = **6** (`[✓ 21]`, benignos: `errors.ts:23` abort-TODO, `bevox-callback.ts:86` usage-TODO C13, `harness.ts` 3×`@deprecated`, `memory-condenser.prompt.ts:23` "TODOS os fatos" = **falso-positivo PT-BR**). Dívida real = dead-code (ReWOO waves, Reflexion notes [🔧 op-reasoning-quality], resume-server/subscriber, condense-worker não-deployado). |
| **f** | Migrations accounts(id) FK | **FECHADO** (`[✓ 21]`: `migrations/` tem `000_accounts_stub.sql` (CREATE) + `011_organization_id_tenancy.sql` (dropa os 5 FKs, documenta accounts retirada) + `012_drop_accounts_stub.sql` (remove o stub); `ls migrations/` = 15 arquivos c/ 000+011+012). **A categoria (f) do prompt E os workarounds do CLAUDE.md (harness+hub) estão OBSOLETOS e CONFLITAM** — remover os passos manuais `CREATE TABLE accounts…; DROP…`. `MIG-DUP013` non-hazard. |
| **g** | MCP server | **Funcional, fail-closed** (PRD §5.13/§10.3, **não "§212"** `[✓ 21]`). `env.ts MCP_EXPOSED_SKILLS` optional, vazio = nada exposto; `send-message`/`request-human` nunca expostos. Cluster LATENT se exposto (`MCP-MUTATION-UNGATED`). |
| **h** | Callbacks (X-Execution-Token) | **4 endpoints reais:** harness `updateStatus→/status`(`:141`, **POST — bug C-01**), `sendTrace→/traces`(`:103`), `sendStream→/stream`(`:113`), `sendComplete→/complete`(`:155`); backend serve `/status`(PATCH)/`/traces`(POST)/`/stream`(POST)/`/complete`(POST). **`/artifact`,`/tool-result`,`/turn` do prompt NÃO EXISTEM em NENHUM lado.** Defeitos: **verbo** (`/status` POST vs PATCH = C-01) + **body** de `/complete` (C-02/C-07/CB-NEW-03/AUD-PROPOSAL/USAGE). |
| **i** | Bootstrap stages | **≥9 blocos `name:`** (`[✓ 21]` herdado: infra-check/load-config/register-agents/warmup-pipeline/load-tools-permissions/calendar-health/start-dev-ws/init-evals/start-consumer) — CLAUDE.md "7" stale. `calendar-health` faz **GET `/health`** e **tolera qualquer status HTTP** (só `.catch` em rejeição de rede/timeout). Todos gate por throw. |
| **j** | Alçapões p/ piloto | **MANIFEST-DB-ENV + NO-MIGRATOR = o deploy não sobe/não processa (sem branch, `[✓ 21]` lado-harness).** Depois: **C-01** (raiz sem branch; raio-de-dano mitigado por `finding-j10` provado-mergeável), **C-07**, **CP-02+R-01/R-02+REFLEXION** (🔧 `op-reasoning-quality`), **CLASSIFIER-TIMEOUT-CRASH** (sem fix vivo), `LLM-MODEL-DOWNGRADE`/`PHASE-TIMEOUT-TERMINAL`/`DOUBLE-COMPLETE-REQHUMAN`, `CAL-*` (se Calendar ligado), `IDOR-read`, `CP-01`, `USAGE-01`, `OBS-OTEL-OFF`. |
| **k** | Delta vs audit anterior | **0 CRÍT/ALTO fechados/abertos** (0 commits de produto). Freeze re-provado em disco. **Delta material = a constelação é PROVADA-MERGEÁVEL** (`git merge-tree`: 6/6 branches + 5/5 pares + 5/5 sequencial LIMPO) → custo de integração revisado de "rebase por-fix" p/ "merge sequencial atrás de CI". Único delta numérico: `npm audit` 32→33 (+1 HIGH). Backend moveu `6f6867d`→`7ae1aa5` (só audit-doc). |

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

> Critério: desbloqueio de piloto × esforço. **NOVO nesta rodada:** o custo de *0c* caiu — a constelação é provada-mergeável, não rebase-hell.

0a. **MERGEAR a rede de invariantes já-verde em `main`** (`~0.5-1h`, promover a PR + CI). Test-only, verde `[✓ 21]`, substrato de regressão para tudo abaixo. **Primeiro commit não-doc para `main` desde 2026-06-04.**
0b. **META — PAUSAR as auditorias autônomas até haver commit de produto** (`0h`). 15 rodadas sobre código byte-idêntico; valor marginal ≈ 0. Redirecionar o slot diário para (0a)/(0c)/1-3.
0c. **MERGEAR a constelação VIVA em sequência limpa** (`op-openapi-sync` → `finding-j10` → `op-pipeline-json-robustness` → `op-ctx-tokenizer-budget` → `op-reasoning-quality`), **cada um atrás do CI** (rede-de-teste 0a + testes que cada branch carrega). **Provado-mergeável `[✓ 21]` — sem rebase-hell.** **Confirmar antes por que travaram ~48d** (pré-condição). Ordem por raio-de-dano crescente. `Eh≈3-5h` de merge+CI (revisado p/ baixo vs 07-20). **2 pré-condições dirigidas dos reviews de merge-readiness (§Notas de método):** (i) antes de `op-reasoning-quality`, **confirmar que o enum `strategy` do backend tolera nomes-de-engine escalados** (senão vira `/complete` 400); (ii) `op-ctx-tokenizer-budget` com **smoke pós-merge OU kill-switch default-off** (telemetria nova sem cobertura de handler).
1. **MANIFEST-DB-ENV — `DATABASE_URL: .optional()` + fallback `?? BEVOX_DB_URL` no `env.ts`** (+ relaxar/suprir `CALENDAR_SERVICE_URL`) (`0.5h`). Fecha o crash-loop sem tocar o hub. **Sem branch — ESCREVER.**
2. **NO-MIGRATOR — copiar `scripts/`+`migrations/`+deps no runner OU job de migração no deploy** (`~1.5h`). **Sem branch — ESCREVER.**
3. **C-01 raiz + C-07 — `/status` por PATCH (helper `patch()`) E clamp de `sentiment`** (`~2h`). C-01 isolado é o maior ROI mas expõe C-07; fecha STATUS-02 de graça. **Sem branch — ESCREVER** (embora `finding-j10` [0c] já neutralize o desfecho fatal no caminho `running`). Guardado por `perm-03-ordering`+`x-execution-token-header` (0a).
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

- **hub-infra (`bevox-PRD-consolidation/infra/`)** → **MANIFEST-DB-ENV** (fallback harness-side OU renomear var), **NO-MIGRATOR** (job/assets de migração), **D-05** (`stop_grace_period`), **OBS-OTEL-OFF**, **QUEUE-NAME-OBS-TRAP**, **DOC-DRIFT(a)**. **P0 operacional — o pacote não sobe sem (1)+(2), que precisam ser ESCRITOS.** Manifest não re-lido nesta sessão (`[✓ 20]` congelado `fd1373b`; confirmar com o dono do hub).
- **bevox-backend** (@ `7ae1aa5`, congelado a-menos-de-audit-docs) → **CP-02** (add `contact_id`), **CP-01** (janelar histórico), **STRATEGY-FAILED-AS-DONE**, **C-01/STATUS-02/CB-NEW-03** (verbo PATCH + enum abort/dead_letter), **C-02/AUD-PROPOSAL** (`idempotency_key` + `waiting_approval`), **C-07/SENTIMENT** (backend aceita 6), **USAGE/PRD-COST**, **STRATEGY-ESCALATED-ENUM** (novo: `op-reasoning-quality` passa a emitir `strategy` = nome-do-engine-escalado no `/complete` — confirmar tolerância do enum backend antes de mergear a branch; mesma classe do CB-NEW-03).
- **Calendar Service / backend Calendar module** → **CAL-CONTRACT-MISMATCH + CAL-UNAUTH-TOKEN + CAL-IDOR-XTENANT**: **NÃO expor o Calendar Service antes de threading token + `organization_id` pelo `ToolContext`** — corrigir o contrato sem org-scope transforma o IDOR de latente em CRÍTICO cross-tenant vivo.
- **canon (bevox-knowledge / hub)** @ `0317985` → **EXEC-MODE-FAIL-OPEN** (código diverge da ADR-018 harness / ADR-006 _shared — alinhar código ou emendar ADR), **C-03/RESUME** (promover ADR-012 ao canon), **STREAM-01** (ADR-016), **CENSUS-PRD-STALE** (PRD retroativo defasado do código pós-2026-06-02).
- **Governança de branches** (o nó desta rodada) → **`test/execution-handler-coverage-uplift`** (rede de invariantes verde — **promover a PR/mergear**); **`op-*`+`finding-j10`** (fixes VIVOS provados-mergeáveis — **mergear em sequência limpa por-fix atrás de CI**); **`fix/migration-accounts-stub`+`fix/skill-loader-esm-import`+`fix/complete-callback-contract`+`fix/rules-payload-organization-id`** (MORTAS — **deletar**); **rebase+re-review de `origin/fix/sdr-ultrareview-findings`** (real, C-06).

---

## Delta vs audit anterior (07-20)

**Linhagem de tally:** 06-02 `13·20·46·34` → 06-04 `6·17·23·22` → 06-23 `7·~20·~27·~30` → 07-04 `~7·~18·~29·~19` → 07-05 `~8·~15·~27·~22` → 07-07 `~8·~16·~28·~20` → 07-08 `~8·~18·~30·~26` → 07-14 `~8·~18·~32·~28` → 07-15 `~8·~19·~33·~30` → 07-16 `~8·~20·~36·~33` → 07-17 `~8·~21·~42·~36` → 07-18/19/20 `~8·~21·~42·~36` → **07-21 `~8·~21·~42·~36` (INALTERADO)**.

### FECHADOS desde 07-20
**Nenhum.** `git log` (produto) = vazio; `git diff origin/main HEAD -- src/ migrations/` = 0 `[✓ 21]`. **Veredito de piloto/GA inalterado e pré-determinado.**

### NOVOS/refinados desde 07-20
1. **`UNMERGED-CONSTELLATION` PROVADA-MERGEÁVEL (endurece o mapeamento do 07-20)** — não é só "existe fora de `main`", é **provado por `git merge-tree` que aplica LIMPO** (6/6 branches em main + 5/5 pares + 5/5 sequencial). Refuta a cautela do 07-20 ("overlap → não mergear em bloco"): os hunks em `execution-handler.ts` são disjuntos. **Baixa o custo de 0c de "rebase por-fix" para "merge sequencial + CI".** Detalhe: §"O delta material".
2. **`DEP-AUDIT-DRIFT` (NOVO numérico)** — `npm audit` 32→33, um 5º HIGH surgiu passivamente no lockfile congelado. O custo de segurança do freeze cresce sem ação.
3. **2 reviews de merge-readiness forward-looking** (`op-reasoning-quality` via AI Engineer, `op-ctx-tokenizer-budget` via Code Reviewer) — ver §Notas de método para os vereditos.
4. **Backend moveu `6f6867d`→`7ae1aa5`** — só doc de auditoria autônoma (mesma estase cross-repo).

### Variações time-sensitive (as únicas possíveis em código congelado)
| Métrica | 07-20 | 07-21 (`[✓ 21]`) | Nota |
|---|---|---|---|
| `npm audit --omit=dev` | 32 (28 mod, 4 high) | **33 (1 low, 27 mod, 5 high)** | **+1 total, +1 HIGH** (advisory drift; lockfile congelado) |
| `TODO/FIXME/…` em `src/` | 6 | **6** | idêntico (1 é falso-positivo PT-BR) |
| `find tests -name '*.test.ts'` | 190 | **190** | idêntico |
| Suíte `vitest run` | 1236 passed / 57 skipped | **1236 passed / 57 skipped, 0 fail** | verde, re-rodada fresca |
| `git diff origin/main -- src/` | 0 | **0** | freeze intacto (~48d) |
| backend HEAD | `6f6867d` | **`7ae1aa5`** | +audit-doc only |
| **constelação mergeável** | "overlap, triar por-fix" | **provado LIMPO (6/6+5/5+5/5)** | achado material da rodada |

**Conclusão do delta:** material de produto = **zero**. A mudança de estado acionável é a **prova formal de mergeabilidade** (reduz o custo de integração) + o **drift passivo de segurança** (aumenta o custo de inação). A 15ª rodada não move nenhum gate de piloto/GA por si só, mas **remove a última incerteza técnica sobre o caminho de destravamento**.

---

## Correções pendentes ao prompt-mãe e ao CLAUDE.md (byte-verificadas `[✓ 21]`)

1. **prompt-mãe (h)** — "4 endpoints `/complete`,`/artifact`,`/tool-result`,`/turn`": os 3 últimos **não existem em NENHUM dos lados** (`[✓ 21]` harness `bevox-callback.ts`; backend herdado). Reais: `PATCH /status`, `POST /traces`, `POST /stream`, `POST /complete`.
2. **prompt-mãe (f)** — trata a FK `accounts(id)` como **aberta**: está **FECHADA** (`000`+`011`+`012` em `origin/main` `[✓ 21]`). Remover a pergunta "como fechar definitivamente".
3. **prompt-mãe (g)** — "PRD §212": **fantasma** (o PRD termina no §17 `[✓ 21]`; o gate do piloto é §16; MCP é §5.13/§10.3).
4. **prompt-mãe (b)** — cita "ADR-006 execution_mode": é **_shared/ADR-006** (autonomy-permissions-approval) **E harness/ADR-018** (modos-de-autonomia-execution-mode) — ambos existem no canon `[✓ 21]`; a fail-open diverge de ambos.
5. **CLAUDE.md §Infraestrutura** — accounts-FK workaround obsoleto/conflitante; "Dockerfile single-stage" (é 2-stage `[✓ 21]`); "7 estágios" (**≥9**); "3 agentes" (4, +MemoryCondenser); "HEAD em CALENDAR_SERVICE_URL" (é GET `/health`, tolera 404).
6. **CLAUDE.md** — "cobertura Vitest é mínima": **super-dimensionado** (1236 testes passando `[✓ 21]`; hot-path 97-100%).

---

## Notas de método

**Decisão deliberada de NÃO re-executar o fan-out multi-agente de descoberta.** Com o código **byte-idêntico** re-verificado (`git diff origin/main HEAD -- src/ migrations/`=0 `[✓ 21]`), um novo fan-out de descoberta reproduziria o mesmo backlog — a **exata inércia** que o prompt-mãe proíbe ("não invocar [agents] por inércia — só os que se aplicam à varredura") e que a memória de projeto (`harness-audit-stasis-pause`, `workflow-multiagent-audit-tooling`) + a recomendação #0 de 5 rodadas mandam evitar. **A varredura desta rodada foi verificação-de-freeze + prova-de-topologia-de-merge + merge-readiness forward-looking**, não descoberta de domínio sobre `src/` congelado.

**O que fiz (tudo `[✓ 21]`, leitura própria nesta sessão):**
- **git-archaeology / freeze:** `git diff origin/main HEAD -- src/ migrations/`=0; `git diff --numstat/--name-only origin/main...<branch>` p/ cada branch viva; headers `@@` de `execution-handler.ts` p/ mapear disjunção de hunks.
- **PROVA de merge-topologia (novo):** `git merge-tree --write-tree origin/main origin/<branch>` p/ cada uma das 6 vivas (6/6 exit 0); pares cruzados (5/5 exit 0); simulação sequencial encadeando árvores escritas com `--merge-base=origin/main` (5/5 exit 0).
- **Suíte:** `npx vitest run` → 173 files / 1236 passed, 17/57 skipped, exit 0 (linhas `level:50` = fixtures negativas propositais).
- **harness em disco:** `env.ts:8-12/206` (DATABASE_URL+CALENDAR_SERVICE_URL required; exit(1)), `bevox-callback.ts:15/28/103/113/141/155` (`post()` POST; `/status` via POST = C-01), `Dockerfile:1-18` (2-stage; runner só copia `dist`), grep lexicon `src/`=0, grep TODO=6, `ls migrations/`=15 (000+011+012 presentes; dois `013_`).
- **canon em disco (`0317985`):** PRD `2026-05-15-…-v1.md` (§§ até 17, sem "212", MCP §5.13/§10.3); `30_adr/bevox-harness/ADR-018` + `30_adr/_shared/ADR-006` (execution_mode).
- **Métricas time-sensitive:** `npm audit --omit=dev` (33, +1 HIGH), branches (`fix/`=24, `op-`=8, 59 remotas), test files (190), cross-repo HEADs (backend `7ae1aa5`, canon `0317985`).

**Agents locais — invocados COM propósito forward-looking (não para auditar `src/` congelado).** Dois reviews de **merge-readiness** das 2 branches comportamentalmente mais arriscadas da constelação (a que muda o caminho default-ON de raciocínio e a que adiciona dependência no hot-path de contexto):

- **`op-reasoning-quality` (via `AI Engineer`) → MERGE-WITH-CAVEAT.** Diff internamente completo, testado (react/reflexion end-to-end + `surface-loop-escalation`/`surface-loop-rewoo`), aterrissa limpo sobre as APIs `rewoo/plan-execute.synthesize` existentes (ambas ignoram `_plan` → o synth no engine escalado não crasha), **0 invariante verde quebrada**. **Confirma que R-01 era real:** os `reflexionNotes` antes eram anexados por um cast inseguro (`as unknown as object`) que **nenhum engine lia** → retries de Reflexion eram no-op; agora o ReAct recebe a lição (`react.ts:~97-118`). Nesting de `wrap-reflexion` agora capado em 1 (era ilimitado — multiplicação de retry). **⚠️ CAVEAT DE CONTRATO (achado NOVO, cross-repo):** a branch muda o campo observável **`/complete.strategy` para emitir o nome do engine ESCALADO** (`"rewoo"`/`"plan-execute"`) em vez do default engine, **sem teste e2e fixando isso** por `handleExecution` nem no espelho Model-C. **Isto é da MESMA classe do `CB-NEW-03`** (`/complete.strategy` fora-do-enum) → antes de mergear, **confirmar que o enum `strategy` aceito pelo backend tolera nomes-de-engine** (senão a escalação vira `/complete` 400 engolido). Loose ends documentados (fora do piloto): ReWOO waves honram ordem, não data-flow (OQ6 — ainda não passa outputs entre steps); comentário stale em `engine-swap-mid-loop.test.ts:245-261` (doc-rot; teste passa).
- **`op-ctx-tokenizer-budget` (via `Code Reviewer`) → MERGE-WITH-CAVEAT.** Correto e bem unit-testado; **subpaths do `js-tiktoken@1.0.21` verificados reais via npm** (o encoder `o200k_base` = gpt-4o/4o-mini carrega em prod, **não é no-op silencioso**; `base64-js` corretamente promovido de dev→prod dep). Fail-open é genuinamente throw-safe no hot-path (import dinâmico retorna promise + `.catch()`; `enc.encode()` em try/catch → `estimateTokens` nunca lança sync; determinismo por-tick preservado). Substitui o heurístico `words*1.3` por BPE model-aware → uma vez quente, conta MAIS alto p/ PT-BR/JSON/emoji → o budget-gate **comprime prompts com mais frequência/agressividade** que o `main` de hoje; `truncatePromptToBudget` agora é convergente (≤6 iterações, corrige overshoot single-pass). **⚠️ CAVEATS:** (1) **0 cobertura de handler/integração** da nova telemetria (`token_estimate_ratio`/`tokenizer_fallback`/`within_budget`) — a branch toca só `tests/unit/context/*`; (2) kill-switch `HARNESS_BPE_TOKENIZER_ENABLED` lido **cru de `process.env`**, fora do Zod schema (`src/config/`) e não-documentado no CLAUDE.md; (3) fail-open é fail-*aberto* p/ um *budget* (heurístico sub-conta → em falha permanente de load um prompt pode passar do window real — mas é o comportamento de hoje, não regressão). **Recomendação: mergear com smoke pós-merge OU kill-switch default-off inicialmente**, não merge verde-cego.

> **Convergência independente dos 2 reviews (reforça o achado de processo):** ambos os agentes, sem coordenação, concluíram que **a dormência de ~48d NÃO é defeito da branch** — as branches estão *finished* e mergeáveis; o stall é **organizacional (o freeze/cadência), não incompletude nem regressão**. Ambos são **MERGE-WITH-CAVEAT**, cada um com **exatamente UMA pré-condição verificável** antes do merge (reasoning: tolerância do enum `strategy` no backend; tokenizer: smoke/kill-switch da telemetria não-coberta). Isto qualifica a rec 0c sem invalidá-la: *mergear é barato E provado-limpo, mas não verde-cego* — 2 checagens dirigidas destravam ambos.

Nenhum agente de **descoberta** de domínio foi usado — deliberadamente, alinhado às 5 rodadas anteriores E ao qualificador do próprio prompt-mãe. A próxima invocação de agente de valor é para **IMPLEMENTAR** (0a mergear a rede; 0c mergear a constelação; 1-3 escrever os fixes sem-branch), **não auditar** código congelado.

**Confiança.** Alta em todo achado acionável — cada `arquivo:linha` dos blockers foi lido nesta sessão; a mergeabilidade é **provada** por `git merge-tree` (nível-árvore, não semântico). **Residual/Duvidoso:** (1) `git merge-tree` prova ausência de conflito textual, NÃO correção semântica da união → **CI da união é obrigatório antes de confiar no resultado** (a rede-de-teste 0a + testes das branches são o gate). (2) **por que a constelação travou ~48d** não é visível em disco — **confirmar com o dono das branches antes de mergear** (uma branch pode ter sido abandonada por regressão real). (3) `MANIFEST-DB-ENV`/`NO-MIGRATOR` foram re-verificados só do lado-harness nesta sessão; o lado-manifest herda o `[✓ 20]` (congelado) + memória — **confirmar com o dono do hub** (se a Hetzner injeta `DATABASE_URL`/roda `migrate` out-of-band, rebaixa). (4) escopo do piloto (draft/SDR/teto-de-custo) condiciona C-02..C-06.

**Meta-nota ao revisor humano (15ª rodada, ~48 dias de estase, 0 commit de produto).** Nos últimos ~48 dias, **os únicos commits em harness+backend+canon foram documentos de auditoria autônoma** — três repos gastando o slot diário a relatar em vez de fechar. A cadência de auditoria autônoma é toil de valor marginal decrescente, **auto-confirmado por 6 rodadas consecutivas**. A diferença desta 15ª rodada: ela **remove a última incerteza técnica** sobre o caminho de destravamento ao **provar** que a constelação de fixes já-escritos mergeia LIMPO (6/6 branches + 5/5 pares + 5/5 sequencial via `git merge-tree`) — o custo de integração caiu de "rebase-hell" para "merges sequenciais atrás de CI", e o custo de inação **subiu** (um 5º advisory HIGH surgiu passivamente). **A próxima ação de valor não é uma 16ª auditoria — é o primeiro commit de produto para `main` desde 2026-06-03:** (0a) mergear a rede de invariantes verde; (0c) mergear a constelação provada-mergeável atrás de CI (após confirmar por que travou); (1-3) escrever os 3 blockers incondicionais sem-branch; deletar as 4 branches `fix/*` mortas. Enquanto o slot diário produzir docs e não código, este relatório e os 14 anteriores dizem a mesma coisa — agora com a prova de que integrar é barato.
</content>
</invoke>
