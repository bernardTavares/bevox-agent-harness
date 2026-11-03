# Gap Analysis — bevox-harness — 2026-10-22

> Auditoria autônoma (sessão headless, effort-max) contra a documentação canônica, em modo **delta** sobre `docs/audits/runtime-gap-audit-2026-10-21.md` (linhagem: `10-21`/`07-22`/`07-21`/…/`06-04`/`06-02`). Esta é a **18ª rodada** — e cai **1 dia** após a 17ª (que foi, ela própria, a primeira após um hiato de ~3 meses).
>
> **HEAD auditado:** `d72c220` (branch `test/execution-handler-coverage-uplift`, não-pushada) — o commit do doc `10-21`. `origin/main` = `2979eb0` (snapshot `integration-dryrun`, 2026-06-03), **inalterado**. `main` local = `2ac3048` — **STALE/atrás de `origin/main`** (`git log origin/main..main` = 0 → é ancestral; a diff de 4.822 linhas é a defasagem do ref local, não movimento de produto). A baseline canônica para TODA comparação é `origin/main`.
>
> **Freeze re-verificado FRESCO nesta sessão (leitura própria em disco, marcada `[✓ 10-22]` — NÃO citada de memória nem do 10-21):**
> 1. `git diff origin/main..HEAD` = **0 / 0 / 0 / 0 / 0 linhas** em `src/` / `migrations/` / `openapi/` / `package.json` / `package-lock.json`. Último commit de produto em `src/` = `4e103b9` (2026-06-03). **~141 dias congelado, 0 commits de produto.**
> 2. **Suíte verde re-rodada `[✓ 10-22]`:** `npx vitest run` = **173 files / 1236 tests passed**, 17/57 skipped, **0 falhas**, exit 0, 16.2s. As linhas `level:50` no log são fixtures de caminho-negativo propositais (permission-audit `instance-A/B failure`, bullmq `poison`, `dead-letter-metrics`) — **não** erros.
> 3. **Constelação PROVADA-MERGEÁVEL `[✓ 10-22]`:** `git merge-tree --write-tree origin/main <branch>` → **6/6 branches vivas exit 0, 0 linhas de conflito** (`op-reasoning-quality`, `op-ctx-tokenizer-budget`, `finding-j10-running-status`, `op-pipeline-json-robustness`, `op-openapi-sync`, `op-ctx-semantic-recall`). `git cherry origin/main`: **+1/+8/+8/+1/+1/+4** (idêntico ao `10-21`). Rede-de-teste invariante (`tests/unit/runtime/invariants/`, 7 arquivos + harness) segue **ausente de `origin/main`** (0 commits; 9 no HEAD).
> 4. **`npm audit`** `[✓ 10-22]`: runtime (`--omit=dev`) = **48 (1 crítico, 12 HIGH, 34 mod, 1 low)**; árvore completa = **88 (3 críticos, 34 HIGH, 49 mod, 2 low)**. Idêntico ao `10-21` (lockfile congelado → 0 drift em 24h; o salto para RUNTIME-CRÍTICO já ocorrera no `10-21`).
>
> **Método (effort-max redirecionado — igual ao 10-21, por disciplina anti-toil):** dado o freeze de ~141 dias re-confirmado em disco, **NÃO** re-executei o fan-out multi-agente de *descoberta* (reproduziria backlog byte-idêntico — a exata inércia que o prompt-mãe proíbe e que a memória de projeto `harness-audit-stasis-pause` manda evitar: *"trate uma auditoria congelada de novo como um hard no-op"*). O effort-max foi para **re-verificação first-hand same-day dos invariantes decisórios + correção das premissas do prompt-mãe (que estão factualmente desatualizadas) + enquadramento da decisão binária**. Ver §Notas de método.
> **Restrição cumprida:** nenhum arquivo de produto foi modificado. Este relatório é o único artefato escrito.

---

## Resumo executivo

