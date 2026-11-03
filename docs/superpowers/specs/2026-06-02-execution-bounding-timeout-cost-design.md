# Execution Bounding — Wall-Clock Timeout + Cost-Ceiling Abort (J8 / J9) — Design

> **Spec ID:** `2026-06-02-execution-bounding-timeout-cost-design`
> **Status:** Draft — pendente review pelo founder. **Backend-coupling addendum APPROVED:** o
> contrato `deadline_ms` absoluto (read-side no harness) foi emendado e aprovado pelo founder via
> canon bevox-knowledge #62 (harness-proposal) + #63 (backend-edits) — PROPOSED→approved. LANDED
> read-side (ver §4.10 Backend coupling).
> **Autor:** Claude (Opus 4.8) — Backend Architect, 2026-06-02. Grounded em research já verificado contra o código (runtime-gap-audit-2026-06-02.md J8/J9).
> **Escopo:** bevox-harness runtime-gap findings **J8** (sem timeout global de wall-clock; `synthesize` final sem timeout; trabalho órfão continua após timeout de fase — sem AbortController) + **J9** (sem teto de `max_cost_usd`; cost-calculator mede mas não corta).
> **Estimate:** ~5–7h (3 phases)
> **Issue:** bernardTavares/bevox-harness#TBD (criar — runtime-gap J8/J9)

> **⚠️ Nota de escopo.** Esta spec **limita uma única execução** no `execution-handler`.
> NÃO toca o LLM robustness layer (retry/circuit-breaker/credential-pool) que a auditoria
> confirma correto (J7/DEBT-04 CANON-STALE). A abordagem recomendada (Option A) é
> **cooperativa** — checa deadline e custo entre steps e em volta de `synthesize` — e
> reaproveita o padrão *accumulator-by-reference* já provado pelo `usageAccumulator`
> (`execution-context.ts:124`, set em `execution-handler.ts:992`). O cancelamento real
> mid-call (Option B, `AbortSignal` threaded ponta-a-ponta) fica documentado como follow-on,
> não warranted para o piloto: os adapters já self-cap cada chamada LLM em 30s
> (`LLM_REQUEST_TIMEOUT_MS`, `env.ts:40`), o que limita o pior caso de trabalho órfão.

## §1. Context

`handleExecution` (`execution-handler.ts:830`) é o boundary de uma execução. Os únicos
timeouts hoje são **por fase e não-cancelantes**, fatiados de
`config.harness.maxExecutionTimeMs` (`HARNESS_MAX_EXECUTION_TIME_MS`, `env.ts` → `harness-config.ts`)
via `runWithTimeout(...)`. **O default foi baixado de 120000 pra `90000`** nesta entrega, pra
ficar abaixo do timeout-scan de 120s do backend (ver Backend coupling em §4.10):

- MessageAnalyzer — 25% do budget (fase pipeline).
- MemoryExtractor — 25% do budget (non-fatal).
- Surface loop — 50% do budget (`execution-handler.ts:1529-1540`).

`runWithTimeout` (`execution-handler.ts:738-755`) é um **wrapper de Promise puro**:

