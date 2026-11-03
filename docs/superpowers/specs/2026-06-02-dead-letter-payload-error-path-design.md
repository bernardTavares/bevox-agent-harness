# Dead-Letter & Unprocessable-Payload Error Path for the Dispatch Worker — Design

> **Spec ID:** `2026-06-02-dead-letter-payload-error-path-design`
> **Status:** Draft — pendente review pelo founder
> **Autor:** Claude (Opus 4.8) — Backend Architect, 2026-06-02. Grounded em research já double-checada contra o código (J3 + DEBT-05).
> **Escopo:** bevox-harness audit findings **J3** (payload Zod-inválido/oversize é logado em `level:50` e silenciosamente DESCARTADO — sem canal de erro) + **DEBT-05** (nenhuma dead-letter queue existe, mas um rule doc afirma que vai existir).
> **Estimate:** ~8–10h (3 phases) — revisado para cima no pivô 2026-06-03: o sinal dead-letter
> authoritativo ao backend (`updateStatus` estendido + listener `failed` async, §a), o guard de
> double-`/complete` (§4.2b, agora obrigatório porque `attempts:7` está LIVE), a métrica/alerta em
> 3 categorias (§4.5/§e) e o alinhamento com o cron de timeout do backend (§4.6b). O retry de
> transientes **já está LIVE** no produtor (não é mais escopo a habilitar); o threading completo
> da `Idempotency-Key` (§8 open #7) e o lineage `original_execution_id` (§d1, PR #59) são
> trabalho coordenado fora deste spec mas pré-requisitos de correção dado o retry ligado.
> **Issue:** bernardTavares/bevox-harness (a abrir — J3 + DEBT-05)

> **⚠️ Nota de altitude.** Esta entrega é deliberadamente *minimal e idiomática*: reusa o
> padrão de **retenção** (`removeOnFail`/`removeOnComplete`) já shipado em `condense-queue.ts:43-49`
> e `eval-queue.ts:33-37`, e o padrão de `worker.on("failed", ...)` já shipado em
> `condense-worker.ts:64`. **NÃO** introduz uma nova queue, novo produtor, ou novo subsistema de
> infra — o harness é *consumer-only* no dispatch (o `bevox` orchestration-service é quem
> enfileira).
>
> **⚠️ PIVÔ MATERIAL (2026-06-03, producer contract confirmado).** O mecanismo de
> dead-letter NÃO é "o conjunto `failed` retido do BullMQ". **A dead-letter authoritativa
> vive no BACKEND** como `status='dead_letter'` na execução — a UI de staff-ops para
> replay é *keyed* nesse status, já está **built-and-waiting** mas **ainda não é escrita**
> por ninguém. O harness DEVE escrevê-la: quando a tentativa **final** de `attempts:7`
> falha por motivo **transiente** (`job.attemptsMade + 1 >= job.opts.attempts` no
> `worker.on("failed")`), o harness chama o backend para setar `status='dead_letter'` +
> emitir `action='retry_exhausted'` (§4.3, §a-callbacks). O **conjunto `failed` retido**
> (`removeOnFail`) é re-escopado de "a DLQ" para **retenção local de jobs falhados** —
> um auxílio **forense / fallback quando o backend ou Redis está down**, NÃO a fonte de
> verdade do estado dead-letter. **NÃO** introduz nova queue dedicada no harness — o
> sinal dead-letter é um *callback* ao backend existente. A fila dedicada
> `bevox.harness.dead-letter` (Option C) fica explicitamente **diferida para v2**.
>
> **⚠️ Correção material vs. a hipótese inicial (revisão SRE 2026-06-02).** A versão original
> propunha setar `attempts`/`backoff` como **worker-defaults** e usar `job.discard()` para barrar
> poison. Ambos estão **errados** contra `bullmq@5.76.9`: (1) `attempts`/`backoff` NÃO são
> `WorkerOptions` (são job-options, producer-side) — setá-los no Worker é silenciosamente
> ignorado; logo **retry de transientes não é entregável consumer-only** (vira §8 open #1).
> (2) `Job.discard()` é `@deprecated` e síncrono `void` — `await job.discard().catch(...)`
> lançaria `TypeError`; substituído por `UnprocessablePayloadError extends UnrecoverableError`.
> O que o consumer entrega de fato: **retenção + fail-loudly + observabilidade/alerta**, não
> retry. Ver §1, §4.3, §4.5, §4.6 e §8.

## §1. Context

O worker de dispatch é `startConsumer` em `src/integration/bullmq-consumer.ts:14-43`. Ele
constrói `new Worker(queueName, processor, { connection: { url } })` (`:17-34`) **sem nenhum
job-option** — sem `attempts`, sem `backoff`, sem `removeOnFail`, sem `removeOnComplete`.
BullMQ aplica então o default `attempts: 1` (sem retry). O processor (`:19-30`) envolve
`handleExecution(payload, ctx)` em try/catch e, em erro, loga `logger.error(... "Job failed")`
e dá `throw err` (`:27-28`) — o que apenas leva o job ao **`failed` set interno** do BullMQ
(um *estado* do job), que é **retenção local de jobs falhados**, NÃO a dead-letter
authoritativa. Há um `worker.on("error", ...)` de nível worker (`:36-38`), mas **nenhum**
`worker.on("failed", ...)` — em contraste com `src/workers/condense-worker.ts:64` e
`src/evals/eval-worker.ts:71`, que ambos registram um listener de `failed`.

> **Producer contract confirmado (2026-06-03):** o orchestration-service enfileira com
> `attempts: 7`, exponential backoff (janela total ~635s), na queue `bevox.execution.dispatch`,
> com `jobId = execution_id`. **Retry está LIVE em produção.** Logo o consumer já recebe
> redeliveries e a tentativa final do `attempts:7` é onde a dead-letter authoritativa
> (`status='dead_letter'` no backend) tem de ser escrita — ver §4.3 e §a-callbacks. (Nota:
> esse nome de queue `bevox.execution.dispatch` é o do produtor confirmado; o default
> `HARNESS_QUEUE_NAME` no `env.ts:24` deste repo é `execution.dispatch.agent_harness` —
> em prod o env aponta para o nome real do produtor.)

**Site do descarte J3:** `handleExecution` em `src/runtime/execution-handler.ts:830-841`. O
passo 1 chama `parseExecutionPayload(rawPayload)` dentro de try/catch; em falha faz
`logger.error({ err }, "Invalid dispatch payload"); return;` (`:836-840`) — um `return`
**silencioso, sem `throw`**. Como retorna (não lança), o processor do worker trata o job como
**SUCESSO** e o BullMQ o marca `completed`. Sem retry, sem DLQ, sem callback ao backend — a
execução simplesmente **some**.

> **Correção de line-ref do audit:** o audit cita `execution-handler.ts:710` como o site J3;
> esse ref está *stale*. O descarte real é `:830-841`. A linha 710 hoje está dentro do loop de
> escalation do surface-agent.

`parseExecutionPayload` está em `src/runtime/execution-handler.ts:566-573`: lança em overflow
de byte-length (`> MAX_PAYLOAD_BYTES`, `:569-571`) e delega a `executionPayloadSchema.parse(raw)`
(`:515-558`, `.passthrough()`), que lança `ZodError` em violação de shape. Logo **J3 cobre
AMBOS**: payload oversize **e** Zod-inválido.

**Assimetria com o caminho de falha:** o boundary de erro *em-execução* em
`src/runtime/execution-handler.ts:1662-1698` **notifica** o backend — chama
`sendComplete(execution_id, execution_token, buildCompletePayload({ strategy: "failed" }))`
(`:1674-1680`), atualiza a session para `failed` (`:1682`), deleta a dedup key (fix C12,
`:1691`), e relança. Esse boundary é **inalcançável para J3** porque o payload ainda não foi
validado — `execution_id` / `execution_token` são *untrusted/indisponíveis* em `:833-841`.

**Cliente de callback:** `src/integration/bevox-callback.ts`. `sendComplete` (`:125-133`),
`updateStatus`, `sendTrace`, `sendStream` **todos** exigem um `executionId` + `execution_token`
válidos (enviado como `X-Execution-Token`, `post` em `:15-38`). `BASE_URL` é module-level de
`config.bevox.callbackBaseUrl` (`:7`). **Não existe** callback que notifique o backend de uma
execução descartada/improcessável.

**Claim do DEBT-05:** `.claude/rules/harness-payload.md:76-77` diz:
`Worker BullMQ valida via Zod. Falha → loga em level:50 (fatal) e descarta (sem canal de erro
hoje; v2 vai pra dead-letter).` Duas imprecisões: (1) o código usa `logger.error` = Pino
**level 50 = ERROR**, não FATAL (level 60) — a anotação "(fatal)" está **errada**; (2) promete
uma dead-letter futura ("v2 vai pra dead-letter"). `docs/architecture/evals.md:173` diz à parte
"No DLQ". O nome literal `bevox.harness.dead-letter` aparece **somente** no audit
(`docs/audits/runtime-gap-audit-2026-06-02.md:283`), **não** em nenhum rule ou source file — ou
seja, o audit *overstates* levemente a regra (a regra promete um DLQ futuro em termos vagos, não
nomeia um existente). **Nenhuma** DLQ, **nenhum** produtor de DLQ, e **nenhuma** referência a
`bevox.harness.dead-letter` existem em `src/`.

**Precedentes idiomáticos no repo (para o fix):** filas secundárias já configuram
retry/retenção — `src/integration/condense-queue.ts:43-49` (`removeOnComplete: true,
removeOnFail: { age: 3600 }, attempts: 3, backoff: exponential 5s`) e
`src/evals/eval-queue.ts:33-37` (`removeOnComplete: 1000, removeOnFail: 100, attempts: 2,
backoff: exponential 5s`). **Ponto crítico (verificado contra `bullmq@5.76.9`,
`node_modules/bullmq/dist/esm/interfaces/worker-options.d.ts`):** *(correção SRE 2026-06-03:
versões anteriores deste spec citavam `5.58.5`; a versão de fato instalada na lockfile é
`5.76.9` — os refs de linha `job.js:483` (check `instanceof UnrecoverableError`) e `job.js:973`
(`discard()` `@deprecated`, síncrono `void`) e a ausência de `attempts`/`backoff` em
`WorkerOptions` foram re-conferidos e ainda batem em `5.76.9`; as conclusões mantêm-se.)* essas opções estão setadas no
**produtor** (`queue.add`) porque **`attempts` e `backoff` NÃO são `WorkerOptions`** — vivem em
`base-job-options.d.ts:29,33` (job options, producer-side). O `WorkerOptions` aceita
**apenas** `removeOnComplete?: KeepJobs` (`:77`), `removeOnFail?: KeepJobs` (`:87`),
`maxStalledCount`, `maxStartedAttempts` e `concurrency`. O worker de dispatch é **consumer-only**
— o harness **não** possui o produtor (o `bevox` orchestration-service enfileira). **Consequência
de design (corrige a hipótese original deste spec):** o consumer pode controlar **retenção**
(`removeOnComplete`/`removeOnFail`) e `maxStalledCount`, mas **não** pode injetar `attempts`/
`backoff` — esses têm de vir do `queue.add` do orchestration-service ou de um
`queue.defaultJobOptions` setado por quem é dono da `Queue`. Setá-los no construtor do `Worker`
(como uma versão anterior deste spec propunha, escondido por `as never`) seria **silenciosamente
ignorado** pelo BullMQ. Ver §4.3 e §8 open question #1 para o impacto.

## §2. Problem statement

**Gap 1 — J3: payload improcessável é descartado silenciosamente como "sucesso".**
Em `src/runtime/execution-handler.ts:833-841`, um payload Zod-inválido ou oversize é logado em
`logger.error` (level 50) e recebe `return;` silencioso. O processor reporta o job como
**completion bem-sucedida**; o trabalho é perdido; não há retry, não há captura em dead-letter,
e não há sinal ao backend de que uma execução despachada foi descartada. Para um pilot, isto é
um **buraco de perda de dados**: o orchestration-service acredita que despachou trabalho que
nunca ocorre e nunca é notificado.

**Gap 2 — DEBT-05: nenhum canal de erro durável existe, mas a doc afirma que existe.**
`src/integration/bullmq-consumer.ts:17-34` seta **zero** retenção worker-side e **não** tem
handler de `failed`. O retry de transientes **acontece** (o produtor seta `attempts: 7`, §8 open
#1 ANSWERED), mas o consumer (a) **não retém** os jobs falhados após o esgotamento, e (b)
**nunca escreve `status='dead_letter'` no backend** — a execução morre sem que a UI de staff-ops
replay (keyed em `status='dead_letter'`) saiba. Simultaneamente,
`.claude/rules/harness-payload.md:76-77` promete um DLQ ("v2 vai pra dead-letter") e o audit
(`runtime-gap-audit-2026-06-02.md:283`) lê isso como a afirmação de uma fila
`bevox.harness.dead-letter` existente. **A documentação descreve infraestrutura que não
existe**, e operadores não têm como descobrir ou re-executar jobs descartados. Bônus: a doc
chama level 50 de "(fatal)" quando é ERROR.

**Acoplamento:** os dois gaps são o mesmo problema visto de dois ângulos — não há **canal de
erro durável** para jobs que o harness não consegue processar (seja por payload poison, seja por
falha transiente). Fechar J3 sem dar ao job um destino durável (Gap 2) só troca um descarte
silencioso por outro.

> **Escopo do que o consumer fecha (atualizado 2026-06-03):** o **retry de transientes já está
> LIVE** (`attempts: 7` no produtor, §8 open #1 ANSWERED) — não é mais algo a "habilitar". Logo
> este spec entrega, consumer-side: (a) parar o descarte silencioso (J3), (b) reter jobs falhados
> localmente (forense), (c) **escrever a dead-letter authoritativa no backend** (`status='dead_letter'`
> na tentativa final transiente / poison salvageável) que acende a replay UI, (d) métrica/alerta
> em 3 categorias (§4.5/§e). As mitigações de idempotência/double-complete (§4.2b, §8 risks 9/10,
> opens #5/#7) deixam de ser "pré-condições p/ habilitar retry" e viram **correções obrigatórias
> AGORA**, porque o retry que as expõe já está ligado.

## §3. Goals & non-goals

**Goals:**
- Parar de descartar mensagens silenciosamente. Todo job improcessável (poison) **e** toda
  falha transiente esgotada de retry devem terminar num destino **inspecionável e
  re-executável**, com contexto suficiente para reconciliar/replay.
- Distinguir **poison** (parse falha — re-tentar é inútil, loop garantido) de **transiente**
  (handler falha — re-tentar pode resolver) e tratar cada um corretamente.
- Emitir um **sinal de observabilidade** (`worker.on("failed", ...)` em level 50 com
  `jobId` + `failedReason`), consistente com `condense-worker.ts:64` / `eval-worker.ts:71`.
- **Sinal de SLO/alerta (novo — exigência SRE):** o log de `failed` sozinho **não** é
  observabilidade — é forense. Emitir um **contador** rotulado em **3 categorias distintas**
  (`poison` / `retry_exhausted` / `aborted`, §4.5/§e — NÃO conflar) e um **gauge** de profundidade
  do `failed` set (`queue.getFailedCount()`), com **alerta** quando a profundidade ou a taxa de
  `retry_exhausted` cruzam um limiar (abort NÃO alerta — é esperado). Ver §4.5.
- **Sinal dead-letter authoritativo ao backend:** quando `execution_id`/`execution_token`
  sobreviverem à validação, escrever `status='dead_letter'` no backend (via `updateStatus` com
  `meta`, §a2) para acender a UI de staff-ops replay. Vale para **ambos** os destinos
  authoritativos: transiente-esgotado (attempts:7 exhausted) **e** poison salvageável (§b — senão
  o poison fica invisível à replay UI). **NÃO** usar `sendComplete(strategy:'failed')` como sinal
  dead-letter (não seta `status='dead_letter'`, §a). **O sinal DEVE carregar `Idempotency-Key`**
  (ADR-023) — caso contrário um retry/redelivery do mesmo job duplica.
- Reconciliar a doc: corrigir o label "(fatal)"→"ERROR (level 50)" e alinhar a claim de
  dead-letter com o que de fato é implementado (`.claude/rules/harness-payload.md:76-77`,
  `docs/architecture/evals.md:173`, `docs/architecture/fluxo-de-execucao.md:11,310`).

**Non-goals:**
- **NÃO** introduzir uma fila dedicada `bevox.harness.dead-letter` + produtor + consumer/replayer
  (Option C) **neste pilot** — diferido a v2 (ver §3.1, §8).
- **NÃO** alterar o produtor de dispatch *neste repo* (é cross-repo, no orchestration-service).
  Limitação a respeitar: `attempts`/`backoff` **não** são `WorkerOptions` — o consumer só
  controla retenção (`removeOnComplete`/`removeOnFail`) e `maxStalledCount`. O retry de transientes
  **já está habilitado** pelo produtor (`attempts: 7`, §8 open #1 ANSWERED); este spec **não** o
  altera, apenas fica correto sob ele (dead-letter na exaustão, idempotência, guard double-complete).
- **NÃO** enviar callbacks com `execution_token` não-confiável (oversize/token malformado) — é o
  header de auth (`X-Execution-Token`); ver risco de segurança §8.
- **NÃO** mexer no Redis dedup nem no boundary de erro em-execução (`:1662-1698`) além de
  garantir compat (o C12 fix em `:1691` permanece).

### §3.1 Design options (founder decide; recomendação abaixo)

**Option A — Doc-only reconciliation (mais barato).**
- *Prós:* zero risco de código. Fecha a queixa *literal* do DEBT-05 reescrevendo
  `harness-payload.md:76-77` para o comportamento real (level 50 ERROR + descarte silencioso, sem
  DLQ hoje) e removendo o `bevox.harness.dead-letter` implícito. Honesto até v2.
- *Contras:* **NÃO** corrige J3 — payloads ainda somem sem retry e sem sinal ao backend. Deixa um
  buraco real de perda de dados aberto no pilot. Resolve só metade do finding.

**Option B — Worker fail-loudly + retenção local + sinal dead-letter ao backend (mínimo,
idiomático — RECOMENDADO).**
- *Prós:* reusa o padrão de retenção de `condense-queue.ts:43-49` / `eval-queue.ts:33-37`.
  (1) Seta **worker-defaults de retenção** `removeOnFail: { age }` + `removeOnComplete` em
  `bullmq-consumer.ts` → jobs falhados são **RETIDOS** no `failed` set do BullMQ como
  **retenção local** (auxílio forense / fallback Redis-down inspecionável via API/Arena), em
  vez de evaporarem. **Isto NÃO é a dead-letter authoritativa** — apenas retenção local.
  **(Importante: `attempts`/`backoff` NÃO entram aqui — não são `WorkerOptions`; ver §1 e §4.3.
  Retry de transientes é controlado pelo produtor, que JÁ seta `attempts: 7`, §8 open #1
  ANSWERED.)** (2) J3 lança um `UnprocessablePayloadError` que **estende `UnrecoverableError`
  do BullMQ** a partir de `parseExecutionPayload`, e o BullMQ trata poison como **não-retryable**
  (sem loop — crítico com `attempts: 7` LIVE) via o check `instanceof UnrecoverableError` em
  `job.js:483` — sem depender da API `discard()` deprecada. (3) Adiciona `worker.on("failed", ...)`
  que, na **tentativa final** do `attempts:7` (`job.attemptsMade + 1 >= job.opts.attempts`) por
  motivo transiente, **escreve a dead-letter authoritativa no backend** (`status='dead_letter'` +
  `action='retry_exhausted'`, §a-callbacks) + métrica/alerta (§4.5). (4) Best-effort sinal
  dead-letter **com `Idempotency-Key`** quando `execution_id`/`execution_token` são recuperáveis.
  Depois, corrige a doc. **Sem novo subsistema, sem nova fila no harness, sem nova infra — o
  sinal dead-letter é um callback ao backend existente.**
- *Contras:* o `failed` set retido **não é** uma DLQ verdadeira (sem fila separada; bounded por
  `removeOnFail` age/count). **Pior: a eviction de `KeepJobs.age` é lazy/best-effort** — o BullMQ
  só evicta um job aged quando **outro** job do mesmo tipo (failed) termina depois da expiração
  (`keep-jobs.d.ts`). Numa fila de baixo tráfego, jobs podem ficar retidos muito além do `age`
  (bom p/ inspeção) **ou** um único job falho pode persistir indefinidamente sem nada mais
  falhar — a janela de retenção **não** é um TTL determinístico. Replay é manual via API/Arena.
  A distinção poison-vs-transiente adiciona um branch. O sinal dead-letter ao backend só é possível
  quando token/id sobrevivem. **E se o Redis estiver down, o próprio `failed` set é inalcançável**
  — mas como a dead-letter authoritativa é o `status='dead_letter'` via HTTP (não o `failed` set),
  Redis-down degrada só a retenção local/forense, não o estado authoritativo (ver risco §8.7).

**Option C — Subsistema de dead-letter queue dedicado.**
- *Prós:* um `bevox.harness.dead-letter` Queue producer real (espelhando condense/eval) ao qual o
  handler de `failed` publica com contexto completo do job; durável, replayável, casa com a
  expectativa literal do audit e a promessa da regra. Separação mais limpa para tooling/alerta.
- *Contras:* nova fila + produtor + (eventual) consumer/replayer = **novo subsistema** + nova
  env/config, mais do que o gap exige para um pilot. O harness é consumer-only no dispatch; subir
  um produtor que ele *possui* é mudança de topologia. O BullMQ **já** retém jobs falhados, então
  uma DLQ separada é largamente **redundante** para inspeção/replay neste estágio. Maior superfície
  de teste + infra.

**Recomendação: Option B + a correção de doc da Option A + o sinal dead-letter ao backend.**
É o fix mínimo, idiomático, grounded em padrões já shipados neste repo. J3 fecha completamente:
poison → throw `UnrecoverableError` não-retryable retido no `failed` set + best-effort notify
idempotente + (salvageável) sinal dead-letter ao backend (§b). **Pivô material vs. a versão
anterior deste spec:** o `attempts: 7` do produtor **está LIVE** (não mais hipótese, §8 open #1
ANSWERED). Logo o consumer entrega: (a) **retenção local** de jobs falhados (auxílio forense /
fallback Redis-down — NÃO a fonte de verdade), (b) na **tentativa final** do `attempts:7` falha
por motivo transiente, **escrever a dead-letter authoritativa no backend** (`status='dead_letter'`
+ `action='retry_exhausted'`), que acende a UI de staff-ops replay (built-and-waiting), (c)
poison → `UnrecoverableError` (morre na tentativa 1, sem retry-storm) + sinal dead-letter para
visibilidade no replay UI. A dead-letter **authoritativa vive no backend** (`status='dead_letter'`),
escrita via callback de attempts-exhaustion — o `failed` set retido é só retenção local.
DEBT-05 fecha sua queixa literal (a doc passa a descrever o `failed` set retido como **retenção
local**, e o backend `status='dead_letter'` como o canal authoritativo, sem prometer uma fila
inexistente). Option C (fila dedicada no harness) fica diferida a v2 — não é necessária quando a
dead-letter authoritativa é o estado backend + a retenção local cobre o forense.

## §4. Architecture proposal

### 4.1 Erro tipado para payload improcessável — `execution-handler.ts:566-573`

Introduzir uma classe de erro que o worker possa **detectar por tipo** (poison vs transiente).
`parseExecutionPayload` passa a embrulhar suas duas causas de falha (oversize + ZodError) nela.

```typescript
// src/runtime/execution-handler.ts (perto de parseExecutionPayload, :566)
import { UnrecoverableError } from "bullmq";

/**
 * J3 — payload que o harness NUNCA conseguirá processar (oversize ou
 * Zod-inválido). Distinto de erros transientes do handler: re-tentar um
 * payload poison é um loop garantido.
 *
 * ESTENDE `UnrecoverableError` do BullMQ (NÃO `Error`): o BullMQ honra
 * `err instanceof UnrecoverableError` em `job.js:483` e move o job
 * direto pro `failed` set sem re-tentar, **independente de `attempts`**.
 * Isto substitui a abordagem `job.discard()` da versão anterior — que era
 * (a) `@deprecated` no bullmq 5.76.9 e (b) síncrona/`void` (logo
 * `await job.discard().catch(...)` lançava `TypeError`). Sem `discard()`.
 *
 * Carrega o execution_id/token quando recuperáveis de um payload
 * parcialmente válido, para best-effort backend notification.
 */
export class UnprocessablePayloadError extends UnrecoverableError {
  readonly nonRetryable = true as const;
  readonly executionId?: string;
  readonly executionToken?: string;
  constructor(message: string, salvage?: { executionId?: string; executionToken?: string }) {
    super(message);
    this.name = "UnprocessablePayloadError";
    this.executionId = salvage?.executionId;
    this.executionToken = salvage?.executionToken;
  }
}
```

> **Nota de teste (testabilidade):** o mock `vi.mock("bullmq", ...)` em
> `tests/unit/integration/bullmq-consumer.test.ts:5-20` hoje só exporta `Worker`. Ao importar
> `UnrecoverableError` de `bullmq` no `execution-handler`, o mock **precisa** re-exportar
> `UnrecoverableError` (uma classe real estendível) — senão `extends UnrecoverableError` resolve
> pra `undefined` e o `instanceof` quebra nos testes. Estender a factory do mock.

```typescript
export function parseExecutionPayload(raw: unknown): ExecutionPayload {
  const json = JSON.stringify(raw);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_PAYLOAD_BYTES) {
    // Oversize: id/token NÃO confiáveis (não validados) → sem salvage.
    throw new UnprocessablePayloadError(
      `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes (got ${byteLength})`,
    );
  }
  const result = executionPayloadSchema.safeParse(raw);
  if (!result.success) {
    // Salvage SOMENTE id+token que individualmente passam o schema estrito
    // (uuid + 20..512 chars). Se não passarem, ficam undefined → sem notify.
    const salvage = salvageIdToken(raw);
    throw new UnprocessablePayloadError(
      `Invalid dispatch payload: ${result.error.message}`,
      salvage,
    );
  }
  return result.data;
}
```

`salvageIdToken` revalida **isoladamente** apenas os dois campos de auth, com os mesmos bounds do
schema vivo (`:517-518`), para nunca propagar token-lixo:

```typescript
const salvageSchema = z.object({
  execution_id: z.string().uuid(),
  execution_token: z.string().min(20).max(512),
});

function salvageIdToken(raw: unknown): { executionId?: string; executionToken?: string } {
  const r = salvageSchema.safeParse(raw);
  if (!r.success) return {};
  return { executionId: r.data.execution_id, executionToken: r.data.execution_token };
}
```

> **Por que `safeParse` no salvage e não `.parse`:** evita uma segunda exceção dentro do path de
> erro; retorna `{}` (sem notify) quando id/token não são confiáveis — exatamente o
> comportamento seguro do risco §8.3.

### 4.2 J3 deixa de retornar silenciosamente — `execution-handler.ts:830-841`

O `try/catch` em volta de `parseExecutionPayload` passa de `return;` silencioso para:
(a) best-effort notify quando há salvage; (b) **rethrow** para o worker decidir o destino.

```typescript
export async function handleExecution(rawPayload: unknown, ctx: ExecutionContext): Promise<void> {
  // 1. Validate payload (size + shape)
  let payload: ExecutionPayload;
  try {
    payload = parseExecutionPayload(rawPayload);
  } catch (err) {
    if (err instanceof UnprocessablePayloadError) {
      logger.error(
        { jobErr: err.message, hasSalvage: Boolean(err.executionId) },
        "Unprocessable dispatch payload (poison) — routing to failed set + dead_letter",
      );
      // §b: poison salvageável também deve aparecer na replay UI do staff →
      // o sinal authoritativo é status='dead_letter' (NÃO um /complete(failed),
      // que era invisível à replay UI). Como o `UnprocessablePayloadError`
      // estende `UnrecoverableError`, o worker `failed` listener (§4.3) já
      // dispara o dead_letter signal — então NÃO duplicamos a chamada aqui.
      // Este handler apenas relança; o failed listener faz o salvage→dead_letter.
      // (Se o salvage não sobrevive — oversize/token-lixo — não há sinal possível,
      //  só retenção local + log; risco §8.3.)
    }
    // SEMPRE relança: o worker marca o job `failed` (UnrecoverableError → sem
    // retry-storm) e o failed listener escreve status='dead_letter' (§4.3/§a).
    throw err;
  }
  // ... resto inalterado (dedup, session, pipeline, etc.)
```

Diferença vs J3 atual: o `return;` silencioso (`:840`) some; agora **sempre** há `throw`, então o
job vai para o `failed` set retido (§4.3) e nunca mais é reportado como `completed`.

> **Dedup é seguro:** J3 falha **ANTES** do `SET NX` (`:852-857`, passo 2). O fix C12 (`:1691`)
> que deleta a dedup key só roda no boundary em-execução (`:1662-1698`), que J3 nunca alcança.
> Logo o novo throw de parse não toca a dedup key — sem double-acquire, sem strand (risco §8.2).

### 4.2b Double-`/complete` no boundary em-execução — REQUERIDO agora (retry LIVE)

Esta seção era "pré-condição p/ habilitar retry". **Não é mais condicional:** o produtor seta
`attempts: 7` em produção (§8 open #1 ANSWERED) → runs re-executam de fato. O boundary em-execução
(`:1662-1698`) foi escrito **assumindo `attempts: 1`** e, por isso, é seguro *só por acidente* —
acidente que o `attempts:7` LIVE **quebra**. Os dois problemas abaixo são bugs de correção
**ativos hoje**, não hipotéticos:

1. **`/complete` duplicado por dupla emissão dentro do mesmo run.** No happy path o
   `sendComplete(success)` ocorre em `:1572-1584`. Depois dele, **ainda dentro do mesmo `try`**,
   rodam o hook de eval (`:1590`), o enqueue de memória (`:1604-1645`) e o
   `sessionStore.update({status:"completed"})` (`:1648-1651`). Este último **não** está
   `.catch()`-guarded — um hiccup de Redis ali **lança**, cai no catch `:1662` e dispara um
   **segundo** `sendComplete(strategy:"failed")` para uma execução que o backend já viu como
   sucesso. *Mitigação obrigatória antes de qualquer retry:* (a) envolver passos pós-`/complete`
   (13b/13c/14) num `.catch()` que **não** relança (são genuinamente off-hot-path), **ou** (b)
   um flag `completeSent` no escopo do run que o catch `:1662` consulta antes de emitir o
   `failed` callback. Recomenda-se (a)+(b) combinados.
2. **`/complete` duplicado entre runs (retry).** Se `attempts > 1` (producer-side), um throw no
   boundary já emitiu `sendComplete(failed)` no run N; o run N+1 re-executa o handler inteiro e,
   em sucesso, emite `sendComplete(success)`. Isso é *correto* (a execução de fato terminou
   bem no retry), mas o backend vê `failed` depois `success` para o mesmo `execution_id`.
   *Mitigação:* o `sendComplete` do boundary `:1674-1680` **DEVE** passar
   `Idempotency-Key = deriveIdempotencyKey({execution_id, step_index: 0}, "complete-boundary")`
   (hoje não passa nenhum) e o backend trata o `/complete` como **last-write-wins** por
   `execution_id`, ou o handler marca a execução terminal e o retry detecta via session-state e
   faz `return` cedo. **Decisão de contrato com o backend — §8 open #5.**

> **Atualização (2026-06-03):** com `attempts: 7` LIVE no produtor, (1) e (2) já são bugs de
> callback duplicado **ativos** — runs re-executam, então o spec **prioriza** ambas as mitigações
> como blocking, lado a lado com a retenção e o sinal dead-letter. Não há mais "gate de retry":
> o retry já está ligado; falta o harness ficar correto sob ele.

### 4.3 Worker retenção + fail-loudly — `bullmq-consumer.ts:17-43`

Reusa o padrão de **retenção** de `condense-queue.ts:43-49` (`removeOnComplete`/`removeOnFail`),
**mas NÃO `attempts`/`backoff`** — esses não são `WorkerOptions` (§1) e seriam silenciosamente
ignorados. O poison é tratado como não-retryable pelo **próprio tipo** (`UnrecoverableError`,
§4.1), sem precisar de `job.discard()`.

```typescript
const DISPATCH_FAILED_RETENTION_S = config.harness.dispatchFailedRetentionS; // default 86400

export async function startConsumer(ctx: ExecutionContext): Promise<Worker> {
  const { queueName } = config.harness;

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const payload: unknown = job.data;
      logger.info({ jobId: job.id }, "Job received");
      try {
        await handleExecution(payload, ctx);
        logger.info({ jobId: job.id }, "Job completed");
      } catch (err) {
        // Poison NÃO precisa de tratamento especial aqui: `UnprocessablePayloadError`
        // estende `UnrecoverableError` (§4.1), então o BullMQ NÃO re-tenta mesmo
        // com o `attempts: 7` LIVE do produtor (check `instanceof` em job.js:483).
        // Sem `job.discard()` (deprecated + síncrono/void na v5.76.9).
        logger.error(
          { jobId: job.id, poison: err instanceof UnprocessablePayloadError, err },
          "Job failed (attempt)",
        );
        throw err; // → failed set local; dead_letter authoritativo no failed listener (§a)
      }
    },
    {
      connection: { url: config.redis.url } as never,
      // Worker-level RETENTION apenas. `attempts`/`backoff` NÃO são WorkerOptions
      // (vivem em base-job-options; producer-side) — ver §1. Setá-los aqui é
      // silenciosamente ignorado pelo BullMQ. Retry de transientes = §8 open #1.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: DISPATCH_FAILED_RETENTION_S }, // retenção (NÃO TTL determinístico — eviction lazy)
      // Anti-stalled-storm: limita re-delivery por lock expirado (SIGKILL etc).
      maxStalledCount: 1,
    } as WorkerOptions,
  );

  worker.on("error", (err) => {
    logger.error({ err }, "BullMQ worker error");
  });

  // J3/DEBT-05: canal de observabilidade + sinal dead-letter authoritativo.
  // Consistente com condense-worker.ts:64 / eval-worker.ts:71.
  //
  // A dead-letter authoritativa vive no BACKEND (status='dead_letter'). Este
  // listener é o ÚNICO ponto que a escreve — e SOMENTE na tentativa FINAL do
  // attempts:7 (transiente esgotado) ou em poison salvageável (§b). O `failed`
  // set retido é só retenção local / forense.
  worker.on("failed", async (job, err) => {
    const poison = err instanceof UnprocessablePayloadError;
    // attempts:7 LIVE (§8 open #1 ANSWERED). attemptsMade conta tentativas já
    // FEITAS; +1 = a atual. `>= opts.attempts` ⇒ esta é a última.
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    const exhausted = attemptsMade + 1 >= maxAttempts;
    logger.error(
      {
        jobId: job?.id,
        attemptsMade,
        maxAttempts,
        failedReason: job?.failedReason ?? err?.message,
        poison,
        exhausted,
      },
      "Job moved to failed set (local retention)",
    );

    // §a — Sinal dead-letter AUTHORITATIVO ao backend. Dispara quando:
    //   (i) transiente esgotou todas as attempts:7 (exhausted && !poison), OU
    //   (ii) poison salvageável (§b — visibilidade no replay UI).
    // NUNCA dispara para abort terminal (§e) — abort nunca chega aqui (J8 ACKa
    // o job; não relança).
    const salvage = poison ? (err as UnprocessablePayloadError) : undefined;
    const execId = salvage?.executionId ?? (job?.data as { execution_id?: string })?.execution_id;
    const execToken =
      salvage?.executionToken ?? (job?.data as { execution_token?: string })?.execution_token;
    if ((exhausted || poison) && execId && execToken) {
      const idemKey = MutationTool.deriveIdempotencyKey(
        { execution_id: execId, step_index: 0 } as ToolContext,
        "dead-letter",
      );
      // §a2 PRIMARY: updateStatus com meta. Seta status='dead_letter' + action.
      // NÃO usar sendComplete(strategy:'failed') — não acende a replay UI (§a2).
      await updateStatus(execId, execToken, "dead_letter", {
        action: "retry_exhausted",
        failedReason: job?.failedReason ?? err?.message,
        attemptsMade,
        idempotencyKey: idemKey,
      }).catch((cbErr) => {
        logger.warn({ cbErr, jobId: job?.id }, "Failed to write dead_letter status to backend");
      });
    }

    // §4.5/§e — sinal de SLO. Counter rotulado em TRÊS categorias distintas
    // (poison | retry_exhausted | aborted). `aborted` jamais é incrementado
    // aqui (abort nunca alcança o failed listener — §e); fica explícito só p/
    // documentar que o dashboard NÃO deve conflá-las.
    recordDeadLetter({ category: poison ? "poison" : exhausted ? "retry_exhausted" : "transient_attempt" });
  });

  activeWorker = worker;
  logger.info({ queue: queueName }, "BullMQ consumer started");
  return worker;
}
```

> **Sobre não re-tentar poison:** a anti-loop é o **tipo** (`UnrecoverableError`), não uma
> chamada imperativa. Confirmado contra `bullmq@5.76.9` (`job.js:481-483`): o BullMQ só
> re-enfileira se `attemptsMade + 1 < attempts && !discarded && !(err instanceof
> UnrecoverableError)`. Como `UnprocessablePayloadError extends UnrecoverableError`, o terceiro
> termo é falso → poison vai direto pro `failed` set, mesmo com `attempts: 7` setado pelo
> produtor — crítico agora que o retry está LIVE (sem isso, poison entra em retry-storm 7x).
> `job.discard()` foi **removido** do design (deprecated; síncrono `void`, logo o
> `.catch()` original lançaria `TypeError`).

> **Imports adicionais no `bullmq-consumer.ts`:** o listener `failed` passa a importar
> `updateStatus` de `../integration/bevox-callback.js` (estendido — §a2), `MutationTool`
> (`deriveIdempotencyKey`) de `../tools/_shared/mutation-tool.js` e o tipo `ToolContext`.
> O listener vira `async` (BullMQ aceita listener async; ele faz fire-and-forget do callback
> via `.catch`, sem bloquear a fila).

### §a. Callback surface — o sinal dead-letter authoritativo (PIVÔ, 2026-06-03)

**Pivô central.** A versão anterior tratava o conjunto `failed` retido como "a DLQ" e o
`sendComplete(strategy:'failed')` como o sinal de morte. **Ambos errados** contra o contrato
backend confirmado:

- A dead-letter authoritativa é **`status='dead_letter'` na execução, no backend** — a UI de
  staff-ops para replay é *keyed* nesse status (built-and-waiting, ainda não escrita por ninguém).
- `sendComplete(strategy:'failed')` **NÃO** seta `status='dead_letter'` — apenas registra um
  `/complete` com `strategy=failed`. Isso **não acende a replay UI**. Continuar usando-o para
  *significar* dead-letter deixa toda execução morta **invisível** ao staff.

**Os dois callbacks ficam semanticamente DISTINTOS:**

| Evento | Callback | Quando | Frequência |
|---|---|---|---|
| Falha de uma tentativa | `POST /complete` (`strategy:'failed'`) | toda tentativa que falha (boundary `:1674-1680`) | a cada tentativa que falha |
| Retry esgotado (attempts:7) | sinal `dead_letter` (§a2) | tentativa FINAL transiente (`worker.on("failed")`) | **uma vez**, na última tentativa |

#### §a2. Superfície precisa do callback

**RECOMENDAÇÃO PRIMÁRIA — estender `updateStatus`.** Adicionar um 4º arg opcional `meta` a
`updateStatus(executionId, token, status, meta?)` em `src/integration/bevox-callback.ts:116-123`
(hoje `(executionId, token, status)`), carregando
`{ action: 'retry_exhausted', failedReason, attemptsMade }` (+ `idempotencyKey` propagado ao
header). POSTado para `/status` (já é o endpoint do `updateStatus`):

```typescript
// src/integration/bevox-callback.ts — updateStatus estendido (:116-123)
export interface StatusMeta {
  action?: "retry_exhausted";
  failedReason?: string;
  attemptsMade?: number;
  idempotencyKey?: string; // ADR-023 — vira header, não body
}

export async function updateStatus(
  executionId: string,
  token: string,
  status: string,
  meta?: StatusMeta,
): Promise<void> {
  const { idempotencyKey, ...body } = meta ?? {};
  await post(
    `/api/v1/executions/${executionId}/status`,
    token,
    { status, ...body },          // { status: 'dead_letter', action, failedReason, attemptsMade }
    idempotencyKey,               // ADR-023 — `Idempotency-Key` header (post já aceita :15-38)
  );
  logger.debug({ executionId, status, action: meta?.action }, "Sent status update");
}
```

> Retrocompat: `meta` é opcional → as chamadas existentes de `updateStatus(id, token, status)`
> (ex. status "running") seguem inalteradas; o body continua `{ status }`.

**ALTERNATIVA — `sendDeadLetter(...)` dedicado** para um endpoint de backend dedicado
(ex. `POST /executions/{id}/dead-letter`). Mais explícito, mas **pendente confirmação de
endpoint no backend** (§8 open #2 reescrita). Para o pilot, estender `/status` é o caminho de
menor fricção porque o endpoint já existe; adotar o dedicado se/quando o backend o expuser.

**CRÍTICO — parar de usar `sendComplete(strategy:'failed')` PARA SIGNIFICAR dead-letter.**
Ele permanece para *falha de tentativa* (cada tentativa que falha → `/complete(failed)` no
boundary `:1674-1680`), mas **não** é o sinal dead-letter. O sinal dead-letter (attempts-exhausted)
é emitido **uma vez**, do `worker.on("failed")`, via `updateStatus(..., 'dead_letter', ...)`.

### 4.4 Config — `env.ts:24` + `harness-config.ts:17-21`

Um env opcional com default conservador (não-breaking). **NÃO** adicionamos
`HARNESS_DISPATCH_ATTEMPTS` — `attempts` é producer-side (§1), então um env consumer-side seria
dead config (silenciosamente ignorado). Se a §8 open #1 decidir habilitar retry, o knob vive no
orchestration-service, não aqui.

```typescript
// src/config/env.ts (junto a HARNESS_QUEUE_NAME :24)
HARNESS_DISPATCH_FAILED_RETENTION_S: z.coerce.number().int().positive().default(86_400), // 24h
```

```typescript
// src/config/harness-config.ts (no bloco harness: :17-21)
harness: {
  logLevel: env.HARNESS_LOG_LEVEL,
  maxExecutionTimeMs: env.HARNESS_MAX_EXECUTION_TIME_MS,
  queueName: env.HARNESS_QUEUE_NAME,
  dispatchFailedRetentionS: env.HARNESS_DISPATCH_FAILED_RETENTION_S,
},
```

> **Não adicionamos `HARNESS_DLQ_QUEUE_NAME`** — não há fila dedicada no Option B. Esse env entra
> só se v2 adotar Option C.

### 4.5 Observabilidade & SLO — métrica + alerta de dead-letter (novo)

O `worker.on("failed", ...)` log é forense, não alertável. Para o ângulo SRE o spec adiciona:

- **Counter** `harness_dispatch_dead_letter_total{category}` — incrementado em
  `recordDeadLetter()`. A label `category` tem **TRÊS valores distintos** que dashboards
  **NÃO** podem conflar (§e):
  - **`poison`** — `UnrecoverableError`, morte na **tentativa 1** (payload malformado). Esperado,
    baixo volume; spike = regressão de contrato do produtor.
  - **`retry_exhausted`** — transiente que esgotou **todas** as `attempts:7`. **Sinal de
    incidente** (backend/Redis/LLM all-down). É a categoria que escreve `status='dead_letter'`.
  - **`aborted`** — abort terminal de wall-clock/cost (J8). **ESPERADO, NÃO é incidente** — e
    **jamais incrementado por este listener** (abort nunca alcança o `failed` listener — §e). A
    label existe só para o dashboard tratar abort como linha-de-base separada, alimentada pelo
    path de abort (J8), não daqui.
  (Uma 4ª label transitória `transient_attempt` cobre uma falha transiente **não-final** — uma
  tentativa intermediária que ainda vai re-tentar; útil para taxa de flakiness, não é dead-letter.)
- **Gauge** `harness_dispatch_failed_depth` — amostrado periodicamente via
  `worker.getFailedCount()` (ou `queue.getFailedCount()` de uma `Queue` read-only sobre o mesmo
  nome). Como a eviction de `removeOnFail.age` é **lazy** (§3.1 contras), a profundidade pode
  crescer sem nada limpar — o gauge é a única forma de saber.
- **Wiring:** reusar o caminho de telemetria já presente (`src/observability/`, OTEL gated por
  `OTEL_ENABLED`). Quando OTEL off, `recordDeadLetter` degrada para um contador in-memory + log
  (no-op de export). **Não** introduz dependência nova.

**Alertas propostos (SLO-driven, não gut-feeling):**
- `harness_dispatch_dead_letter_total{category="retry_exhausted"}` rate > **0 por 5min** →
  **warning** (transiente esgotado é sempre um sinal; idealmente zero em regime).
- Mesma série rate sustentada > limiar por **1h** → **critical** (queima de orçamento: backend/
  Redis/LLM degradado, jobs morrendo em massa).
- `harness_dispatch_failed_depth` > **N** (ex. 100) → **warning** de backlog de replay pendente.
- `category="poison"` com spike anômalo → **warning** (provável regressão de contrato no
  orchestration-service emitindo payloads malformados).
- **`category="aborted"` NÃO alerta** — é esperado (limite de custo/tempo). Conflá-lo com
  `retry_exhausted` num alerta geraria ruído e mascararia incidentes reais (§e).

> SLI sugerido: *fração de jobs despachados que terminam em `completed` (não `failed`)* sobre
> janela de 30d. O `failed` set + counter são a fonte; o orçamento de erro guia se vale priorizar
> robustez de payload vs. features. **Threshold concreto = decisão do founder/ops (§8 open #6).**

### 4.6 Shutdown com job em-flight — interação com `worker.close()` (novo)

`registerShutdownHandlers` (`src/bootstrap/shutdown.ts:19-71`) chama `stopConsumer()`
(`bullmq-consumer.ts:45-51`) em SIGTERM/SIGINT, que faz `activeWorker.close()` **sem `force` e
sem timeout**. Em BullMQ, `close()` (graceful) **espera o job ativo terminar**. Isso interage
mal com o resto do design:

- O job de dispatch pode rodar até `HARNESS_MAX_EXECUTION_TIME_MS` (120s). Se o grace period da
  plataforma (Docker `stop_grace_period`, k8s `terminationGracePeriodSeconds`) for **menor**, o
  processo recebe **SIGKILL** no meio → o lock do BullMQ expira → o stalled-checker re-entrega o
  job a outra réplica. Com `maxStalledCount: 1` (§4.3) limitamos isso a **uma** re-entrega antes
  de ir pro `failed` set, evitando storm.
- **Re-entrega ≠ idempotência grátis.** O job re-roda do zero (o C12 fix já deletou a dedup key
  no boundary, ou ela nunca foi setada se a morte foi antes do `SET NX`). Tool side-effects e o
  `/complete` re-executam — protegidos **apenas** pela `Idempotency-Key` (§4.2/§4.2b). Confirmar
  que as 5 mutation tools propagam a key (hoje só `create-appointment` o faz — CRIT #10 não
  landed; ver §8 open #7).
- **Recomendação:** alinhar `terminationGracePeriodSeconds` ≥ `HARNESS_MAX_EXECUTION_TIME_MS` +
  margem (ex. 150s) no manifest do hub, **ou** introduzir um drain explícito que pare de buscar
  jobs novos (`worker.pause()` / `autorun:false` semantics) e aguarde o in-flight com um teto.
  Para o pilot, a opção de manifest é a mais barata e não toca código. **Decisão de infra — §8
  open #8.**

#### §4.6b Acoplamento com a reconciliação do backend (NOVO, 2026-06-03)

O backend **reconcilia independentemente** via cron de DB **`bevox.timeout.scan`** (a cada
**2 min**): seta `status='timeout'` quando `dispatched_at + 120000ms < now()` e faz **handoff
para humano**. Isso **não conhece** o harness, e o harness **não conhece** o cron. Os dois
relógios entram em conflito:

- Janela de retry do BullMQ (`attempts: 7`, exponential backoff) ≈ **~635s** total.
- Janela do cron de timeout do backend = **120000ms** (2 min) + até 2 min de latência de scan.

**Hazard de double-handling:** um job pode **ainda estar re-tentando** no BullMQ (dentro dos ~635s)
**depois** que o backend já escalou aquela execução para um humano (passou de 120s). O harness
então completa/dead-lettera uma execução que o backend já entregou a um humano → **duas respostas /
duas pessoas tratando o mesmo caso**.

**Mitigações:**

1. **REQUERIDO (já endereçado pela branch):** `HARNESS_MAX_EXECUTION_TIME_MS < 120000` para que o
   harness **nunca** ultrapasse a janela de timeout do backend num único run. **Default agora
   90000** (landed na branch *op-execution-bounding*; o `env.ts:23` deste tree ainda mostra
   `120000` — o fix vem com a branch). Garante que um run *isolado* termina antes do cron, mas
   **NÃO** resolve o conflito da janela de retry total (~635s > 120s) — ver (2).
2. **BEST-FIX (cross-repo, recomendar como v2):** o backend **carimba `dispatched_at`** no payload
   de dispatch → o harness deriva um **deadline ABSOLUTO alinhado ao relógio do backend**
   (`dispatched_at + 120000ms`) e **para de re-tentar / não completa** depois dele, em vez de só
   medir o tempo do run atual. Sem isso, os dois relógios são independentes e a soma das tentativas
   pode cruzar a fronteira de handoff.
3. **Sinal forense:** emitir um log estruturado **`execution.late_completion`** quando o harness
   completa um job **passado seu próprio deadline** (`now() > deadline`). É o sinal de que um
   handoff-humano do backend **pode** ter ocorrido em paralelo — material para reconciliação e
   alerta, mesmo antes do best-fix (2) landar.

> **Cross-spec:** a derivação do deadline absoluto a partir de `dispatched_at` é a mesma família
> de "lineage do payload" da §d1 (`original_execution_id`) — ambas dependem do backend enriquecer
> o payload de dispatch. Coordenar como um único contrato de payload com o orchestration-service.

### 4.7 Doc reconciliation — DEBT-05

**`.claude/rules/harness-payload.md:76-77`** (hoje, impreciso):
```
Worker BullMQ valida via Zod. Falha → loga em `level:50` (fatal) e
descarta (sem canal de erro hoje; v2 vai pra dead-letter).
```
Corrigir para o comportamento real pós-fix:
```
Worker BullMQ valida via Zod. Payload improcessável (Zod-inválido ou oversize)
→ `parseExecutionPayload` lança `UnprocessablePayloadError` (estende
`UnrecoverableError`); o handler relança (NÃO retorna silenciosamente) e o worker
o roteia para o `failed` set do BullMQ como RETENÇÃO LOCAL (`removeOnFail.age`,
default 24h — auxílio forense / fallback Redis-down, NÃO a dead-letter
authoritativa). A dead-letter AUTHORITATIVA vive no BACKEND como
`status='dead_letter'`, escrita pelo `worker.on("failed")` na tentativa FINAL do
`attempts:7` (transiente esgotado, `action='retry_exhausted'`) ou em poison
salvageável — via `updateStatus(..., 'dead_letter', meta)` com `Idempotency-Key`.
NÃO usar `sendComplete(strategy:'failed')` como sinal dead-letter (ele NÃO seta
`status='dead_letter'` e não acende a replay UI de staff). Logging é
`logger.error` = Pino level **50 (ERROR)**, não fatal. NÃO há fila dedicada
`bevox.harness.dead-letter` no harness — a dead-letter é o estado backend; a
retenção do `failed` set é só local; uma DLQ dedicada fica diferida a v2.
```

**`docs/architecture/evals.md:173`** ("No DLQ — evals are not incidents.") — manter para evals,
mas **não** é o caminho de dispatch; nenhuma mudança necessária além de garantir que não seja
lido como afirmação sobre o dispatch worker.

**`docs/architecture/fluxo-de-execucao.md:11` e `:310`** ("BullMQ possa tratar reprocessamento ou
DLQ" / "decidir sobre retry/DLQ") — substituir "DLQ" por: "retry via `attempts:7` do produtor
(LIVE); retry esgotado → `status='dead_letter'` no backend (sinal authoritativo, acende a replay
UI de staff) + retenção local no `failed` set (`removeOnFail.age`) para forense; sem fila DLQ
dedicada no harness".

## §5. Implementation plan

### Phase 1 — Poison vs transiente + J3 fail-loudly (~2.5h)

**Files:**
- `src/runtime/execution-handler.ts:566-573` — adicionar `UnprocessablePayloadError`
  (**`extends UnrecoverableError` de `bullmq`**, §4.1), `salvageIdToken` + `salvageSchema`;
  reescrever `parseExecutionPayload` com `safeParse` (oversize e Zod → `UnprocessablePayloadError`).
- `src/runtime/execution-handler.ts:830-841` — substituir o `return;` silencioso por **`throw err`**
  (sem emitir callback aqui; o sinal dead-letter de poison salvageável é emitido pelo
  `worker.on("failed")` listener, §4.3/§b, para não duplicar). O salvage de id/token vive no
  `UnprocessablePayloadError` e é lido pelo listener.
- `src/runtime/execution-handler.ts:1572-1651,1662-1698` — §4.2b: guardar passos pós-`/complete`
  (13b/13c/14) num `.catch()` não-relançante **e** um flag `completeSent` consultado pelo catch
  `:1662`; passar `Idempotency-Key` no `sendComplete` do boundary `:1674-1680`.

**Testes:**
- `tests/unit/runtime/execution-handler.payload.test.ts` — assert `parseExecutionPayload` lança
  `UnprocessablePayloadError` (que é `instanceof UnrecoverableError`) tanto para oversize quanto
  para Zod-inválido; assert `salvage` populado quando id+token válidos e `{}` quando ausentes/lixo.
- Novo `tests/unit/runtime/execution-handler.j3.test.ts` (ao lado de `execution-handler.flow.test.ts`)
  — mock `bevox-callback.sendComplete`; assert que `handleExecution` com payload poison **(a)** não
  retorna silenciosamente (relança), **(b)** chama `sendComplete(strategy:"failed")` **com
  `Idempotency-Key`** quando id+token salvageáveis, **(c)** NÃO chama `sendComplete` quando
  id/token são lixo, **(d)** após um `/complete` de sucesso, um throw em passo pós-complete
  **NÃO** dispara um segundo `sendComplete(failed)` (guard `completeSent`).

### Phase 2 — Worker retenção + failed listener + métrica + config (~2h)

**Files:**
- `src/config/env.ts:24` — `HARNESS_DISPATCH_FAILED_RETENTION_S` (apenas; **sem**
  `HARNESS_DISPATCH_ATTEMPTS` — `attempts` é producer-side, §1/§4.4).
- `src/config/harness-config.ts:17-21` — surfacing do env de retenção.
- `src/integration/bullmq-consumer.ts:17-43` — worker-default `removeOnFail`/`removeOnComplete`
  (**retenção local**) + `maxStalledCount: 1` (**sem** `attempts`/`backoff` — ignorados);
  `worker.on("failed", ...)` **async** que, na tentativa FINAL (`attemptsMade + 1 >= opts.attempts`)
  transiente OU poison salvageável, chama `updateStatus(..., 'dead_letter', meta)` com
  `Idempotency-Key` (§4.3/§a) + `recordDeadLetter({category})`. Imports novos: `updateStatus`,
  `MutationTool`, `ToolContext`. Poison é não-retryable pelo **tipo** (`UnrecoverableError`).
- `src/integration/bevox-callback.ts:116-123` — **estender `updateStatus` com 4º arg `meta?`**
  (`{ action, failedReason, attemptsMade, idempotencyKey }`); `idempotencyKey` vira header via
  `post`, o resto vai no body junto com `status`. Retrocompat: `meta` opcional (§a2).
- `src/observability/` — `recordDeadLetter({category})` (counter rotulado em
  `poison`/`retry_exhausted`/`aborted`/`transient_attempt`, §4.5/§e) + amostragem de
  `getFailedCount()` (gauge), gated por `OTEL_ENABLED` com fallback in-memory/log (§4.5).

**Testes:**
- `tests/unit/integration/bullmq-consumer.test.ts` — **estender o mock `vi.mock("bullmq")` para
  re-exportar `UnrecoverableError`** (classe real); o FakeWorker já captura `options`/`processor`/
  `on(...)` (`:6-19`); assert que o construtor recebe `removeOnFail`/`removeOnComplete`/
  `maxStalledCount` e **NÃO** `attempts`/`backoff`; dirigir o `processor` com um job poison →
  assert relança e que o erro é `instanceof UnrecoverableError`; assert `worker.on("failed", ...)`
  registrado e que `recordDeadLetter` é chamado.

### Phase 3 — Doc reconciliation + infra alignment (~1h)

**Files:**
- `.claude/rules/harness-payload.md:76-77` — reescrever (§4.7): level 50 ERROR + `failed` set
  retido + best-effort notify idempotente + sem `bevox.harness.dead-letter`.
- `docs/architecture/fluxo-de-execucao.md:11,310` — trocar "DLQ" por "retenção no `failed` set".
- `docs/architecture/evals.md:173` — revisar wording para não vazar para o dispatch.
- **Hub `infra/` manifest** — alinhar `terminationGracePeriodSeconds`/`stop_grace_period` ≥
  `HARNESS_MAX_EXECUTION_TIME_MS` + margem (§4.6, §8 open #8). Cross-repo; coordenar.
- `src/config/env.ts:23` — confirmar `HARNESS_MAX_EXECUTION_TIME_MS < 120000` (default **90000**
  na branch *op-execution-bounding*; este tree ainda mostra `120000`). Requerido p/ não cruzar a
  janela do cron `bevox.timeout.scan` (§4.6b).
- `src/runtime/execution-handler.ts` — emitir log estruturado **`execution.late_completion`**
  quando um job completa passado seu próprio deadline (§4.6b, sinal forense de possível
  handoff-humano paralelo).
- **Cross-repo (v2 best-fix):** backend carimba `dispatched_at` no payload de dispatch → harness
  deriva deadline ABSOLUTO alinhado ao relógio do backend (§4.6b). Mesma família de payload
  enrichment que `original_execution_id` (§d1).
- (Opcional) registrar DEBT-05 como **doc-fechado-para-pilot, Option C diferida a v2** via skill
  `bevox-knowledge-contribute`.

## §6. Testing strategy

### Unit (suíte default, sem infra)
- **`execution-handler.payload.test.ts`** (já cobre casos de throw em `:27-59,77-132`): estender
  para assert `instanceof UnprocessablePayloadError` em oversize e Zod-inválido; assert salvage
  populado/vazio.
- **`execution-handler.j3.test.ts`** (novo): mock `sendComplete`; assert relança (não return),
  notify só com salvage válido, e nenhum callback com token-lixo.
- **`bullmq-consumer.test.ts`**: o FakeWorker (`:6-19`) já expõe `options` e `listeners`. Estender
  o mock para re-exportar `UnrecoverableError`. Assert os options de retenção no construtor
  (`removeOnFail`/`removeOnComplete`/`maxStalledCount`) e **a ausência** de `attempts`/`backoff`;
  dirigir `processor` com job poison → assert relança um `UnrecoverableError`; assert
  `worker.on("failed", ...)` registrado e que `recordDeadLetter` dispara.

### Integration (`RUN_INTEGRATION=1` gated, `describe.skipIf(!RUN)`)
- `tests/integration/bullmq-consumer.integration.test.ts:8` e
  `execution-handler.integration.test.ts:9` já sobem `Queue`/`Worker` reais com IORedis via
  `setupInfra`/`integration-setup.ts`. Enfileirar um job malformado num test queue + worker reais e
  assert que o job aterrissa no `failed` set (`queue.getFailed()` / `getFailedCount()`) e **não**
  em `completed`; assert retenção (job permanece inspecionável). **Poison-não-retry:** enfileirar
  com `{ attempts: 3 }` no `queue.add` do teste (simulando o produtor) e assert que o job
  poison vai pro `failed` **sem** re-tentar (`attemptsMade === 1`) — prova que `UnrecoverableError`
  curto-circuita o retry.
- Falha transiente: só é re-tentada se o **produtor** setar `attempts` (consumer não pode). Test
  gated que enfileira com `{ attempts: 2 }` e um handler que falha transientemente uma vez →
  assert retry e eventual sucesso/retenção. **Documentar que sem attempts producer-side NÃO há
  retry** (status quo do orchestration-service — §8 open #1). Manter opt-in; CI default só unit.

### Regression
- Payload válido continua processando normalmente (sem regressão no happy path).
- Dedup (`SET NX` `:852-857`) e fix C12 (`:1691`) inalterados — parse-failure ocorre antes do
  `SET NX`, logo nenhuma interação nova com a dedup key.

## §7. Migration & rollback

**Ativação:**
1. **Phase 1** muda o comportamento de parse-failure de "silent completed" para "throw → failed".
   Observável ao backend/ops: jobs J3 passam a aparecer em `failed` em vez de sumir. **Coordenar
   com o orchestration-service** (ele agora pode ver `failed`/receber `/complete` de payloads que
   ele mesmo gerou malformados).
2. **Phase 2** adiciona **retenção local** (`removeOnFail.age: 24h`) + `maxStalledCount: 1` +
   o listener `failed` que escreve `status='dead_letter'` no backend na tentativa final
   (`attempts:7`, LIVE) + métrica. O retry **já está ligado** pelo produtor; esta fase faz o
   consumer ficar correto sob ele (dead-letter authoritativo + retenção). **Coordenar com o
   backend** o contrato de `updateStatus(...'dead_letter'...)` idempotente (§a2, §8 open #5/#9)
   ANTES de ativar, senão a escrita de status pode duplicar/corromper em redelivery.
   **⚠️ GATE DE ORDERING (§8 open #11):** esta fase NÃO pode ativar o `failed` listener antes de
   J8 (op-execution-bounding) estar merged em `main`, OU sem a classificação defensiva de abort
   por tipo no listener — caso contrário um wall-clock timeout em `main` (que ainda relança) é
   misclassificado como `retry_exhausted` e escreve `dead_letter` para um abort esperado.
3. **Phase 3** é doc + alinhamento de grace period no manifest (infra, cross-repo).

**Rollback:** cada fase é revertível sem perda de dados.
- Reverter Phase 2 volta o worker a sem retenção (status quo de infra); o `failed` set volta ao
  default de eviction do BullMQ.
- Reverter Phase 1 reintroduz o `return;` silencioso (não fazer — é o bug). Preferir, se preciso,
  desativar só a notificação best-effort (manter o throw) via guard.
- **Kill-switch de retenção:** `HARNESS_DISPATCH_FAILED_RETENTION_S` controla a janela; um valor
  baixo aproxima do comportamento antigo. **Não há kill-switch de retry consumer-side** porque
  não há retry consumer-side — desligar retry é uma mudança no `queue.add` do produtor.

## §8. Risks & open questions

### Risks
1. **Classificação poison-vs-transiente é load-bearing — e CRÍTICA com `attempts: 7` LIVE.**
   Como o produtor já seta `attempts: 7` (§8 open #1 ANSWERED), um poison **não marcado** entra
   em **retry-storm 7x** (parse falha garantidamente em todo retry) antes de morrer. A anti-loop é
   `UnprocessablePayloadError extends UnrecoverableError` (§4.1): o BullMQ curto-circuita o retry
   via `instanceof UnrecoverableError` (`job.js:483`), **sem** depender de `job.discard()` (que
   foi removido — deprecated + síncrono/`void`). Errar a classificação causa retry-storm 7x
   (poison não marcado) ou um transiente legítimo morto cedo demais. Cobrir com unit +
   integration test dedicado.
2. **Interação com dedup.** O fix C12 (`:1684-1696`) deleta `harness:dedup:{execution_id}` antes do
   rethrow no boundary em-execução para permitir reprocessar. J3 falha **antes** do `SET NX`
   (`:852-857`), então parse-failure retries não tocam a dedup key — o novo throw de parse é seguro.
   Qualquer novo caminho de retry **não** pode double-acquire nem strand a dedup key.
3. **Segurança: notificação só com token confiável.** O Zod exige `execution_id` uuid +
   `execution_token` 20–512 chars (`:517-518`). Para payloads oversize ou token malformado, **não
   há** id/token confiável → `salvageIdToken` retorna `{}` e **nenhum** callback é enviado.
   `X-Execution-Token` é o header de auth; enviar callback com token attacker-controlled/lixo seria
   uma falha de segurança. Esse comportamento é explícito em §4.1/§4.2.
4. **Retenção bounded ≠ DLQ durável; e a janela não é um TTL.** `removeOnFail.age` é bounded
   (default 24h) **e** a eviction é lazy (só roda quando outro job falha depois da expiração —
   `keep-jobs.d.ts`). Chamar isso de "DLQ" na doc re-introduziria o overclaim que o DEBT-05
   aponta. A doc (§4.7) descreve precisamente "`failed` set retido", não "DLQ". Operadores devem
   replay dentro da janela de retenção; aumentar `HARNESS_DISPATCH_FAILED_RETENTION_S` se a janela
   for curta demais — mas não confiar nela como garantia exata de tempo.
5. **Mudança observável ao backend/ops.** Jobs agora aparecem em `failed` (antes: silenciosamente
   `completed`). Coordenar expectativas com o orchestration-service e quaisquer dashboards de fila.
6. **`worker.on("error")` já existe (`:36-38`).** Adicionar `on("failed")` não pode duplicar log
   nem mascarar o erro original — `error` é para erros do worker em si; `failed` é por-job. São
   eventos distintos do BullMQ; sem overlap.
7. **Redis down ⇒ a retenção LOCAL some — mas a dead-letter authoritativa é HTTP, não Redis.**
   O `failed` set vive **no Redis** (retenção local / forense). Se o Redis estiver indisponível na
   hora do throw, o BullMQ **não consegue** mover o job pro `failed` set — o lock expira e o
   stalled-checker re-entrega quando o Redis voltar (limitado a `maxStalledCount: 1`). **Ponto-chave
   do pivô:** a dead-letter **authoritativa** (`status='dead_letter'` no backend, §a) é escrita
   por **HTTP** (`updateStatus`), **independente do Redis** — então mesmo num cenário Redis-down,
   se o listener `failed` chega a rodar, o estado authoritativo é gravado. O `failed` set retido
   é só o auxílio forense que se perde com o Redis. **Mitigação parcial:** o `worker.on("error")`
   loga a falha de Redis; o gauge de `failed_depth` para de amostrar (alerta de "scrape gap"
   detecta). Pior caso (Redis perdido + listener não roda): perde-se só a retenção local; a
   reconciliação do backend (cron `bevox.timeout.scan`, §4.6b) ainda escala via timeout. Aceito
   para o pilot; documentado para não dar falsa sensação de durabilidade da retenção local.
8. **Abort wall-clock/cost é TERMINAL (J8) — NUNCA dispara dead-letter — *MAS depende de J8
   estar MERGED***. Na branch *op-execution-bounding* (J8), o abort de wall-clock/cost **não
   relança** — emite `/complete aborted_timeout` e dá **ACK** no job (verificado: `ExecutionAbortError`
   com `retryable:false`, sem rethrow). Logo, **uma vez J8 landed**, o abort **nunca alcança o
   `worker.on("failed")`** e, por design, **NUNCA** pode disparar o sinal `status='dead_letter'`.
   **⚠️ CORREÇÃO ADVERSARIAL SRE (2026-06-03):** J8 **NÃO está merged em `main`** (verificado:
   `git branch --merged main` não inclui `op-execution-bounding`; `main` não tem `ExecutionAbortError`
   nem path de abort — `runWithTimeout` `:738-755` **apenas `reject`**, e o boundary `:1662-1698`
   faz `throw err`). Portanto **HOJE, em `main`, um wall-clock timeout RELANÇA e ALCANÇARIA o
   `failed` listener** — e na tentativa final do `attempts:7` seria classificado como
   `retry_exhausted` (`exhausted=true && poison=false`), **misclassificando um abort esperado como
   incidente** e escrevendo `status='dead_letter'` indevidamente. A exclusão de abort é portanto
   **condicional a J8 estar merged ANTES (ou junto com) este listener** — ver §8 open #11 (gate de
   ordering). **Invariante-alvo (pós-J8):** `aborted` ≠ `retry_exhausted` ≠ `poison` (§4.5 três
   categorias); o counter `category="aborted"` é alimentado pelo path de abort (J8), não pelo failed
   listener, e **não alerta**. (Resíduo de idempotência: `runWithTimeout` `:738-755` só rejeita a
   promise — a tool/LLM em-voo pode completar em background; com `attempts:7` LIVE, um retry duplica
   o side-effect a menos que a `Idempotency-Key` esteja threaded nas 5 mutation tools — §8 open #7 /
   §d1.)
9. **Double-`/complete` (§4.2b).** Sem o guard `completeSent` + `.catch()` nos passos
   pós-`/complete`, um hiccup de Redis em `sessionStore.update :1648` emite um segundo
   `sendComplete(failed)` após um `success`. **Com `attempts: 7` LIVE (§8 open #1 ANSWERED),
   runs re-executam de fato** — então este já é um bug de callback duplicado **ativo**, não mais
   latente. Idempotency-Key no boundary + last-write-wins no backend é a rede de segurança.
10. **Staff manual replay (redispatch) fura a idempotency execution_id-derivada → mutações de
    appointment DUPLICADAS.** Quando o staff dá replay numa execução dead-lettered, o
    orchestration-service minta um **NOVO `execution_id`**. A `Idempotency-Key` é derivada de
    `execution_id` (`deriveIdempotencyKey` = `harness:${execution_id}:${step}:${name}`,
    `mutation-tool.ts:112-130`) → o replay **NÃO** deduplica contra a execução original →
    `create/cancel/reschedule/waitlist-add` re-executam contra o backend/calendário, **duplicando
    o efeito externo** (compromisso criado duas vezes etc).
    - O **replied-marker** (`src/sdr/replied-marker.ts`, usado em `execution-handler.ts:353-361`
      no path Model-C) cobre `send-message` **cross-execution-id** (keyed em
      `(organizationId, contactKey, msgHash)`, sobrevive a `execution_id`s novos) — mas é
      **content-keyed só para a resposta/reply**. As **mutações de appointment NÃO têm
      idempotência content-keyed** — nada as protege num replay com `execution_id` novo.
    - **Fix (cross-ref):** um campo de **lineage no payload** — `original_execution_id` — + derivar
      a key de `original_execution_id ?? execution_id`. Isso ancora a `Idempotency-Key` à execução
      *original*, fazendo o replay deduplicar. Threading completo está na spec de
      **idempotency-key-full-threading (PR #59)**. **GATE:** o **replay de mutações de appointment
      deve ficar BLOQUEADO** até esse lineage threading landar — senão o staff replay troca
      "perda silenciosa" por "duplicação silenciosa de compromissos". (Replay de execuções
      send-message-only é seguro hoje via replied-marker.)
11. **Ownership cross-spec (evitar dupla-escrita e conflação).** Três specs tocam o destino
    terminal de um job; cada uma é dona de **exatamente uma** categoria:
    - **J8 (op-execution-bounding)** é dona dos **aborts** (wall-clock/cost): terminal, ACK,
      `/complete`, `category="aborted"`. **Nunca** retry, **nunca** dead-letter.
    - **Esta spec (dead-letter)** é dona da **transient-exhaustion**: tentativa final do
      `attempts:7` falha transiente → `status='dead_letter'` + `action='retry_exhausted'`.
    - **J3 (poison)** é dona do **poison**: `UnrecoverableError` morre na tentativa 1; **opcional**
      `status='dead_letter'` (§b) para visibilidade no replay UI. Sem retry-storm.
    Conflar qualquer par (ex. um alerta que soma `aborted` + `retry_exhausted`, ou um path que
    escreve dead-letter para um abort) é bug.

### Open questions
1. **~~O produtor seta `attempts`/`backoff`?~~ ANSWERED (2026-06-03).** O orchestration-service
   enfileira com **`attempts: 7`**, **exponential backoff** (janela total ~635s), queue
   **`bevox.execution.dispatch`**, **`jobId = execution_id`**. **Retry está LIVE.** Consequências
   de design (não mais hipotéticas — **REQUERIDAS para correção agora**):
   - O **guard de double-`/complete`** (§4.2b) deixa de ser pré-condição teórica: com `attempts:7`
     LIVE, runs re-executam de fato; sem o guard `completeSent` + `.catch()` nos passos
     pós-`/complete`, o backend recebe `failed` depois `success` (ou dois `/complete`) para o mesmo
     `execution_id`. **Obrigatório, não opcional.**
   - O **threading da `Idempotency-Key`** (boundary `:1674-1680` + as 5 mutation tools) idem:
     com retry real, side-effects das mutation tools **duplicam** sem a key. **Pré-requisito de
     correção agora**, não "antes de habilitar retry" — o retry já está habilitado.
   - O `UnrecoverableError` (§4.1) protege poison contra retry-storm 7x — **crítico** agora.
   - A dead-letter authoritativa (`status='dead_letter'`) é escrita na **tentativa final** do
     `attempts:7` (§4.3, §a). **Verificar o nome exato da queue/digest no manifest do hub.**
2. **Endpoint dedicado de dead-letter no backend?** A recomendação primária (§a2) estende
   `updateStatus` → `POST /status` com `{ status:'dead_letter', action:'retry_exhausted', ... }`.
   A alternativa (`sendDeadLetter` → `POST /executions/{id}/dead-letter`) fica **pendente
   confirmação de que o backend expõe tal endpoint**. Confirmar com o backend se prefere o
   campo `status` em `/status` (assumido) ou um endpoint próprio. Para payloads oversize/token-lixo
   sem `execution_id`/`execution_token` confiáveis, **não há** sinal possível (só retenção local
   + log) — confirmar se o backend quer um canal no-auth-context (provavelmente não para o pilot).
3. **DEBT-05 fecha como doc-only (Option A embutida na B) para o pilot, com a DLQ real (Option C)
   diferida a v2 — ou uma fila `bevox.harness.dead-letter` é blocker de pilot?** Recomendação:
   diferir C; o `failed` set retido cobre inspeção/replay sem novo subsistema. **Founder decide.**
4. **~~Versão do `bullmq`: `job.discard()` disponível?~~ RESOLVIDO.** Verificado contra
   `bullmq@5.76.9`: `Job.discard()` existe mas é **`@deprecated` e síncrono `void`** (`job.js:973`)
   — o `await ...catch()` original lançaria `TypeError`. **Substituído** por
   `UnprocessablePayloadError extends UnrecoverableError` (honrado em `job.js:483`). Não é mais
   bloqueante. (Mantido na lista só como registro da correção.)
5. **Contrato de `/complete` duplicado com o backend (§4.2b/§8 risk 9).** O backend trata
   `/complete` como **idempotente/last-write-wins por `execution_id`** quando recebe a mesma
   `Idempotency-Key`? Ou um segundo `/complete` (failed após success, ou de um retry) corrompe o
   estado? **Bloqueante de correção AGORA** (retry `attempts:7` já LIVE — runs re-executam de
   fato); verificar com o backend antes de Phase 1/2. Inclui o contrato de
   `updateStatus(...'dead_letter'...)` idempotente por `Idempotency-Key` (§a2).
6. **Thresholds concretos de alerta/SLO (§4.5).** Qual a taxa de
   `dead_letter_total{category="retry_exhausted"}` que dispara warning vs critical? Qual
   `failed_depth` indica backlog acionável? E qual o objetivo de SLI (ex. ≥ 99.9% de jobs em
   `completed` sobre 30d)? **Founder/ops define o orçamento de erro.**
7. **Threading completo da `Idempotency-Key` nas 5 mutation tools (CRIT #10).** Hoje só
   `create-appointment` propaga a key. Retry/abort/redelivery duplica side-effects nas outras 4
   (`cancel`/`reschedule`/`send-message`/`waitlist-add`). **Correção de segurança AGORA** (não
   "antes de habilitar retry" — o retry `attempts:7` já está LIVE) — sem isso o retry já troca
   perda silenciosa por **duplicação** silenciosa. Coordenar com a spec idempotency-key-full-
   threading (PR #59); ver também §d1 (replay com `execution_id` novo exige
   `original_execution_id` na derivação da key).
8. **Grace period de shutdown (§4.6).** Qual o `terminationGracePeriodSeconds`/`stop_grace_period`
   atual no manifest do hub? Se < `HARNESS_MAX_EXECUTION_TIME_MS` (default agora **90000** na
   branch op-execution-bounding; este tree mostra `120000`), jobs longos são SIGKILLed mid-flight
   → redelivery (+ duplicação se a idempotency-key não estiver threaded). **Verificar/alinhar no
   hub `infra/` — cross-repo.**
9. **Endpoint dedicado de dead-letter no backend (§a2).** O backend prefere o sinal via
   `updateStatus → POST /status` com `{status:'dead_letter', action, ...}` (recomendação primária)
   ou um endpoint dedicado `POST /executions/{id}/dead-letter` (`sendDeadLetter`)? **Confirmar
   com o backend** — define se §a2 fica em `updateStatus` estendido ou em função nova.
10. **`dispatched_at` no payload de dispatch (§4.6b best-fix).** O backend pode carimbar
    `dispatched_at` para o harness derivar um deadline absoluto alinhado ao cron `bevox.timeout.scan`?
    Mesma família de payload enrichment que `original_execution_id` (§d1). **Cross-repo, v2.**
11. **GATE DE ORDERING — o `failed` listener (esta spec) NÃO pode landar ANTES de J8
    (op-execution-bounding).** *(aberto pela revisão adversarial SRE 2026-06-03.)* A exclusão de
    abort do `retry_exhausted` (§8 risk 8) só vale quando o abort de wall-clock/cost dá **ACK** sem
    rethrow — comportamento que vive **apenas na branch `op-execution-bounding`, AINDA NÃO merged em
    `main`** (verificado: `git branch --merged main` não a inclui; `main` ainda relança o timeout via
    `runWithTimeout :738-755` → boundary `:1662-1698` `throw err`). **Consequência:** se este listener
    landar primeiro, todo wall-clock timeout em `main` relança, alcança o `failed` listener e, na
    tentativa final do `attempts:7`, é classificado como `retry_exhausted` → escreve
    `status='dead_letter'` para o que é um abort esperado (falso incidente + ruído de alerta +
    possível conflito de double-handling com o handoff-humano do cron `bevox.timeout.scan`, §4.6b).
    **Decisão requerida (founder/eng):** (a) **merge-gate** — landar J8 antes (ou no mesmo PR) deste
    listener; OU (b) **defensive-classify** — o §4.3 listener detecta o erro de abort por **tipo**
    (`err instanceof ExecutionAbortError` / `err.name === "ExecutionAbortError"`, mesmo padrão de
    detecção por nome que o BullMQ usa em `job.js:483`) e o trata como `category="aborted"` (NÃO
    `retry_exhausted`, NÃO escreve `dead_letter`) — o que torna esta spec robusta independente da
    ordem de merge. **Recomendação:** (b) como defesa-em-profundidade + (a) como ordem preferida; sem
    uma das duas, há regressão de classificação ativa no instante do merge. Atualizar o DoD da Phase 2
    com este gate.

## §9. Definition of done

- [ ] **Phase 1:**
  - [ ] `UnprocessablePayloadError extends UnrecoverableError` + `salvageIdToken` adicionados;
        `parseExecutionPayload` lança o erro tipado em oversize **e** Zod-inválido (`:566-573`)
  - [ ] J3 (`:830-841`) relança (sem `return` silencioso); o sinal dead-letter de poison
        salvageável é emitido pelo `worker.on("failed")` listener (§b), não aqui
  - [ ] Guard `completeSent` + `.catch()` nos passos pós-`/complete` (§4.2b) + `Idempotency-Key`
        no `sendComplete` do boundary `:1674-1680`
  - [ ] Unit: `payload.test.ts` estendido + `execution-handler.j3.test.ts` (inclui caso de
        não-double-complete) verdes
- [ ] **Phase 2:**
  - [ ] `HARNESS_DISPATCH_FAILED_RETENTION_S` em `env.ts` + `harness-config.ts` (**sem**
        `HARNESS_DISPATCH_ATTEMPTS` — producer-side)
  - [ ] Worker-defaults de **retenção local** (`removeOnFail`/`removeOnComplete`) +
        `maxStalledCount: 1` (**sem** `attempts`/`backoff`) + `worker.on("failed", ...)` **async**
        em `bullmq-consumer.ts`
  - [ ] Listener escreve `status='dead_letter'` (via `updateStatus` + `meta` + `Idempotency-Key`)
        na tentativa FINAL transiente (`attemptsMade + 1 >= opts.attempts`) **e** em poison
        salvageável (§a/§b); **NUNCA** para abort (§e)
  - [ ] **GATE DE ORDERING (§8 open #11):** ou J8 (op-execution-bounding) está merged ANTES deste
        listener, OU o listener classifica defensivamente abort por tipo
        (`ExecutionAbortError`/`err.name`) como `category="aborted"` (não `retry_exhausted`, não
        escreve `dead_letter`). Sem uma das duas, abort de wall-clock em `main` é misclassificado.
        Unit: timeout/abort error → NÃO escreve `dead_letter`, NÃO conta `retry_exhausted`.
  - [ ] `updateStatus` estendido com 4º arg `meta?` em `bevox-callback.ts:116-123` (§a2)
  - [ ] Métrica counter `dead_letter_total{category}` (3 categorias `poison`/`retry_exhausted`/
        `aborted` + `transient_attempt`, §4.5/§e) + gauge `failed_depth` wired
  - [ ] Mock `vi.mock("bullmq")` estendido p/ re-exportar `UnrecoverableError`
  - [ ] Unit `bullmq-consumer.test.ts` assert options de retenção (e ausência de attempts/backoff)
        + processor relança `UnrecoverableError` + failed listener + `recordDeadLetter`
  - [ ] (Opcional/gated) integration: job malformado aterrissa em `failed`, não `completed`;
        poison com `{attempts:3}` no produtor de teste NÃO re-tenta (`attemptsMade===1`)
- [ ] **Phase 3:**
  - [ ] `.claude/rules/harness-payload.md:76-77` corrigido (level 50 ERROR; `failed` set retido;
        sem `bevox.harness.dead-letter`)
  - [ ] `docs/architecture/fluxo-de-execucao.md:11,310` + `evals.md:173` reconciliados
  - [ ] Grace period alinhado no manifest do hub (§4.6, §8 open #8)
  - [ ] `HARNESS_MAX_EXECUTION_TIME_MS < 120000` (default 90000) confirmado (§4.6b)
  - [ ] Log `execution.late_completion` emitido quando job completa pós-deadline (§4.6b)
- [ ] **Retry está LIVE (`attempts:7`, §8 open #1 ANSWERED):** #5 (contrato double-complete /
      last-write-wins no backend) + #7 (idempotency threading nas 5 mutation tools) são
      **bloqueantes de correção AGORA**, não "antes de habilitar retry"
- [ ] **Replay de mutações de appointment GATED** até o lineage `original_execution_id` landar
      (PR #59, §d1); replay send-message-only liberado via replied-marker
- [ ] Best-fix `dispatched_at` → deadline absoluto coordenado cross-repo (§4.6b, v2)
- [ ] Alertas/SLO (§4.5) com thresholds definidos (#6); `aborted` NÃO conflado com
      `retry_exhausted` (§e); dashboards de `failed_depth`
- [ ] Audit findings **J3** e **DEBT-05** validados como closed
- [ ] Sem regressões (unit + integration gated); code review aprovado

## §10. References

- **Audit findings:** J3 + DEBT-05, `docs/audits/runtime-gap-audit-2026-06-02.md:283`
  (única menção literal a `bevox.harness.dead-letter` — só no audit, não em src/rule)
- **Worker de dispatch (alvo principal):** `src/integration/bullmq-consumer.ts:17-43` (sem
  retenção worker-side, sem `failed` listener; `worker.on("error")` em `:36-38`; comentário
  "BullMQ will retry according to job options" em `:28` — o retry **é real** porque o PRODUTOR
  seta `attempts: 7` no `queue.add` da queue `bevox.execution.dispatch`, §8 open #1 ANSWERED)
- **Producer contract (confirmado 2026-06-03):** `attempts: 7`, exponential backoff ~635s,
  queue `bevox.execution.dispatch`, `jobId = execution_id` (orchestration-service, cross-repo)
- **Backend reconciliation:** cron `bevox.timeout.scan` (2 min) → `status='timeout'` quando
  `dispatched_at + 120000ms < now()` → human handoff (cross-repo; §4.6b)
- **Dead-letter authoritativa:** `status='dead_letter'` na execução, no backend; replay UI de
  staff-ops keyed nesse status (built-and-waiting, unwritten — esta spec a escreve, §a)
- **BullMQ API (verificado em `bullmq@5.76.9`):**
  `node_modules/bullmq/dist/esm/interfaces/worker-options.d.ts` (`WorkerOptions` aceita
  `removeOnComplete`/`removeOnFail`/`maxStalledCount`/`maxStartedAttempts`; **NÃO** `attempts`/
  `backoff`); `interfaces/base-job-options.d.ts:29,33` (`attempts`/`backoff` são job-options);
  `classes/job.js:481-483` (retry só se `!(err instanceof UnrecoverableError)`); `job.js:969-975`
  (`discard()` `@deprecated`, síncrono `void`); `classes/errors/unrecoverable-error.js`
  (`UnrecoverableError` exportado da raiz `bullmq`); `types/keep-jobs.d.ts` (eviction lazy)
- **Shutdown/drain:** `src/bootstrap/shutdown.ts:19-71` (SIGTERM/SIGINT → `stopConsumer`);
  `src/integration/bullmq-consumer.ts:45-51` (`stopConsumer` → `worker.close()` sem timeout)
- **Timeout (não-abortante):** `src/runtime/execution-handler.ts:738-755` (`runWithTimeout`
  rejeita a promise mas não aborta o trabalho subjacente); wrap do surface loop `:1529-1540`
- **Idempotency-Key:** `src/tools/_shared/mutation-tool.ts:112-130`
  (`deriveIdempotencyKey` = `harness:${execution_id}:${step}:${name}`);
  `src/integration/bevox-callback.ts:15-38,125-133` (`sendComplete` aceita `idempotencyKey`,
  hoje NÃO passado pelo handler em `:1674-1680`)
- **Double-complete:** sucesso `sendComplete` em `:1572-1584`; passos pós-complete 13b/13c/14
  (`:1590,:1604-1645,:1648-1651`, este último sem `.catch()`); boundary catch `:1662`
- **Site J3 (descarte silencioso):** `src/runtime/execution-handler.ts:830-841` (`return;` em
  `:840`); `parseExecutionPayload` em `:566-573`; `executionPayloadSchema` em `:515-558`
  (`execution_id` uuid `:517`, `execution_token` 20–512 `:518`, `.passthrough()` `:558`)
- **Boundary em-execução (notifica backend — inalcançável p/ J3):**
  `src/runtime/execution-handler.ts:1662-1698` (`sendComplete(strategy:"failed")` `:1674-1680`;
  dedup del fix C12 `:1691`); dedup `SET NX` em `:852-857`
- **Cliente de callback:** `src/integration/bevox-callback.ts:7` (`BASE_URL`), `:15-38` (`post` +
  `X-Execution-Token` + header opcional `Idempotency-Key` `:26`), `:116-123` (`updateStatus` →
  `/status`; **a estender com 4º arg `meta` p/ o sinal dead-letter**, §a2), `:125-133`
  (`sendComplete` → `/complete`; **NÃO** usar como sinal dead-letter, §a)
- **Replied-marker (cross-execution-id idempotency, só reply):** `src/sdr/replied-marker.ts`
  (keyed `(organizationId, contactKey, msgHash)`), usado em `execution-handler.ts:353-361`
  (path Model-C). Cobre `send-message`; **NÃO** cobre mutações de appointment (§d1)
- **Idempotency lineage (fix do replay duplicado):** spec idempotency-key-full-threading
  (PR #59) — `original_execution_id` no payload + `deriveIdempotencyKey` ancorada nele (§d1)
- **Precedentes idiomáticos (job-options no PRODUTOR + failed listener):**
  - `src/integration/condense-queue.ts:43-49` — `attempts:3`/`backoff` setados em **`queue.add`**
    (produtor), NÃO no Worker; `removeOnComplete:true`/`removeOnFail:{age:3600}`
  - `src/evals/eval-queue.ts:33-37` — idem em `queue.add`; `attempts:2`/`backoff exponential 5s`/
    `removeOnComplete:1000`/`removeOnFail:100`
  - `src/workers/condense-worker.ts:64` e `src/evals/eval-worker.ts:71` (`worker.on("failed", ...)`)
- **Config:** `src/config/env.ts:24` (`HARNESS_QUEUE_NAME`); `src/config/harness-config.ts:17-21`
  (bloco `harness`)
- **Docs a reconciliar:** `.claude/rules/harness-payload.md:76-77`;
  `docs/architecture/evals.md:173` ("No DLQ"); `docs/architecture/fluxo-de-execucao.md:11,310`
- **Testes:** `tests/unit/integration/bullmq-consumer.test.ts:6-19` (FakeWorker mock com
  `options`/`processor`/`on`); `tests/unit/runtime/execution-handler.payload.test.ts`;
  `tests/integration/bullmq-consumer.integration.test.ts:8`;
  `tests/integration/execution-handler.integration.test.ts:9`
- **Diferido a v2 (Option C):** fila dedicada `bevox.harness.dead-letter` + produtor +
  consumer/replayer + `HARNESS_DLQ_QUEUE_NAME`

## §11. Plan execution gates (recorded by the implementation plan, 2026-06-03)

The implementation plan ships consumer-side: J3 fail-loudly, the authoritative
`status='dead_letter'` signal (extended `updateStatus(meta)`), local `failed`-set
retention, the 3-category counter, and the defensive abort exclusion. It does NOT
close these dependencies (outside this spec's edit surface):

- **§8 open #5 — backend `/complete` last-write-wins contract.** With `attempts:7`
  LIVE, the boundary `/complete(failed)` + a retry's `/complete(success)` collide on
  `execution_id`. The boundary callback now carries an `Idempotency-Key`; the backend
  MUST treat `/complete` (and `updateStatus(...'dead_letter'...)`) as idempotent /
  last-write-wins per `execution_id`. **Blocking-now; cross-repo (backend).**
- **§8 open #7 — Idempotency-Key threading across all 5 mutation tools.** Only
  `create-appointment` threads a key today; the other 4 duplicate side-effects on
  retry/redelivery. **Blocking-now; owned by the mutation-tool-rollout-idempotency
  plan + PR #59.**
- **§8 open #11 / risk 8 — J8 (op-execution-bounding) merge order.** The plan
  implements the defensive abort classify (`err.name === "ExecutionAbortError"` →
  `category="aborted"`, never `dead_letter`) so the listener is correct regardless of
  merge order. Preferred belt: land J8 before (or with) this listener. Until J8 is
  merged on `main`, the name-based classify is the only protection — keep it.
- **§8 open #8 — `terminationGracePeriodSeconds` ≥ `HARNESS_MAX_EXECUTION_TIME_MS`.**
  Align the hub `infra/` manifest grace period so long jobs are not SIGKILLed
  mid-flight (→ redelivery + duplication without key threading). **Cross-repo (hub).**
  NB: `env.ts:23` shows `HARNESS_MAX_EXECUTION_TIME_MS = 120000` on this tree; the
  op-execution-bounding branch lowers it to `90000` (< the backend `bevox.timeout.scan`
  120s window, §4.6b) — confirm the lower value lands.
- **§8 risk 10 / §d1 — replay dedup.** Staff replay mints a NEW `execution_id`, so
  appointment-mutation idempotency keys do NOT dedup on replay. **GATE: replay of
  appointment mutations stays BLOCKED until the `original_execution_id` lineage lands
  (PR #59).** Send-message replay is safe today via the content-keyed replied-marker.
- **§8 open #6 — concrete alert thresholds / SLI.** Founder/ops own the
  `retry_exhausted` rate (warning vs critical) and `failed_depth` backlog threshold;
  `aborted` MUST NOT be conflated with `retry_exhausted`. **Founder/ops decision.**
- **§8 open #2 / #9 (near-duplicate) — dedicated dead-letter endpoint?** The plan
  extends `/status` (`updateStatus(meta)`). If the backend prefers a dedicated
  `POST /executions/{id}/dead-letter`, swap to a `sendDeadLetter(...)` later. **Backend
  confirmation pending.**
- **§4.6b best-fix — `dispatched_at` absolute deadline.** v2; cross-repo (backend
  stamps the payload); same payload-enrichment family as `original_execution_id`.