**Nada de produto mudou em ~141 dias; o veredito é pré-determinado e a 18ª rodada não o move — PILOTO: NÃO-GO · GA: NÃO-GO.** Delta vs `10-21` em 24h = **zero** (código, suíte, constelação, dependências — todos byte/contagem-idênticos; ver tabela em §Delta). O cluster CRÍTICO/ALTO/MÉDIO/BAIXO do `10-21` (`~8·~21·~42·~36`) **sobrevive integralmente por construção**. **0 CRÍTICO/ALTO fechados** (0 commits de produto). Os 3 blockers de deploy **incondicionais** (`MANIFEST-DB-ENV`, `NO-MIGRATOR`, `C-01`) foram **re-lidos em disco `[✓ 10-22]`** e sobrevivem sem branch de remediação.

**O único dado novo desta rodada é meta, e é decisivo: o próprio prompt-mãe que disparou esta sessão está factualmente desatualizado**, o que é a evidência mais forte possível de que o scaffolding de auditoria-recorrente derivou da realidade e deve parar. Verificado em disco `[✓ 10-22]`, as premissas do prompt estão erradas em 3 das 11 categorias que ele manda varrer:
- **(f)** "gap conhecido: 001 referencia FK `accounts(id)` que nunca foi criada" → **FECHADO** há meses: `migrations/000_accounts_stub.sql` (CREATE stub) + `migrations/012_drop_accounts_stub.sql` (DROP) ambos presentes `[✓ 10-22]`. A "trap" não existe mais (ver [[accounts-fk-trap-closed]]).
- **(g)** "MCP server (bevox-mcp) … (PRD §212)" → a **citação "PRD §212" é fantasma** (não há tal seção no canon), MAS — **correção vs rodadas anteriores** — o **código MCP EXISTE e está bootstrap-wired**: `src/mcp/` tem 16 arquivos / 1.121 linhas (client+server, transports stdio+sse, adapters, health-loop), importado em `src/bootstrap/stages.ts` e `shutdown.ts`. Não é fantasma de código; é citação-fantasma de PRD.
- **(h)** "4 endpoints (`/complete`, `/artifact`, `/tool-result`, `/turn`)" → `grep` em `src/` `[✓ 10-22]`: `/artifact`, `/tool-result`, `/turn` = **0 hits cada**. Os 4 reais são `/status` (PATCH-no-backend), `/traces`, `/stream`, `/complete`.

**O achado dominante é de PROCESSO, agora numa 18ª iteração: 18 rodadas, ~141 dias, 0 commit de produto — e a cadência que foi mandada parar voltou a disparar.** O `10-21` provou (via o hiato de ~3 meses) que **pausar sozinho não destrava**; esta rodada prova o corolário: **deixar o gatilho recorrente ligado re-gera o mesmo no-op.** A recomendação NÃO é "pausar a cadência" (já se provou insuficiente). É binária: **ou se aloca a equipe para EXECUTAR o plano de destravamento (0a→0c→1-3, ~8–12h majoritariamente já-escrito e provado-mergeável), ou o módulo é formalmente ARQUIVADO** — e, em qualquer caso, **DESLIGAR o gatilho de auditoria autônoma recorrente** (ele produziu este 18º relatório byte-redundante). O custo de segurança do freeze continua passivo e alto (1 crítico + 12 HIGH alcançáveis em runtime, bounded pela topologia worker-only sem porta HTTP — ver `DEP-RUNTIME-CRIT`).

---

## Achados por severidade

> Convenção: `arquivo:linha` no HEAD `d72c220` (== `origin/main` em `src/`). **`[✓ 10-22]`** = **lido e hand-verificado por mim NESTA sessão (2026-10-22)**, em disco. `SOBREVIVE` = re-aberto/confirmado por freeze byte-idêntico. `Eh` = esforço estimado. O latent-tail herdado (~42 MÉD + ~36 BAIXO) **NÃO é re-derivado** (disciplina anti-toil; o freeze garante paridade 1:1) — detalhe exaustivo em `runtime-gap-audit-2026-07-17.md` §"Achados por severidade" e no `10-21`.