```typescript
function runWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${label} exceeded ${ms}ms`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
```

No timeout ele faz `reject(new Error("Timeout: ..."))` mas **NÃO cancela** a promise
envolvida — `runSurfaceAgentLoop` (`:637-732`) e qualquer `fetch` LLM in-flight continuam
**órfãos**, consumindo o worker depois do job já declarado falho.

A rejeição cai no `catch` boundary: loga, faz best-effort `sendComplete(...)`, e — no estado
**original** (pré-J8) — deletava a dedup key e **re-lançava incondicionalmente** pro BullMQ. Esse
rethrow incondicional **é o bug J8** sendo corrigido: o producer (bevox-backend) enfileira com
`attempts:7` + backoff exponencial (~635s), então re-lançar um abort de wall-clock/custo fazia o
BullMQ **replay 7× uma execução condenada**, mesmo o backend já tendo reconciliado o desfecho
(timeout-scan em `dispatched_at+120000ms` → human handoff). O fix (§4.10): abort vira **terminal**
— emite `/complete` e **ACK (return)**, NÃO rethrow; só erros não-abort transientes re-lançam.

Um **wall-clock start** já é ancorado em `devStartTs = Date.now()` (`:866`), mas **nunca é
comparado** contra um budget. E `p-timeout@^6.1.4` é dependência (`package.json:73`) porém o
handler **não** o importa — rola o próprio `runWithTimeout` não-cancelante.

Para **custo**: a infra existe mas não é enforçada. `calculateCostCents` (`cost-calculator.ts:38`)
computa custo em centavos por modelo. O hot path usa um token-counter nu:
`usageAccumulator = { promptTokens, completionTokens }` (`:910`), mutado por um callback
`onUsage` (`:914-916`) injetado via `UsageDecorator` (`usage-decorator.ts:31-50`). Esse callback
**já recebe** `meta: { model, provider, latencyMs }` (assinatura `UsageCallback`,
`usage-decorator.ts:27-29`) — mas a implementação atual em `:914` **só soma tokens** e ignora
o `meta`. `UsageTracker` (`usage-tracker.ts`) existe mas **nunca é instanciado** em `src/`.

O `usageAccumulator` é threaded para `AgentExecutionContext.usageAccumulator`
(`execution-context.ts:124`, set em `:992`) — logo é **legível de dentro do surface loop**, o
que é exatamente o hook que J9 precisa.

## §2. Problem statement

**J8 — Sem deadline global de wall-clock e sem cancelamento de trabalho órfão.**

1. Não há orçamento de wall-clock para a **execução inteira**. As três fases somam ≈100% do
   budget, mas como `runWithTimeout` não cancela, um timeout de fase **deixa a promise rodando**
   — o worker continua queimando CPU + gasto LLM depois que o job já é `failed`.
2. **CRÍTICO:** o `engine.synthesize(...)` terminal (`execution-handler.ts:1546-1557`,
   chamada em `:1553`) está **FORA de qualquer `runWithTimeout`** — fica DEPOIS do
   surface-loop wrapper. Um `synthesize` que trava **pendura o job inteiro sem limite**.
3. Nenhum `AbortController`/`AbortSignal` existe no caminho de execução. `LLMRequestOptions`
   (`llm-gateway.ts:60-77`) **não tem** campo `signal`; os adapters só impõem
   `AbortSignal.timeout(this.timeoutMs)` internamente
   (`adapters/openai.adapter.ts:114`, `adapters/gemini.adapter.ts:126`,
   `adapters/anthropic.adapter.ts:124`, default 30s) — callers **não podem injetar** cancelamento.

Audit (`runtime-gap-audit-2026-06-02.md:274-276`): *"sem timeout global de wall-clock;
synthesize final sem timeout; trabalho órfão continua após timeout de fase — sem AbortController"*.

**J9 — Sem teto de `max_cost_usd` com abort.**

Custo é **computável** (`cost-calculator.ts` + o `meta` model/provider já fluindo no callback
`onUsage` em `:914`) mas o custo corrente **nunca é acumulado, nunca comparado a um teto, e não
há caminho de abort**. O step loop `while (await engine.shouldContinue(...))` (`:657-729`) — o
gate natural por-step — não faz checagem de custo nem de deadline entre steps. O payload
`executionPayloadSchema` (`:515-558`) **não carrega** `max_cost_usd` e `env.ts` não tem knob de
teto. Audit (`:276`): *"cost-calculator mede mas não corta"*.

**Invariantes que o fix NÃO pode violar:**
- **Não double-`/complete`:** o sucesso e o erro-boundary são mutuamente exclusivos por `throw`.
  Um abort deve **lançar** (cair no `catch`) e deixar o boundary emitir o `/complete` terminal —
  nunca emitir um `/complete` próprio antes de lançar. O `catch` é o **único** emissor terminal.
- **Abort é desfecho TERMINAL — ACK (return), NÃO rethrow.** Depois que o boundary emite o
  `/complete` de abort, o job é **reconhecido (ACK) com `return`**, NÃO re-lançado pro BullMQ.
  Rationale: o producer (bevox-backend) enfileira o dispatch com **`attempts:7` + backoff
  exponencial (~635s total)**; rethrow faria o BullMQ **replay 7× uma execução condenada** (que
  vai re-abortar deterministicamente, ou re-estourar o mesmo wall-clock), enquanto o backend **já
  reconciliou** o desfecho (timeout-scan em `dispatched_at+120000ms` → human handoff aos 120s).
  Um abort é o resultado terminal correto reportado via `/complete` — não algo que o BullMQ deva
  re-tentar. Apenas erros **genuinamente transientes** (não-abort: ex. backend unreachable)
  re-lançam pra deixar o `attempts:7` do producer aplicar. Ver §4.10.
- **Fechar o audit trail:** o `catch` já faz `sessionStore.update(status:"failed")`, emite
  `execution.completed` no devBus, e (no caminho não-abort) limpa a dedup key. O abort deve passar
  por esse mesmo boundary, não por um atalho.
- **Idempotency respeitada:** o `/complete` terminal de erro hoje **não** passa `idempotencyKey`
  (`:1677`); a spec de idempotência (`2026-06-02-idempotency-key-full-threading-design.md` §4.4)
  endereça isso por desfecho. Aqui apenas garantimos que o abort use o mesmo único call-site de
  erro — sem novo `/complete` paralelo que duplicaria.
  - **⚠️ Colisão cross-spec (coordenar antes de landar):** a spec de idempotência deriva a chave
    do `/complete` **por desfecho** (tabela de `kind` em seu §4.4: `success`/`failed`/...). Esta
    spec introduz **dois novos desfechos** (`aborted_cost`/`aborted_timeout`). Se a tabela de
    `kind` daquela spec não ganhar entradas correspondentes, os aborts ou (a) caem no `kind`
    `failed` genérico — aceitável **se** for o mesmo desfecho semântico no retry — ou (b) derivam
    uma chave que colide com um `/complete` `failed` anterior do mesmo `execution_id`, causando o
    backend a dedup-dropar um terminal legítimo. **Decisão:** ou os dois `aborted_*` mapeiam pro
    `kind` `failed` na tabela de idempotência (1 chave por execução-falha, simples), ou ganham
    `kind`s próprios. Recomendação: **mapear pra `failed`** no piloto (abort *é* uma falha pro
    contrato de idempotência; o `strategy` distinto é só telemetria). Anotar na spec irmã.

## §3. Goals & non-goals

**Goals:**
- **J8-a:** Deadline absoluto de wall-clock para a execução inteira, derivado de
  `devStartTs + maxExecutionTimeMs`, checado cooperativamente no step loop e em volta de
  `synthesize`.
- **J8-b:** Envolver `engine.synthesize` (`:1553`) num `runWithTimeout` (fecha o buraco do
  synthesize não-bounded).
- **J8-c:** Endurecer `runWithTimeout` para disparar um `AbortController.abort()` no timeout
  (cancela trabalho cooperativo; não exige tocar adapters).
- **J9-a:** Acumular custo corrente via `calculateCostCents` usando o `meta` já disponível no
  `onUsage` callback (`:914`).
- **J9-b:** Abortar quando o custo acumulado cruza um teto `max_cost_usd`, sourced do payload
  (override por-execução) **ou** de um default `HARNESS_MAX_COST_USD` no env.
- **Tipagem:** ambos os aborts lançam um `ExecutionAbortError` tipado (com `reason`) que o
  `catch` boundary existente (`:1662`) já trata — sem novo caminho de erro.
- Testes unit determinísticos (tier unit, não integration — CI roda contra postgres puro).

**Non-goals:**
- **NÃO** threadar `AbortSignal` ponta-a-ponta pelo `LLMRequestOptions`/adapters/decorators
  (Option B) — fica como follow-on documentado.
- **NÃO** re-fatiar o budget por fase. O deadline global usa o budget **inteiro**
  (`maxExecutionTimeMs`); os 25/25/50% de fase continuam como guard-rails internos.
- **NÃO** instanciar `UsageTracker` nem persistir cost rows em `execution_usage` (J9 é sobre o
  **gate de abort**, não sobre telemetria persistida — esta já é endereçada noutro lugar).
- **NÃO** garantir custo correto em **streaming** (`usage-decorator.ts:52-61` é pass-through sem
  somar tokens) — gap conhecido, documentado em §8.
- **NÃO** consertar cancelamento mid-LLM-call: aceita-se o cap de 30s do adapter como bound do
  pior caso órfão para o piloto.

## §4. Architecture proposal

### 4.1 Design options

**Option A — Deadline cooperativo + cost gate no step loop (mínimo, idiomático). ✅ RECOMENDADO**

- Adiciona checagem de deadline (`devStartTs + maxExecutionTimeMs`) e de custo-corrente-vs-teto
  no topo do `while (await engine.shouldContinue(...))` (`:657`) **e** em volta de `synthesize`.
- Reaproveita o padrão accumulator-by-reference já provado (`usageAccumulator`,
  `execution-context.ts:124`); estende o `onUsage` (`:914`) pra também somar custo via o `meta`
  model/provider já fluindo + `calculateCostCents`.
- Zero churn na interface `LLMGateway`/adapters.
- Lança um `ExecutionAbortError` tipado que o `catch` (`:1662`) já trata
  (failed `/complete` + dedup clear + rethrow).
- Envolve `synthesize` (`:1553`) num `runWithTimeout` pra fechar o buraco J8.
- **Cons:** cooperativo — abort é checado **entre** steps, não mid-LLM-call; um único `fetch`
  travado fica bounded só pelo `AbortSignal.timeout(30s)` do adapter. Aceitável: adapters já
  self-timeout. Trabalho órfão de timeout de fase ainda não é truly-cancelled (mas o cap de
  30s por chamada o limita).

**Option B — `AbortController` real threaded ponta-a-ponta (`LLMRequestOptions.signal`).**

- Cancelamento real: um `AbortController` top-level criado em `:866`, signal threaded por
  `AgentExecutionContext` → `LLMRequestOptions.signal` (`llm-gateway.ts:60`) → `fetch` do adapter
  (combinado com `AbortSignal.timeout` via `AbortSignal.any`). Timeout/teto disparam
  `controller.abort()` e fetches in-flight morrem na hora — elimina trabalho órfão e o hang do
  synthesize **estruturalmente**. `p-timeout@6` (já dep) aceita `signal` nativamente.
- **Cons:** toca **todos** os adapters (openai/gemini/anthropic) + a interface do gateway + a
  decorator chain (retry/circuit-breaker/usage) que precisa forwardar o signal. Diff maior, risco
  de regressão na camada de robustez LLM que a auditoria confirma correta (J7/DEBT-04). Mais
  superfície de teste.

**Option C — Timeout só no nível do BullMQ job. ❌ REJEITADO.**

- Trivial: confia num job/lock-timeout da fila pra eventualmente reclamar um job travado.
- **Cons:** NÃO satisfaz a intenção de J8/J9 — sem `/complete` failed gracioso pro backend, sem
  teto de custo nenhum, worker continua queimando a promise órfã + gasto LLM até o OS/processo.
  Backend vê stall silencioso (agrava J5/J10). Mais grosseiro, menos observável.

### 4.2 Decisão recomendada e justificativa

**Recomendado: Option A** (deadline cooperativo + cost gate), com a adição targeted de envolver
`engine.synthesize` (`:1553`) num timeout. Justificativa fundamentada no código:

1. O padrão accumulator-by-reference **já está estabelecido e threaded** (`usageAccumulator` em
   `execution-context.ts:124` / set em `:992`), então adicionar um running-cost accumulator + um
   deadline ao `AgentExecutionContext` e checá-los no boundary de loop existente (`:657`) e em
   volta de `synthesize` é idiomático e baixo-risco.
2. O `onUsage` callback (`:914`) **já recebe** `meta: { model, provider, latencyMs }` (assinatura
   `UsageCallback`, `usage-decorator.ts:28`) — só não usa hoje. `calculateCostCents`
   (`cost-calculator.ts:38`) computa o custo corrente com **zero plumbing novo**.
3. O `catch` boundary existente (`:1662`) já faz failed-`/complete` + dedup-clear + rethrow, então
   um `ExecutionAbortError` lançado **não precisa** de caminho de erro novo.
4. Adapters já self-cap cada chamada LLM em 30s (`LLM_REQUEST_TIMEOUT_MS`, `env.ts:40`), bounding
   o pior caso de chamada órfã, o que torna o abort cooperativo suficiente pro piloto sem
   desestabilizar a camada de robustez LLM (J7/DEBT-04).

Option B (signal threading real) fica como **follow-on documentado** se cancelamento mid-call
virar requisito firme — é o fix estruturalmente completo mas não warranted pro unblock mínimo.

### 4.3 `ExecutionAbortError` tipado + `runWithTimeout` que aborta

Novo erro tipado (em `execution-handler.ts` ou `src/runtime/errors.ts`):

```typescript
export type AbortReason = "wall_clock_timeout" | "cost_ceiling" | "phase_timeout";