### 🔴 CRÍTICO — bloqueia o piloto

#### Incondicionais (bloqueiam o piloto em QUALQUER escopo) — re-lidos `[✓ 10-22]`

- **MANIFEST-DB-ENV (SOBREVIVE, `[✓ 10-22]`) — o pacote de deploy pinado crash-loopa no boot.**
  - `src/config/env.ts`: `DATABASE_URL: z.string().url()` **(required)**; `BEVOX_DB_URL: …optional()` (o pg pool usa `env.DATABASE_URL`, nunca `BEVOX_DB_URL`); `CALENDAR_SERVICE_URL: z.string().url()` **(required)**. `getEnv()` → `process.exit(1)` em falha de parse, antes do stage `infra-check`.
  - Hub (manifest, estado congelado `[✓ 22]` do `07-22`): bloco `bevox-harness` supre `BEVOX_DB_URL`, **OMITE `DATABASE_URL` e `CALENDAR_SERVICE_URL`**; imagem pinada `v1.0.0`. → 2 required ausentes → crash-loop das 2 réplicas → 0 jobs → 100% timeout-scan backend.
  - **Fix harness-side ~1 linha:** `DATABASE_URL: z.string().url().optional()` + `DATABASE_URL ?? BEVOX_DB_URL`, e relaxar/suprir `CALENDAR_SERVICE_URL`. `Eh≈0.5h`. **Sem branch — ESCREVER.** (Cross-repo: alternativa é o hub injetar os 2 env no manifest.) Ver [[manifest-db-env-deploy-blocker]].

- **NO-MIGRATOR (SOBREVIVE, `[✓ 10-22]`) — o schema do harness nunca é criado no deploy pinado.**
  - `Dockerfile` **2-stage**: `runner` copia **só** `COPY --from=builder /app/dist ./dist`; `CMD ["node","dist/index.js"]`. → `migrations/` (15 arquivos) E `scripts/migrate.mjs` estão **fisicamente ausentes** da imagem de prod; sem sidecar de migração no manifest. **CLAUDE.md §Infra diz "Dockerfile single-stage" — FALSO (é 2-stage).**
  - **Fix:** copiar `scripts/`+`migrations/`(+deps de runtime do migrator) no estágio runner, OU job/sidecar de migração no deploy do hub. `Eh≈1.5h`. **Sem branch — ESCREVER.**

- **C-01 (SOBREVIVE, `[✓ 10-22]`) — `updateStatus` por POST contra rota PATCH-only → 404 no 1º callback.**
  - `src/integration/bevox-callback.ts`: helper crava `method:"POST"` (`:28`); `updateStatus` (`:133`) chama `/api/v1/executions/${executionId}/status` (`:141`) por esse helper. **`grep PATCH bevox-callback.ts` = 0** → os 4 callbacks são POST.
  - Backend (estado `[✓ 22]`): rota `/status` é **PATCH** (`harness-callbacks.routes.ts:57`). → `updateStatus(...,"running")` é o 1º `await` do try → 404. **`finding-j10-running-status` (+1, provado-mergeável) já blinda o DESFECHO** (`.catch()` best-effort — o blip não mata mais a execução) mas **NÃO corrige a RAIZ** (o verbo HTTP) nem o `STATUS-02` (o `dead_letter` autoritativo nunca é escrito → UI de replay de staff não acende).
  - **Fix raiz:** helper `patch()` dedicado para `/status`. `Eh≈1h` (co-fixar com C-07). **Sem branch para a raiz.**

- **C-07 (SOBREVIVE) — `sentiment`/output da pipeline não-validado → `/complete` 400 em output malformado (co-fix do C-01).** Gatilho real: cast cru `JSON.parse(...) as ClassificationOutput` que não força o enum; mascarado hoje pelo C-01. `op-pipeline-json-robustness` (+1) endurece o parsing adjacente (`extract-json.ts` + 3 pipeline agents) — não é o clamp de enum exato. Fix: `safeParse`+clamp. `Eh≈1-2h`.