export class ExecutionAbortError extends Error {
  constructor(
    readonly reason: AbortReason,
    message: string,
    /** Aborts determinísticos (cost ceiling) NÃO devem ser re-tentados pelo BullMQ. */
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = "ExecutionAbortError";
  }
}
```

> **⚠️ `retryable` é advisory e — desde a semântica terminal — em grande parte vestigial.**
> O handler agora **ACK (return) em QUALQUER abort** (§4.10): o `/complete` terminal já foi
> emitido e o backend já reconciliou aos 120s, então rethrow só desperdiçaria os `attempts:7`
> do producer (bevox-backend). Logo o BullMQ **nunca** vê um abort re-lançado — o discriminante
> `wall_clock_timeout` vs `cost_ceiling` **não muda mais o caminho de ACK** (ambos retornam).
> O campo `retryable` permanece no tipo (telemetria + defesa-em-profundidade) mas **não governa
> mais** se há rethrow: o gatilho de rethrow é simplesmente `abort === undefined` (erro
> não-abort/transiente). O consumer (`bullmq-consumer.ts`) faz `throw err` **incondicional** no
> seu próprio `catch` e **não inspeciona** `retryable`; o `Worker` é construído **sem**
> `attempts`/`backoff`, então qualquer retry é 100% controlado pelo **producer**. Defesa em
> profundidade: a dedup key é **retida** em todos os aborts → se o producer mesmo assim
> re-entregar a mesma `execution_id` (não deveria, dado o ACK), o `SET NX` devolve null →
> return silencioso. Ver risco (7) e OQ 5 (RESOLVIDO).

`runWithTimeout` endurecido pra disparar um `AbortController` no timeout (mantém compat com
callers atuais; o `signal` é opcional). Trabalho cooperativo que observe o signal pode parar; o
que não observa cai no cap do adapter:

```typescript
function runWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  controller?: AbortController,        // novo, opcional
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();             // sinaliza trabalho cooperativo
      reject(new ExecutionAbortError("phase_timeout", `Timeout: ${label} exceeded ${ms}ms`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
```

### 4.4 Deadline + cost budget no `AgentExecutionContext`

Estende `AgentExecutionContext` (`execution-context.ts:113-125`) com campos **opcionais**
(espelha o padrão by-reference do `usageAccumulator`):

```typescript
  /**
   * J8 — deadline absoluto de wall-clock (epoch ms). Derivado de
   * `devStartTs + maxExecutionTimeMs` no handler. O surface loop checa
   * `Date.now() >= deadlineMs` no topo de cada step e aborta.
   */
  deadlineMs?: number;

  /**
   * J9 — teto de custo em centavos USD (resolvido do payload.max_cost_usd
   * OU env.HARNESS_MAX_COST_USD). Quando definido, o loop aborta assim que
   * `costAccumulator.costCents` o cruzar.
   */
  costCeilingCents?: number;

  /**
   * J9 — acumulador per-execução de custo corrente (centavos USD). Mutável
   * por referência, espelha `usageAccumulator`: o `onUsage` callback soma
   * via `calculateCostCents` usando o meta model/provider. Lido no loop e
   * no /complete final.
   */
  costAccumulator?: { costCents: number };
```

### 4.5 `onUsage` — acumular custo corrente (handler `:910-919`)

```typescript
const usageAccumulator = { promptTokens: 0, completionTokens: 0 };
const costAccumulator = { costCents: 0 };                       // J9 — novo
const gateway = createLLMGateway(
  { default_model: defaultModel },
  {
    onUsage: (usage, meta) => {                                  // meta já existe na assinatura
      usageAccumulator.promptTokens += usage.input_tokens ?? 0;
      usageAccumulator.completionTokens += usage.output_tokens ?? 0;
      // J9 — custo corrente via o model real reportado pelo adapter.
      costAccumulator.costCents += calculateCostCents(
        meta.model,
        usage.input_tokens ?? 0,
        usage.output_tokens ?? 0,
        logger,
      );
    },
  },
);
```

> O `meta.model` é o modelo **efetivamente usado** (pós-failover), não o configurado — então o
> custo reflete o provider real que respondeu. Modelos sem pricing retornam 0
> (`cost-calculator.ts:45-51`) — o teto não dispara pra eles (gap aceito, §8).
>
> **⚠️ Viés de arredondamento (over-count).** `calculateCostCents` faz `Math.ceil` **por chamada**
> (`cost-calculator.ts:53`). Somar N resultados já-ceiled adiciona até ~N centavos de
> over-count vs. arredondar uma vez o total. Para um teto em centavos com muitas chamadas
> baratas (ex.: muitos steps `gpt-4o-mini`), isso faz o gate disparar **cedo** (fail-safe, não
> fail-open — aceitável pra um teto de segurança). Se precisão virar requisito, acumular
> `(promptTokens*p + completionTokens*c)` em **micro-cents** e só arredondar na leitura do gate.
> Para o piloto: documentado, não corrigido (over-count protege o budget).

### 4.6 Resolver budgets e threadar no context (handler, perto de `:866` / `:972-993`)

```typescript
const env_ = getEnv();
const deadlineMs = devStartTs + config.harness.maxExecutionTimeMs;   // J8 — wall-clock absoluto

// J9 — teto: payload override (USD) tem precedência sobre o default do env (USD).
const ceilingUsd = payload.max_cost_usd ?? env_.HARNESS_MAX_COST_USD;
const costCeilingCents =
  ceilingUsd && ceilingUsd > 0 ? Math.ceil(ceilingUsd * 100) : undefined;
```

E no `agentContext` (`:972-993`), junto do `usageAccumulator` que já está lá:

```typescript
const agentContext: AgentExecutionContext = {
  // ... campos existentes ...
  usageAccumulator,
  costAccumulator,        // J9
  deadlineMs,             // J8
  costCeilingCents,       // J9
};
```

### 4.7 Gate cooperativo no step loop (`runSurfaceAgentLoop`, `:657`)

No topo do `while`, antes de executar o step:

```typescript
while (await engine.shouldContinue(allObservations, plan, agentContext)) {
  // J8 — deadline de wall-clock (cooperativo, entre steps).
  if (agentContext.deadlineMs != null && Date.now() >= agentContext.deadlineMs) {
    throw new ExecutionAbortError(
      "wall_clock_timeout",
      `Execution exceeded wall-clock budget (deadline=${agentContext.deadlineMs})`,
    );
  }
  // J9 — teto de custo (determinístico ⇒ non-retryable).
  if (
    agentContext.costCeilingCents != null &&
    (agentContext.costAccumulator?.costCents ?? 0) >= agentContext.costCeilingCents
  ) {
    throw new ExecutionAbortError(
      "cost_ceiling",
      `Cost ceiling reached: ${agentContext.costAccumulator?.costCents}c >= ${agentContext.costCeilingCents}c`,
      /* retryable */ false,
    );
  }

  // ... step / observe / escalation existentes (intactos) ...
  stepIndex++;
}
```

> O cost gate é checado **antes** de cada step: se o step anterior já cruzou o teto, o loop
> aborta **sem** rodar o próximo step (sem novo gasto). Os checks ficam fora dos `continue` de
> escalation (`:705`, `:723`) — após escalation, o loop re-entra no `while` e re-checa.

### 4.8 Envolver `synthesize` num timeout (handler `:1546-1557`) — fecha J8-b

```typescript
// 11. Synthesize final response — agora bounded pelo deadline restante.
const engine = strategyRouter.build(agentDef, agentContext);
const finalPlan = { /* ... inalterado ... */ };

const remainingMs = Math.max(1, deadlineMs - Date.now());
const agentResponse: AgentResponse = await runWithTimeout(
  engine.synthesize(observations, finalPlan, agentContext),
  remainingMs,
  `Synthesize(${agentName})`,
);
```

> `remainingMs` = orçamento restante até o deadline global (não um novo slice). Se o loop já
> consumiu quase tudo, `synthesize` recebe o resíduo — fechando o buraco do synthesize
> não-bounded sem inventar um budget extra.
>
> **Limite honesto (não afirmar "fechado estruturalmente").** Esta chamada **não** passa um
> `AbortController` (Option A é cooperativa e `synthesize` é uma única chamada terminal — não há
> step boundary onde checar). Logo `runWithTimeout` aqui é um **reject-wrapper**: no estouro,
> a Promise do handler rejeita e roteia pro `catch`, **mas a Promise interna do `synthesize`
> (e o `fetch` LLM in-flight) continua órfã** até o `AbortSignal.timeout(30s)` do adapter
> (`openai.adapter.ts:114` etc.). Resultado: o *job* fica bounded (não pendura), mas há até ~30s
> de trabalho órfão pós-reject. Se `remainingMs` já for < 30s (loop quase esgotou o budget),
> o wrapper rejeita **antes** do adapter — então o adapter cap é o teto efetivo do órfão.
> Fechar isto de fato exige Option B (signal threaded até o `fetch` do synthesize). Documentado
> em risco (1) e (8).

### 4.9 Payload schema + env knob

`executionPayloadSchema` (`:515-558`) — campo **opcional** novo:

```typescript
    // J9 (runtime-gap): teto de custo por-execução em USD, enviado pelo
    // bevox-backend quando a org/plano impõe limite. Opcional; quando ausente,
    // cai no default env HARNESS_MAX_COST_USD (ou sem teto se env=0).
    max_cost_usd: z.number().positive().max(1000).optional(),
```

`env.ts` (perto de `:23`, junto de `HARNESS_MAX_EXECUTION_TIME_MS`):

```typescript
    // J9 — teto de custo default (USD) por execução. 0 = sem teto (legacy).
    HARNESS_MAX_COST_USD: z.coerce.number().min(0).default(0),
```

E expor em `harness-config.ts` (`:17-21`) junto de `maxExecutionTimeMs`:

```typescript
    harness: {
      logLevel: env.HARNESS_LOG_LEVEL,
      maxExecutionTimeMs: env.HARNESS_MAX_EXECUTION_TIME_MS,
      maxCostUsd: env.HARNESS_MAX_COST_USD,        // J9
      queueName: env.HARNESS_QUEUE_NAME,
    },
```

### 4.10 Boundary `catch` — discriminar desfecho, emitir `/complete` e **ACK aborts (return, NÃO rethrow)**

O `catch` permanece o **único** emissor do `/complete` terminal de erro (sem double-complete).
A mudança crítica do J8: **abort é desfecho TERMINAL** — depois de emitir o `/complete`, o
handler faz `return` (ACK do job), **NÃO** re-lança. Só erros não-abort (transientes) re-lançam.

```typescript
} catch (err) {
  logger.error({ execution_id, err }, "Execution failed");

  // J8/J9 — desfecho distinto pro backend distinguir exhaustion de falha genuína.
  const abort = err instanceof ExecutionAbortError ? err : undefined;
  const strategy = abort
    ? abort.reason === "cost_ceiling" ? "aborted_cost" : "aborted_timeout"
    : "failed";

  // devBus.emitEvent(...) — inalterado (fecha audit trail)
  // §4.11 — span attrs + log estruturado execution.aborted (telemetria)

  await sendComplete(
    execution_id,
    execution_token,
    buildCompletePayload({ responseText: "", sentiment: "neutral", strategy }),
    // idempotencyKey por-desfecho fica a cargo da spec de idempotência §4.4
  ).catch((callbackErr) => {
    logger.warn({ callbackErr }, "Failed to send error /complete callback");
  });

  await sessionStore.update(execution_id, { status: "failed" }).catch(() => {});

  // J8 — ABORT É TERMINAL: o /complete já foi emitido e o backend conciliou o
  // desfecho (timeout-scan em dispatched_at+120000ms → human handoff aos 120s).
  // Re-tentar via BullMQ só re-rodaria uma execução condenada (o producer
  // enfileira com attempts:7 + backoff exponencial ~635s). Logo:
  //   • ACK do job (RETURN, sem rethrow) ⇒ BullMQ marca success ⇒ ZERO retries.
  //   • RETER a dedup key (NÃO limpar) ⇒ qualquer re-entrega da mesma id bate no
  //     SET NX ⇒ return silencioso — defesa em profundidade.
  if (abort) {
    return;                       // TERMINAL — ACK, não rethrow
  }

  // Erro NÃO-abort (genuinamente transiente, ex.: backend unreachable):
  // limpar a dedup key permite retry legítimo com a MESMA execution_id; rethrow
  // ⇒ os attempts:7 do producer aplicam.
  await ctx.redis.del(dedupKey).catch((delErr) => {
    logger.warn({ execution_id, delErr }, "Failed to clear dedup key in error path");
  });

  throw err;                      // só erros transientes re-tentam
}
```

> **Por que ACK e não rethrow (o coração do fix J8).** O bug original: o `catch` re-lançava
> **incondicionalmente**, então **todo** abort (wall-clock/cost) era replay-ado pelo BullMQ até
> `attempts:7` do producer — 7 execuções condenadas, cada uma re-abortando, enquanto o backend
> **já tinha feito handoff pro humano** aos 120s via o timeout-scan. Tratar o abort como terminal
> (emite `/complete` + ACK) alinha o harness à intenção do backend: **um abort de wall-clock/custo
> é o desfecho final reportado, não uma falha a re-tentar.** Ver §4.10-coupling abaixo e OQ 5.
>
> **Nota de contrato:** `strategy: "aborted_cost" | "aborted_timeout"` é mudança de contrato
> opcional pro backend (ver §8 open question). Se o founder preferir manter `"failed"` genérico
> no piloto, o bloco acima degrada trivialmente pra `const strategy = "failed"`; a semântica
> ACK-terminal (o `if (abort) return;`) permanece independente do label do `strategy`.

#### Backend coupling (wall-clock alignment)

O backend (bevox-backend) roda um **timeout-scan independente**: a cada 2 min, um cron reconcilia
execuções presas em `dispatched_at + 120000ms` → `status=timeout` → **human handoff**. Implicações
pro budget de wall-clock do harness:

- **`HARNESS_MAX_EXECUTION_TIME_MS` DEVE ser < 120000ms.** Se o harness deixasse uma execução rodar
  além de 120s, o backend já a teria declarado `timeout` e feito handoff — e então o `/complete`
  tardio do harness chegaria depois da reconciliação, criando desfecho duplo/conflitante. **Default
  alinhado: 90000ms (90s)**, dando ~30s de margem antes do scan do backend disparar.
- **O default antigo (120000ms) é EXATAMENTE o threshold do backend** — race condition. Por isso o
  default foi baixado pra 90000ms nesta entrega.
- **A correção real do alinhamento de relógio é cross-repo — `deadline_ms` absoluto — LANDED
  read-side (canon APPROVED: bevox-knowledge #62 harness-proposal + #63 backend-edits).** O
  backend agora envia `deadline_ms` (epoch ms ABSOLUTO, ancorado no relógio do BACKEND/DB) no
  payload de dispatch. O harness **prefere `payload.deadline_ms`** quando presente e positivo;
  na ausência cai no fallback `devStartTs + maxExecutionTimeMs` (`Date.now()` no consume), byte-
  idêntico ao comportamento legado. Isso elimina o skew "tempo na fila + clock entre hosts": um
  job enfileirado por segundos não "começa o cronômetro" tarde — o deadline é o mesmo instante
  absoluto que o backend usa no timeout-scan. **Semântica de retry tardio (preservada, não
  special-cased):** um retry nascido com `deadline_ms` JÁ NO PASSADO faz o gate cooperativo de
  deadline no topo do surface loop (`Date.now() >= deadlineMs`) disparar IMEDIATAMENTE →
  `ExecutionAbortError("wall_clock_timeout", retryable:false)` → terminal `aborted_timeout` +
  um `/complete` + ACK, sem gastar step de LLM. Read-side em
  `src/runtime/execution-handler.ts` (schema `executionPayloadSchema.deadline_ms` +
  derivação `deadlineMs = payload.deadline_ms válido ? : devStartTs + maxExecutionTimeMs` +
  gate cooperativo em `runSurfaceAgentLoop`). O mitigante de margin de 30s do default 90s
  permanece como defesa-em-profundidade pro caminho de fallback (payloads sem `deadline_ms`).

### 4.11 Observabilidade & SLO (obrigatório — sem isto J8/J9 fecham "cego")

Sem instrumentação, um abort vira indistinguível de uma falha genérica nos dashboards e
**ninguém é alertado quando a taxa de abort sobe** (= regressão de SLO ou ataque de custo
silencioso). O harness não tem counters/histograms — só OTEL spans (`withSpan`/`setAttribute`,
`spans.ts:11-26`) + logs Pino. Hooks mínimos, todos baratos e no boundary que já existe:

1. **Atributos no `rootSpan`** (disponível no escopo do `catch`, criado em `:847`). No abort:
   ```typescript
   rootSpan.setAttribute("execution.outcome", strategy);          // ok | failed | aborted_cost | aborted_timeout
   if (abort) {
     rootSpan.setAttribute("execution.abort.reason", abort.reason);
     rootSpan.setAttribute("execution.duration_ms", Date.now() - devStartTs);
     rootSpan.setAttribute("execution.cost_cents", costAccumulator.costCents);
   }
   ```
   No sucesso, setar `execution.outcome = "ok"` + `execution.cost_cents` no caminho de `:1573`.
   Isso dá **uma dimensão consultável** (`execution.outcome`) pro backend/OTEL agregar taxa de
   abort por org/causa sem parsing de string.

2. **Log estruturado dedicado** (não só o `logger.error` genérico de `:1663`): emitir um campo
   estável `event: "execution.aborted"` com `{ reason, cost_cents, ceiling_cents, duration_ms,
   deadline_ms }`. Plataformas de log (Pino → Loki/Datadog) alertam sobre **rate** desse `event`
   — é o substituto do counter que não temos. **NÃO** logar prompt/PII (regra `harness-llm.md`).

3. **SLO/alertas recomendados** (definir no hub `infra/` + runbook, fora deste repo, mas
   especificados aqui pra não cair no esquecimento):
   - **Abort-rate SLO:** `aborted_timeout / total` deve ficar abaixo de ~1% numa janela 30d. Um
     spike = budget global apertado demais (falsos-positivos, risco (4)) **ou** degradação real
     de latência LLM. Burn-rate alert (curto 5m + longo 1h).
   - **Cost-abort alert:** qualquer `aborted_cost` é raro por design (teto é guard-rail, não
     operação normal). Alertar em **qualquer** ocorrência sustentada (ex.: > 3 em 10m por org)
     — sinaliza loop de raciocínio caro ou prompt-injection inflando custo.
   - **Dead-letter / retry-loop depth:** ver risco (9). Como **não há DLQ** hoje e o re-deliver de
     um `cost_ceiling` é absorvido pela dedup key (return silencioso, sem log de erro), um job
     que re-tenta em loop fica **invisível**. Mínimo: contar re-delivers via `job.attemptsMade`
     no consumer e logar `event: "execution.redelivery"` com o `execution_id` + `attemptsMade`;
     alertar se `attemptsMade` cruzar um teto. (Fora do escopo de código desta spec — mas é a
     peça de observabilidade que torna o `retryable=false`/dedup-retention **auditável**.)

> **Por que isto é parte do fix, não um nice-to-have:** J8/J9 existem porque o sistema queimava
> recursos *silenciosamente*. Adicionar o abort sem o sinal só move o silêncio um nível acima
> (de "hang" pra "abort não-observado"). O custo é ~6 linhas no boundary + uma definição de
> alerta no hub.

### 4.12 Shutdown vs. abort em mutação in-flight (drain, não kill)

O SIGTERM handler (`shutdown.ts:69`) chama `stopConsumer()` → `worker.close()`
(`bullmq-consumer.ts:48`) **sem** `force`, então o BullMQ **drena** o job ativo (espera ele
terminar) em vez de matá-lo. Interação com este fix:

- **Mutação in-flight no shutdown:** drain = a mutação completa seu efeito externo e emite seu
  `/complete`. Isto é o comportamento **desejado** (não abortamos no meio de um side-effect) e
  preserva a interação com a idempotency-key: se o pod morrer **antes** do `/complete` e o job
  for re-entregue, a chave content-derived (`idempotency-key spec` §4.4) dedup o efeito. Esta
  spec **não** introduz abort no caminho de shutdown — apenas no deadline/teto.
- **Risco que o deadline global MITIGA:** sem J8, um job hung travava `worker.close()`
  indefinidamente, e a plataforma eventualmente mandava **SIGKILL** → mutação órfã **sem**
  `/complete` terminal. O deadline cooperativo agora **bounda** quanto tempo `worker.close()`
  pode esperar (próximo step boundary, ou o synthesize-timeout, ou o adapter 30s cap). Listar
  isto como **benefício** de J8 no PR.
- **Gap residual (documentar, OQ 6):** `shutdown.ts` **não tem grace-timeout próprio** em volta
  de `stopConsumer()`. Se `worker.close()` ficar bloqueado num job que **não** observa o
  deadline cooperativo (ex.: preso num `fetch` antes do adapter cap disparar), o shutdown pendura
  até o SIGKILL do orquestrador. Mitigação fora do escopo deste fix mas vinculada: envolver
  `stopConsumer()` num `Promise.race` com `maxExecutionTimeMs` + um pequeno buffer.

## §5. Implementation plan

### Phase 1 — Tipos, budgets e cost accumulation (~2h)

**Files:**
- `src/runtime/execution-handler.ts` (ou novo `src/runtime/errors.ts`) — `ExecutionAbortError` +
  `AbortReason` (§4.3).
- `src/runtime/execution-handler.ts:738-755` — `runWithTimeout` aceita `AbortController?`
  opcional e dispara `controller.abort()` no timeout (§4.3).
- `src/agents/execution-context.ts:113-125` — `deadlineMs?`, `costCeilingCents?`,
  `costAccumulator?` (§4.4).
- `src/config/env.ts:~23` — `HARNESS_MAX_COST_USD` knob (§4.9).
- `src/config/harness-config.ts:17-21` — expor `maxCostUsd` (§4.9).
- `src/runtime/execution-handler.ts:910-919` — `costAccumulator` + estender `onUsage` pra somar
  custo via `meta.model` + `calculateCostCents` (§4.5).

**Testes:**
- `tests/unit/observability/cost-calculator.test.ts` — já existe; adicionar caso de acumulação
  monotônica (somar várias chamadas).
- `tests/unit/integration/llm/usage-decorator.test.ts` — assert que `onUsage` recebe `meta`
  (model/provider) e que o callback custom soma custo.
- `tests/unit/runtime/execution-payload.test.ts` — `max_cost_usd` parse: válido, negativo
  rejeitado, ausente → undefined.

**Result:** budgets resolvíveis e custo corrente disponível por-referência; nenhum
comportamento de abort ainda (mudança inerte/safe).

### Phase 2 — Gates de abort (deadline + custo) e synthesize timeout (~2h)

**Files:**
- `src/runtime/execution-handler.ts:~866` / `:972-993` — derivar `deadlineMs`/`costCeilingCents`
  e threadar no `agentContext` (§4.6).
- `src/runtime/execution-handler.ts:657-729` — gate cooperativo no topo do `while` (§4.7).
- `src/runtime/execution-handler.ts:1546-1557` — envolver `synthesize` em `runWithTimeout`
  com `remainingMs` (§4.8).

**Testes:**
- `tests/unit/runtime/execution-handler.flow.test.ts` (já mocka registries/engine/Redis/
  callbacks via `vi`, exercita `handleExecution` end-to-end):
  - (a) **wall-clock:** engine cujo `shouldContinue`/`step` atrasa além de um
    `HARNESS_MAX_EXECUTION_TIME_MS` pequeno injetado → assert `/complete`
    (`strategy:"aborted_timeout"` ou `"failed"`) enviado + dedup key limpa.
  - (b) **synthesize timeout:** mock `engine.synthesize` que pendura → assert que o novo wrapper
    rejeita e roteia pro boundary de falha.
  - (c) **cost ceiling:** driva o `onUsage`/`costAccumulator` com usage que cruza
    `max_cost_usd` → assert que o loop aborta **após** o step ofensor (sem steps adicionais) e
    NÃO limpa a dedup key (non-retryable).

### Phase 3 — Boundary catch, contrato e governança (~1–2h)

**Files:**
- `src/runtime/execution-handler.ts:1662-1698` — discriminação de desfecho + non-retryable guard
  (§4.10).
- `src/runtime/execution-handler.ts` (catch `:1662` + success `:1573`) — atributos de span
  (`execution.outcome`/`execution.abort.reason`/`execution.cost_cents`) + log estruturado
  `event:"execution.aborted"` (§4.11). **Sem isto o fix fecha cego — obrigatório, não opcional.**
- `.claude/rules/harness-payload.md` — documentar `max_cost_usd` (opcional) no payload + nota
  Layer-budget; documentar `HARNESS_MAX_COST_USD`.
- (Runbook/hub `infra/`, fora deste repo) — definir alertas abort-rate / cost-abort /
  redelivery-depth (§4.11.3). Tracked como follow-up de governança, não código deste repo.
- `skills/bevox-agent-harness-consumer/references/execution-payload.md` — adicionar `max_cost_usd`
  (campo opcional → minor change, per regra "Ao adicionar campo novo").
- (Governança) propor nota de contrato `aborted_cost`/`aborted_timeout` no `CompleteCallback` via
  skill `bevox-knowledge-contribute` (não bloqueia o código; ver §8 OQ).

**Testes:**
- `tests/unit/runtime/execution-handler.flow.test.ts` — assert que abort de custo é
  non-retryable (dedup NÃO limpa) e timeout/falha-genérica são retryable (dedup limpa).
- Garantir nenhum double-`/complete`: assert `sendComplete` chamado **uma** vez no caminho de
  abort (sucesso nunca emite no mesmo run).

## §6. Testing strategy

### Unit (preferido — determinístico, sem postgres real)

Note do audit (`j-build-04`): a suíte de integração roda contra `postgres:16` puro, então **toda
a lógica de abort/cost-ceiling fica no tier unit** pra ficar determinística.

- **`execution-handler.flow.test.ts`** (hook principal, mocks `vi` já presentes,
  `:119-266`): wall-clock abort, synthesize-timeout, cost-ceiling abort, non-retryable dedup
  behavior, single-`/complete`.
- **`usage-decorator.test.ts`**: `onUsage` recebe `meta`; custom callback soma custo.
- **`cost-calculator.test.ts`**: acumulação monotônica; modelo desconhecido → 0 (teto não
  dispara).
- **`execution-payload.test.ts`**: `max_cost_usd` opcional/validação.

### Integration (RUN_INTEGRATION=1, `describe.skipIf(!RUN)`)

Só se asserir cost rows reais em `execution_usage` (NÃO requerido pra a lógica de abort em si).
Padrão: `tests/integration/execution-handler.integration.test.ts:9`,
`usage-tracker.integration.test.ts:9-11`.

### Regression

- Caminho `autonomous_supervised` sem teto (`HARNESS_MAX_COST_USD=0`, `max_cost_usd` ausente) →
  **byte-idêntico** ao comportamento atual (sem abort).
- Escalation paths (`:705`, `:723`) intactos — re-checam gate ao re-entrar no `while`.
- EM-03 proposal accumulation: ver §8 risco (6) — abort path deve decidir explicitamente sobre
  `proposalsAccumulator`.

### Edge cases adicionais (adversarial — devem ter teste explícito)

- **Single-`/complete` em CADA caminho de abort:** assert `sendComplete` chamado **exatamente
  uma vez** em wall_clock, cost_ceiling e synthesize-timeout — e que o caminho de sucesso
  (`:1573`) **não** dispara quando o abort lança (mutuamente exclusivos por `throw`). Cobre o
  invariante de não-double-`/complete`.
- **Redis-down no boundary (risco 10):** `ctx.redis.del` rejeita → assert que o `/complete`
  terminal **ainda** sai (backend não vê stall) e que o handler **não** lança um erro secundário
  (o `throw err` original prevalece). Fácil com o `redis.fake` fazendo `del` rejeitar.
- **Cost_ceiling NÃO limpa dedup + re-deliver é absorvido:** após o abort de custo, simular
  re-deliver do mesmo `execution_id` → assert `SET NX` retorna null → return silencioso (sem
  segundo `/complete`, sem re-abort).
- **Observabilidade (§4.11):** assert que o `rootSpan` recebe `execution.outcome` =
  `aborted_cost`/`aborted_timeout` e que um log `event:"execution.aborted"` é emitido (spy no
  logger child). Sem este teste a instrumentação regride silenciosamente.

## §7. Migration & rollback

**Ativação gradual:**
1. **Phase 1** é inerte: adiciona tipos, env knob (default `0` = sem teto), e cost accumulation.
   Sem `deadlineMs`/`costCeilingCents` setados, **nenhum** abort dispara. Safe to ship isolado.
2. **Phase 2** liga os gates. Com `HARNESS_MAX_EXECUTION_TIME_MS` no default (**90s** —
   baixado de 120s pra ficar < o timeout-scan de 120s do backend) e `HARNESS_MAX_COST_USD=0`,
   **só** o wall-clock global e o synthesize-timeout ativam (o que já era a intenção das fases); o
   teto de custo permanece off até a org/env configurar.
3. **Phase 3** adiciona discriminação de desfecho + **ACK terminal do abort** (return, não rethrow).
   Reversível pra `"failed"` genérico + rethrow incondicional trivialmente (mas o rethrow era o
   bug J8 — não reverter sem motivo).

**Rollback:** cada fase é revertível sem perda de dados (nenhuma migration, nenhum schema DB
tocado). Reverter Phase 2 desliga os aborts; reverter Phase 1 remove os campos opcionais (callers
de teste que não os setam ficam intactos).

**Feature flag (opcional):** `HARNESS_MAX_COST_USD=0` já serve como kill-switch do teto de custo.
Pro wall-clock, um `HARNESS_MAX_EXECUTION_TIME_MS` alto efetivamente desabilita o deadline.

## §8. Risks & open questions

### Risks
1. **Gate cooperativo não mata fetch in-flight.** Mitigado pelo `AbortSignal.timeout(30s)`
   self-imposto dos adapters (`env.ts:40`), mas um pior caso de chamada órfã ainda pode rodar até
   esse cap **após** o job ser declarado falho. NÃO afirmar "hardened" no PR — repetiria o padrão
   CANON-STALE da auditoria. O fix estruturalmente completo é Option B (signal threading).
2. **Custo de streaming sub-contado.** `usage-decorator.ts:52-61` é pass-through **sem** somar
   tokens; `usageAccumulator`/`onUsage` rodam FORA dos decorators de retry/circuit-breaker
   (`usage-decorator.ts:12-18` comment). Logo uma execução streaming (`STREAM_ENABLED` +
   `payload.stream`) **sub-conta** custo e o teto J9 pode ser **burlado**. Flag como gap conhecido;
   o teto é best-effort em streaming até o follow-up de streaming-usage.
3. **Modelos sem pricing → custo 0** (`cost-calculator.ts:45-51`): o teto **nunca dispara** pra
   modelos não tabelados. Aceitável, mas documentar — adicionar pricing novo é trivial.
4. **Falsos-positivos sob latência LLM lenta-mas-legítima.** Apertar synthesize/loop timeouts
   arrisca novas falhas. Mitigação: o deadline global usa o budget **inteiro**
   (`HARNESS_MAX_EXECUTION_TIME_MS`), não um re-slice; synthesize recebe o `remainingMs`.
5. **Interação com retry semantics — RESOLVIDO via semântica terminal.** O `ExecutionAbortError`
   **NÃO** re-lança mais: o boundary emite `/complete` e faz **ACK (return)** (§4.10). Logo o
   BullMQ marca o job como sucesso → zero replays, apesar dos `attempts:7` do producer (OQ 5). A
   dedup key é retida em **todos** os aborts (defesa em profundidade — uma re-entrega inesperada da
   mesma id bateria no `SET NX` → return silencioso). Só erros não-abort (transientes) limpam a
   dedup key e re-lançam, deixando o `attempts:7` aplicar. Isto elimina o loop de re-abort que o
   rethrow incondicional original causava.
6. **Accumulators compartilham o context.** `proposalsAccumulator` (EM-03) e outros vivem no
   mesmo escopo. O abort path **dropa** as proposals acumuladas (não passa `proposals` no
   `/complete` de erro). Decisão explícita necessária: dropar (atual) vs emitir parciais.
   Recomendação: **dropar** no piloto (um abort não é um desfecho válido pra propor ação ao
   humano); documentar.
7. **`retryable` é vestigial — o discriminante de rethrow é `abort === undefined`.** Com a
   semântica terminal (§4.10), o handler faz ACK/return em **qualquer** abort, então `retryable`
   não governa mais o caminho de rethrow (governa-o `abort === undefined`). O consumer
   (`bullmq-consumer.ts`) faz `throw err` incondicional no seu próprio `catch` e **não lê**
   `retryable`; o `Worker` não declara `attempts`/`backoff` — o retry é producer-controlado
   (`attempts:7`, OQ 5 RESOLVIDO). `retryable` permanece no tipo como telemetria/sinalização
   semântica. **Recomendação:** renomear mentalmente como advisory; não confiar nele pra controlar
   retry. Ver §4.3.
8. **Synthesize-timeout não cancela o `fetch` interno.** §4.8 envolve `synthesize` num
   `runWithTimeout` **sem** `AbortController` (não há step boundary cooperativo numa chamada
   terminal única). No estouro o job é bounded, mas o `fetch` LLM do synthesize fica órfão até o
   `AbortSignal.timeout(30s)` do adapter. Para `remainingMs < 30s` o wrapper vence; senão o cap
   do adapter é o teto do órfão. Fix completo = Option B. NÃO afirmar "synthesize fechado
   estruturalmente".
9. **Não existe dead-letter — mitigado pela semântica terminal, mas mantido como item.** O repo
   não tem DLQ (CLAUDE.md: "v2 vai pra dead-letter"; grep `dead-letter|DLQ` em `src/` = 0 hits).
   **A semântica terminal (§4.10) remove o vetor principal de retry-loop:** como aborts fazem
   ACK/return (não rethrow), o BullMQ **não re-entrega** uma execução abortada — não há mais o loop
   de re-abort que o rethrow incondicional causava. O risco residual de retry-loop fica restrito a
   erros **não-abort** transientes que re-lançam e batem o `attempts:7` do producer (com backoff
   ~635s isto é bounded a 7 tentativas, não infinito). Mantido o hook de observabilidade §4.11.3
   (`job.attemptsMade` → `execution.redelivery`) pra tornar QUALQUER re-entrega auditável. Sem DLQ,
   a 7ª tentativa falha de um erro transiente é simplesmente perdida (v2 → dead-letter).
10. **Redis down no boundary de erro.** Sob a semântica terminal (§4.10), o caminho de abort
    **nem chega** ao `del(dedupKey)` (faz `return` antes), então um Redis-down durante um abort é
    inócuo pro abort: (a) `sessionStore.update` é best-effort (`.catch`) — não quebra; (b) a dedup
    key fica viva (que é exatamente o comportamento desejado pra um terminal — defesa em
    profundidade); (c) o `sendComplete` ao backend **não** depende de Redis, então o `/complete`
    terminal ainda sai — o backend não vê stall. **Para erros NÃO-abort (transientes)**, o
    `ctx.redis.del(dedupKey)` best-effort que falha sob Redis-down deixa a key viva por 1h →
    bloqueia um retry legítimo até o TTL (sintoma C12 sob Redis-down) — gap conhecido, restrito
    agora a erros transientes (não a aborts). Documentar: Redis-down degrada *retry-ability de
    erros transientes*, não a terminação nem o caminho de abort.

### Open questions
1. **Source de `max_cost_usd`: payload, env, ou ambos com override?** Recomendado: **ambos** —
   payload (por-execução, backend-driven) com precedência sobre `HARNESS_MAX_COST_USD` (default
   org-wide). O contrato backend (`CompleteCallbackSchema`/`harness-payload.md`) não define
   `max_cost_usd` hoje; adicioná-lo é minor change mas precisa de nota no canon.
2. **Desfecho distinto pro backend?** Emitir `strategy:"aborted_cost"`/`"aborted_timeout"` (vs
   `"failed"` genérico em `:1677`) deixa o backend distinguir exaustão de falha genuína (amarra
   em H-CB / J5). Decisão do founder: introduzir os novos valores agora (mudança de contrato) ou
   manter `"failed"` no piloto e adiar.
3. **~~Cost-ceiling aborts non-retryable no BullMQ?~~ — superado pela semântica terminal.**
   A questão original (marcar cost_ceiling como non-retryable pra não re-abortar) deixou de ser
   específica de cost: **TODO** abort (wall-clock E cost) é agora terminal e faz ACK/return (§4.10).
   Nenhum abort re-tenta. O `retryable` no tipo vira advisory/telemetria (ver §4.3); o discriminante
   de rethrow é só `abort === undefined` (erro transiente). Dedup key retida em todos os aborts
   como defesa em profundidade.
4. **Option B (cancelamento mid-call) é requerido pro piloto?** Recomendado **não** — o
   self-timeout de 30s do adapter é bound aceitável. Reavaliar se produção mostrar trabalho órfão
   custoso.
5. **~~O job é enfileirado com retry (`attempts > 1`)?~~ — ✅ RESOLVIDO (2026-06-02).**
   **Confirmado:** o producer (bevox-backend) enfileira o dispatch com **`attempts: 7` + backoff
   exponencial (~635s total)**, na **queue `bevox.execution.dispatch`**, com **`jobId =
   execution_id`** (dedup nativo do BullMQ por jobId). O consumer do harness não declara
   `attempts`/`backoff` — confirma-se que o retry é 100% producer-controlado.
   **Consequência (que motivou a re-arquitetura da §4.10):** com `attempts:7`, rethrow de um abort
   significava replay 7× de uma execução condenada. Por isso o fix trata abort como **terminal**
   (emite `/complete` + ACK/return, sem rethrow) — ver §4.10. O backend, independentemente,
   reconcilia execuções presas em `dispatched_at+120000ms` (cron 2-min → `status=timeout` → human
   handoff), então o desfecho de abort/timeout já é coberto pelo handoff; o harness não precisa —
   e não deve — re-tentar. Esta OQ deixa de ser bloqueante: a semântica ACK-terminal é correta sob
   `attempts:7` (zero replays desperdiçados) e seria igualmente correta sob `attempts:1`.
6. **Grace-timeout no shutdown?** `shutdown.ts` não envolve `stopConsumer()` em timeout (§4.12).
   O deadline cooperativo de J8 bounda a maioria dos casos, mas um job preso num `fetch` antes do
   adapter cap pode pendurar o `worker.close()` até o SIGKILL do orquestrador (→ mutação órfã sem
   `/complete`). Vale adicionar um `Promise.race(stopConsumer(), timeout(maxExecutionTimeMs + buffer))`?
   Fora do escopo de código deste fix, mas decisão do founder se entra como follow-on imediato
   (barato, ~5 linhas) ou fica pra hardening pós-piloto.

### Cross-system flags (não implementados aqui — cross-references / open items)

Dois acoplamentos cross-system descobertos ao fechar a semântica de abort. **Nenhum é
implementado nesta entrega** — ficam registrados como itens abertos com a spec/PR de destino:

7. **Replay manual por staff cunha um NOVO `execution_id` → a Idempotency-Key não deduplica →
   risco de mutação de calendário DUPLICADA.** A Idempotency-Key (ADR-023) é derivada de
   `sha256(execution_id + ':' + step_index + ':' + tool_name)`. Quando o backend faz handoff aos
   120s e um humano (staff) dispara um **replay manual**, o backend cunha um `execution_id`
   **novo** pro replay. Logo a Idempotency-Key derivada **difere** da execução original — se a
   execução original **já tinha efetivado** uma mutação real (ex.: `create-appointment` no modo
   autonomous antes do abort), o replay **NÃO** deduplica contra ela → **agenda duplicada**.
   **Fix recomendado (cross-repo):** um campo de lineage no payload de dispatch —
   `original_execution_id` — e derivar as chaves de `original_execution_id ?? execution_id`. O
   replay carrega o `original_execution_id` da execução-pai → a chave colide com a original → dedup
   correto. Pertence à **spec de idempotência** (`2026-06-02-idempotency-key-full-threading-design.md`)
   / **PR #59**. **Mitigação até lá:** o replay de mutações de appointment (efeitos externos reais)
   deve ser **gated** (bloqueado) até o lineage landar — não re-executar mutações num replay
   manual enquanto a chave não puder deduplicar contra a execução original.

8. **Desfechos `aborted_*` devem mapear pro idempotency `kind: failed`.** Esta spec emite
   `strategy: "aborted_cost" | "aborted_timeout"` no `/complete` terminal. A spec de idempotência
   (§4.4) deriva a Idempotency-Key do `/complete` **por desfecho** (tabela de `kind`). Para evitar
   colisão de chave (um `aborted_*` colidindo com — ou divergindo de — um `failed` anterior do
   mesmo `execution_id`), os dois `aborted_*` devem **mapear pro `kind: failed`** na tabela §4.4
   daquela spec (abort *é* uma falha pro contrato de idempotência; o `strategy` distinto é só
   telemetria). **Ação:** registrar o mapeamento na spec de idempotência §4.4. Esta spec
   deliberadamente **não** adiciona novo call-site de `/complete` nem novo `kind` (ver §2 invariante
   + §4.10).

## §9. Definition of done

- [ ] **Phase 1:**
  - [ ] `ExecutionAbortError` + `AbortReason` tipados
  - [ ] `runWithTimeout` aceita `AbortController?` e aborta no timeout
  - [ ] `AgentExecutionContext` com `deadlineMs?`, `costCeilingCents?`, `costAccumulator?`
  - [ ] `HARNESS_MAX_COST_USD` no `env.ts` + exposto em `harness-config.ts`
  - [ ] `onUsage` soma custo via `meta.model` + `calculateCostCents`
  - [ ] Unit: cost accumulation + `max_cost_usd` parse; compila sem warnings
- [ ] **Phase 2:**
  - [ ] `deadlineMs`/`costCeilingCents` threaded no `agentContext`
  - [ ] Gate cooperativo (deadline + custo) no topo do `while` (`:657`)
  - [ ] `synthesize` envolvido em `runWithTimeout` com `remainingMs`
  - [ ] Unit: wall-clock abort, synthesize-timeout, cost-ceiling abort (sem step extra)
- [ ] **Phase 3:**
  - [ ] Boundary `catch` discrimina desfecho + **ACK do abort (return, não rethrow)** — abort é
        TERMINAL (§4.10); só erro não-abort re-lança. Dedup key retida em todos os aborts.
  - [ ] **Observabilidade (§4.11):** atributos de span `execution.outcome`/`execution.abort.reason`/
        `execution.cost_cents` no catch E no sucesso; log estruturado `event:"execution.aborted"`
        (sem PII). **Gate de DoD, não opcional** — sem isto o abort fecha cego.
  - [ ] `max_cost_usd` documentado em `harness-payload.md` + `execution-payload.md`
  - [ ] Unit: **abort ACK behavior** (não rethrow; BullMQ não re-tenta) + dedup retida +
        single-`/complete`
  - [ ] (Opcional) nota de contrato `aborted_*` via `bevox-knowledge-contribute`
  - [ ] **Coordenação cross-spec:** confirmar mapeamento dos `aborted_*` na tabela de `kind` da
        spec de idempotência §4.4 (recomendação: mapear pra `failed`) — ver §2 invariante + §8 OQ 8.
- [x] **Producer retry config (§8 OQ 5): ✅ RESOLVIDO** — `attempts:7` + backoff exponencial
      (~635s), queue `bevox.execution.dispatch`, `jobId=execution_id`. Motiva a semântica
      ACK-terminal (rethrow desperdiçaria os 7 attempts numa execução condenada).
- [ ] **Backend coupling:** `HARNESS_MAX_EXECUTION_TIME_MS` < 120000 (default agora 90000) pra
      ficar abaixo do timeout-scan do backend (`dispatched_at+120000ms` → human handoff). Follow-on
      cross-repo recomendado: backend carimba `dispatched_at` no payload (§4.10-coupling).
- [ ] **Cross-system flags (§8 OQ 7/8 — não implementados aqui):** (7) replay manual cunha novo
      `execution_id` → Idempotency-Key não deduplica → mutação de calendário duplicada; fix =
      `original_execution_id` lineage (spec idempotência / PR #59); gate replay de mutações até lá.
      (8) `aborted_*` → `kind: failed` na spec de idempotência §4.4.
- [ ] Audit findings J8 + J9 validados como closed
- [ ] Alertas SLO definidos no hub `infra/` (abort-rate / cost-abort / redelivery-depth, §4.11.3)
- [ ] Sem regressões (`autonomous_supervised` sem teto = byte-idêntico)
- [ ] Code review aprovado (handler + context + config)

## §10. References

- **Audit:** `runtime-gap-audit-2026-06-02.md:274-276` (J8 sem timeout global/synthesize sem
  timeout/órfão sem AbortController; J9 cost-calculator mede mas não corta); `j-build-04`
  (integração roda contra postgres puro → manter abort/cost tests no tier unit).
- **Código fonte (verificado):**
  - `src/runtime/execution-handler.ts:738-755` — `runWithTimeout` não-cancelante
  - `src/runtime/execution-handler.ts:830` — `handleExecution` entry; `:866` — `devStartTs`
  - `src/runtime/execution-handler.ts:637-732` — `runSurfaceAgentLoop`; `:657-729` — `while` loop;
    `:705`,`:723` — escalation reset `stepIndex=0`
  - `src/runtime/execution-handler.ts:910-919` — `usageAccumulator` + `onUsage` (só soma tokens)
  - `src/runtime/execution-handler.ts:972-993` — `agentContext` build (`usageAccumulator` em `:992`)
  - `src/runtime/execution-handler.ts:1529-1540` — surface loop `runWithTimeout` (50%)
  - `src/runtime/execution-handler.ts:1546-1557` — `synthesize` **sem** timeout (`:1553`)
  - `src/runtime/execution-handler.ts:1573-1584` — `/complete` sucesso; `:1662-1698` — `catch`
    boundary (failed `/complete` `:1674`, session `:1682`, dedup del `:1691`, rethrow `:1698`)
  - `src/runtime/execution-handler.ts:515-558` — `executionPayloadSchema` (sem `max_cost_usd`)
  - `src/agents/execution-context.ts:113-125` — `executionMode?` + `usageAccumulator?`
  - `src/config/env.ts:23` — `HARNESS_MAX_EXECUTION_TIME_MS`; `:40` — `LLM_REQUEST_TIMEOUT_MS`
  - `src/config/harness-config.ts:17-21` — `harness.maxExecutionTimeMs`
  - `src/integration/llm-gateway.ts:60-77` — `LLMRequestOptions` (sem `signal`)
  - `src/integration/llm/usage-decorator.ts:27-29` — `UsageCallback` (recebe `meta`);
    `:37-50` — `complete`; `:52-61` — streaming pass-through sem somar
  - `src/observability/cost-calculator.ts:38-54` — `calculateCostCents`; `:45-51` — unknown→0
  - `src/integration/llm/adapters/{openai.adapter.ts:114,gemini.adapter.ts:126,anthropic.adapter.ts:124}`
    — `AbortSignal.timeout(this.timeoutMs)` self-cap (30s)
  - `package.json:73` — `p-timeout@^6.1.4` (dep presente, não importada pelo handler)
  - `src/integration/bullmq-consumer.ts:17-34` — `Worker` **sem** `attempts`/`backoff`; `:28`
    — `throw err` incondicional (NÃO inspeciona `retryable`); retry definido pelo producer
  - `src/bootstrap/shutdown.ts:69-70` — SIGTERM/SIGINT → `stopConsumer()`; `bullmq-consumer.ts:48`
    — `worker.close()` (drain, sem `force`); **nenhum** grace-timeout em volta (§4.12 / §8 OQ 6)
  - `src/observability/spans.ts:11-26` — `withSpan`/`setAttribute`/`recordException` (única
    primitiva de telemetria; **não há** counters/histograms → §4.11 usa span attrs + logs Pino)
  - **Dead-letter:** `grep dead-letter|DLQ src/` = **0 hits** (CLAUDE.md: "v2 vai pra dead-letter")
  - `src/observability/cost-calculator.ts:53` — `Math.ceil` **por chamada** (over-count ao somar, §4.5)
- **Testes:**
  - `tests/unit/runtime/execution-handler.flow.test.ts` (mocks `vi`, end-to-end `:119-266`)
  - `tests/unit/runtime/execution-payload.test.ts`
  - `tests/unit/integration/llm/usage-decorator.test.ts`
  - `tests/unit/observability/cost-calculator.test.ts`
  - `tests/integration/{execution-handler,usage-tracker}.integration.test.ts` (RUN_INTEGRATION)
- **NÃO tocados (Option A):** `LLMGateway`/`LLMRequestOptions` interface, os 5 adapters,
  retry/circuit-breaker/credential-pool decorators, os 5 reasoning engines, `ToolExecutor`
  (`reasoning/engine.ts:91-96`).
- **Specs relacionadas:**
  - `2026-06-02-idempotency-key-full-threading-design.md` (§4.4 — `/complete` por desfecho;
    o abort reusa o **único** call-site de erro pra não double-complete)