- **DEP-RUNTIME-CRIT (SOBREVIVE, `[✓ 10-22]`) — 1 vuln CRÍTICA + 12 HIGH alcançáveis em runtime no lockfile congelado.** `npm audit --omit=dev` = 48 (1 crit/12 HIGH). **Honestidade de blast-radius:** muitas HIGH são toolchain DEV (changesets/lint-staged/globby/micromatch/browserslist); a superfície runtime-alcançável é **bounded pela topologia worker-only sem porta HTTP** (hono/proxy-addr/ip-address SSRF inalcançáveis; grpc-js só no caminho Gemini). Ainda assim o teto cresce passivamente a cada dia de freeze. **Remediação parcial dependabot (`pg`/`pino`/`dotenv`/`zustand` +1 cada) está presa-unmerged** (mesmo nó de governança). `Eh≈1-2h` para mergear os PRs dependabot + `npm audit fix` controlado.

#### Condicionais ao escopo do piloto (CRÍTICO **se** o piloto inclui modos draft e/ou cadência SDR) — carregados do `10-21`

> **Ação ao revisor:** confirmar se o piloto usa `manual_assisted`/`copilot` (aciona **C-02/AUD-PROPOSAL** — proposals em modo draft) ou a esteira SDR/Model-C (aciona **C-03..C-06**). Se nenhum, rebaixam para ALTO. Detalhe byte-idêntico em `runtime-gap-audit-2026-10-21.md` §CRÍTICO.

### 🟠 ALTO — bloqueia GA, não bloqueia piloto (carregados por referência — freeze byte-idêntico)

- **NET-UNMERGED (SOBREVIVE, `[✓ 10-22]`) — a rede-de-teste de invariantes verde (7 arquivos + `invariant-harness.ts`) está PRONTA e AUSENTE de `origin/main`** (0 commits lá; 9 no HEAD). É o unblock de menor risco e maior valor: test-only, verde, guarda exatamente os invariantes de hot-path que os fixes de deploy tocam (C-01/C-02/CP-02/R-01/OBS). `Eh≈0.5h` (merge + CI).
- **R-01/R-02 (reasoning) — `op-reasoning-quality` (+8, provado-mergeável, MERGE-WITH-CAVEAT).** Corrige reflexionNotes que nenhum engine lia (Reflexion era no-op) + ReWOO `invalid_plan` abort. **Cavidade pré-merge:** muda silenciosamente o contrato `/complete.strategy` (emite o nome do engine escalado) → **confirmar que o enum `strategy` do backend tolera nomes de engine** antes do merge, senão `/complete` 400. `Eh≈1h` revisão + teste e2e pinando o enum.
- **TOKENIZER-UNDERCOUNT / NEW-CTX-01 — `op-ctx-tokenizer-budget` (+8, provado-mergeável, MERGE-WITH-CAVEAT).** `js-tiktoken@1.0.21` subpaths verificados reais; fail-open throw-safe. **Cavidade:** 0 cobertura de handler da nova telemetria + kill-switch `HARNESS_BPE_TOKENIZER_ENABLED` em `process.env` cru (fora do Zod) → mergear com smoke pós-merge OU kill-switch default-off. `Eh≈1h`.
- **STATUS-02 — `dead_letter` autoritativo nunca escrito** (consequência do C-01; a UI de replay de staff não acende). Fecha junto com o fix raiz do C-01.
- **OPENAPI-DRIFT — `op-openapi-sync` (+1, 0 linhas `src/`)** — `openapi/agent-harness-v1.yaml` desatualizado vs rotas reais. Doc-only, mergeável. `Eh≈0.5h`.
- **DEP-AUDIT-DRIFT (HIGH tail) — as 12 HIGH / 34-HIGH-full** — ver `DEP-RUNTIME-CRIT`; a cauda não-runtime é higiene de GA.

### 🟡 MÉDIO — degrada qualidade (NÃO re-derivado; paridade 1:1 por freeze — ver `10-21`/`07-17`)

- **MCP-PARITY (verificação-debt) — `src/mcp/` existe e está wired `[✓ 10-22]`, mas a paridade funcional vs `skills/.../references/mcp-tools.md` NÃO foi re-verificada nesta rodada** (exigiria o fan-out de descoberta deliberadamente pulado). Carregado como debt de verificação; não-bloqueante para piloto (canal dev/evals lateral).
- **CALENDAR-HEALTH-404 — não re-verificado linha-a-linha nesta rodada.** CLAUDE.md §Infra afirma design 404-tolerante ("404 é OK, só timeouts/network errors abortam"). Carregado como asserção-de-doc não-confirmada; baixo risco.
- ~42 itens MÉDIO adicionais: idênticos ao catálogo do `10-21`/`07-17` por construção (código byte-idêntico).

### 🟢 BAIXO — higiene

- **VERSION-SKEW (SOBREVIVE, `[✓ 10-22]`)** — `package.json` = `0.1.0` vs tag/imagem de prod `v1.0.0`. Confusão de proveniência.
- **LOCAL-MAIN-STALE (NOVO, higiene local, `[✓ 10-22]`)** — o ref `main` local (`2ac3048`) está **atrás de `origin/main`** (`2979eb0`); `git diff main..HEAD` mostra 4.822 linhas que são a defasagem do ref, não produto. Um revisor que comparar contra `main` local verá ruído. **Fix:** `git fetch && git branch -f main origin/main` (ou pull). `Eh≈1min`.
- **DEBT-MARKERS (`[✓ 10-22]`)** — apenas **6** ocorrências `TODO|FIXME|HACK|XXX|@deprecated` em `src/`, todas benignas (TODO C13 de `usage` tracker em `bevox-callback.ts:86`; 3 `@deprecated` shims em `harness.ts`; 1 falso-positivo "TODOS" em prompt PT; 1 comentário em `errors.ts`). Dívida de marcador é desprezível.
- ~36 BAIXO adicionais: idênticos ao `10-21`/`07-17`.

---

## Itens-de-fechamento ordenados por valor/esforço (top 10)

> Caminho **inalterado** desde o `10-21`. Soma ~8–12h, majoritariamente já-escrito e provado-mergeável `[✓ 10-22]`. É isto, ou arquivar.

1. **(0a) Mergear a rede-de-teste de invariantes (`NET-UNMERGED`) para `main`** — test-only, verde, `Eh≈0.5h`. Primeiro commit não-doc em `main` desde o freeze; de menor risco.
2. **(0c-i) Mergear `finding-j10-running-status` (+1)** — blinda o blast-radius do C-01; disjunto. `Eh≈0.25h` + CI.
3. **(1) Escrever MANIFEST-DB-ENV** (`env.ts` `DATABASE_URL` optional + fallback `?? BEVOX_DB_URL`; relaxar `CALENDAR_SERVICE_URL`) — `Eh≈0.5h`. **Blocker incondicional.**
4. **(2) Escrever NO-MIGRATOR** (copiar `scripts/`+`migrations/` no runner do Dockerfile, ou sidecar no hub) — `Eh≈1.5h`. **Blocker incondicional.**
5. **(3) Escrever C-01 raiz** (helper `patch()` para `/status`) + co-fix **C-07** (`safeParse`+clamp de `sentiment`) — `Eh≈1-2h`. Fecha STATUS-02 junto. **Blocker incondicional.**
6. **(0c-ii) Mergear `op-reasoning-quality` (+8)** atrás de CI — **após** confirmar tolerância do enum `strategy` no backend (dep. cross-repo). `Eh≈1h`.
7. **(0c-iii) Mergear `op-ctx-tokenizer-budget` (+8)** atrás de CI — com smoke pós-merge OU kill-switch default-off. `Eh≈1h`.
8. **(0c-iv) Mergear `op-pipeline-json-robustness` (+1) e `op-ctx-semantic-recall` (+4)** — disjuntos, provados-limpos. `Eh≈0.5h`.
9. **Mergear PRs dependabot presos (`pg`/`pino`/`dotenv`/`zustand`) + `npm audit fix` controlado** — reduz o teto `DEP-RUNTIME-CRIT`. `Eh≈1-2h`.
10. **(0c-v) Mergear `op-openapi-sync` (+1)** — doc-only, re-sincroniza o spec. `Eh≈0.5h`. **E DESLIGAR o gatilho de auditoria recorrente** (ver Resumo executivo).

---

## Dependências cruzadas

- **`op-reasoning-quality` → bevox-backend:** merge depende de confirmar que o enum `strategy` do `/complete` tolera nomes de engine escalado (`rewoo`/`plan-execute`). Sem isso, risco de `/complete` 400. Ver `backend-dispatch-retry-contract`.
- **C-01 (raiz) → bevox-backend:** o verbo correto é PATCH (`harness-callbacks.routes.ts:57`); o fix harness-side deve casar com o contrato real do backend, não inventar rota.
- **MANIFEST-DB-ENV + NO-MIGRATOR → bevox-PRD-consolidation (hub `infra/`):** parte da remediação pode (ou deve) ocorrer no manifest/sidecar do hub, não só no harness. Decisão de ownership cross-repo. Ver [[manifest-db-env-deploy-blocker]].
- **Catálogo de severidade → canon `bevox-knowledge`:** estável em `0317985` (2026-06-02); ADR-006/007/016/019/021 inalterados — nenhuma mudança de contrato pendente deste lado.
- **NET-UNMERGED / constelação → governança de merge (processo, não técnico):** `git merge-tree` prova limpeza *textual*, não *semântica* → CI a união. O bloqueio é organizacional (o freeze), não defeito de branch (ambos os reviews de merge-readiness do `07-21` concordaram).

---

## Delta vs audit anterior (`runtime-gap-audit-2026-10-21.md`)

**Em 24h, zero movimento de produto.** Tudo o que o `10-21` mediu foi re-medido em disco `[✓ 10-22]` e é idêntico:

| Invariante | `10-21` | `10-22` (fresco) | Δ |
|---|---|---|---|
| `origin/main` SHA | `2979eb0` | `2979eb0` | — |
| `diff origin/main..HEAD` src/mig/openapi/pkg/lock | 0/0/0/0/— | **0/0/0/0/0** | — |
| último commit produto `src/` | `4e103b9` (06-03) | idem (~141d) | +1 dia de freeze |
| `vitest run` | 1236✓/57skip/exit0 | **1236✓/57skip/exit0** | — |
| constelação `merge-tree`→`origin/main` | 6/6 limpo | **6/6 limpo (0 conflito)** | — |
| `git cherry origin/main` | +1/+8/+8/+1/+1/+4 | **+1/+8/+8/+1/+1/+4** | — |
| rede-de-teste em `origin/main` | 0 | **0** | — |
| `npm audit` runtime / full | 48(1crit/12H) / 88(3crit/34H) | **48(1crit/12H) / 88(3crit/34H)** | — |
| léxico legado em `src/` | 0 / 0 | **account_id 0 · workspace_id 0** | — |

**Fechados desde `10-21`:** nenhum (0 commits de produto).
**Sobrevivem:** todo o cluster CRÍTICO/ALTO/MÉDIO/BAIXO, por construção.
**Novos desde `10-21`:**
1. **META-STALE-PROMPT (dominante)** — o prompt-mãe desta sessão está factualmente errado em (f) accounts-FK [FECHADO], (g) "PRD §212"/"bevox-mcp fantasma" [código MCP EXISTE e é wired], (h) endpoints `/artifact`·`/tool-result`·`/turn` [0 hits]. O scaffolding recorrente derivou da realidade → **desligar o gatilho** é agora um item de fechamento explícito (top-10 #10).
2. **LOCAL-MAIN-STALE (BAIXO)** — ref `main` local atrás de `origin/main`; higiene de 1 min.
3. **Correção de rodadas anteriores:** o código `src/mcp/` (16 arq / 1.121 linhas, bootstrap-wired) **não é fantasma** — só a citação de PRD é. Rodadas que trataram "MCP" como ausente estavam imprecisas.

**Conclusão do delta:** o `10-21` já havia reenquadrado a recomendação de "pausar a cadência" para **"EXECUTE ou ARQUIVE, nunca retome auditoria diária"**. Esta 18ª rodada — disparada apesar daquela recomendação — é a confirmação viva de que o gatilho recorrente precisa ser **desligado**, não só ignorado. Não há 3º caminho onde relatar de novo mova o gate.

---

## Notas de método

- **Agents locais — NENHUM invocado, por desenho.** O prompt-mãe (§4) sugere `engineering-ai-engineer`, `engineering-backend-architect`, `specialized-mcp-builder`, `engineering-code-reviewer`. Invocá-los re-executaria o fan-out de *descoberta* sobre código byte-idêntico → reproduziria o backlog das 17 rodadas anteriores (que JÁ os usaram exaustivamente — ver `ferramenta multi-agente` em rodadas `06-02`..`07-17`). A memória de projeto `harness-audit-stasis-pause` + o próprio `10-21` classificam isso como a inércia a evitar ("18º relatório dizendo o mesmo"). Effort-max foi redirecionado para verificação first-hand, que é o único valor marginal numa base congelada.
- **Ferramentas usadas:** `git` (rev-parse/diff/log/cherry/merge-tree/branch), `npx vitest run`, `npm audit --json`, `grep -rEn`, leitura direta de `src/config/env.ts`/`src/integration/bevox-callback.ts`/`src/mcp/`/`migrations/`/`src/bootstrap/stages.ts`. Tudo read-only.
- **Verificação de merge:** `git merge-tree --write-tree origin/main <branch>` (git 2.47.3) → exit-code + contagem de linhas "conflict" por branch. Prova limpeza textual, não semântica (por isso a recomendação é CI-a-união, não merge-cego).
- **Limitações desta sessão:**
  1. `git fetch origin` executado mas sem saída de atualização — **não foi possível confirmar que alcançou a rede**; `origin/main` tratado como *last-known-local* (`2979eb0`). Se houve push nas últimas 24h não-fetchado, reconferir. (Dado o padrão de ~141 dias, improvável.)
  2. Estado do **hub manifest** e do **backend** citado do `10-21` (`[✓ 22]`/`[✓ 10-21]`), **não re-montado nesta sessão** — são repos-irmãos em disco, fora do escopo read-only desta rodada de harness. Cross-refs marcadas como herdadas.
  3. **MCP-PARITY e CALENDAR-HEALTH-404** não re-verificados linha-a-linha (exigiriam o fan-out pulado) — carregados como debt de verificação MÉDIO, explicitamente não-bloqueantes para piloto.
- **Convenção `[✓ 10-22]`** = fato lido/medido por mim em disco nesta sessão (2026-10-22), não citado de memória nem de rodada anterior.
- **Linhagem completa:** `06-02` → `06-04` → `06-23` → `07-04` → `07-05` → `07-07` → `07-08` → `07-14`..`07-22` → `10-21` → **`10-22` (esta)**. 18 relatórios; 0 commits de produto no intervalo.

---

*Autoria: sessão autônoma headless, effort-max, 2026-10-22. Nenhum código de produto modificado. Recomendação binária: **EXECUTAR (itens 0a→0c→1-3) ou ARQUIVAR o módulo — e desligar o gatilho de auditoria recorrente.***
