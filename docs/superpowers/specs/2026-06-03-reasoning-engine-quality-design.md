# Reasoning-Engine Quality Fixes (Reflexion learning · escalated-engine telemetry · ReWOO parallel waves) — Design

> **Spec ID:** `2026-06-03-reasoning-engine-quality-design`
> **Status:** Draft — pendente review pelo founder
> **Autor:** Claude (Opus 4.8, AI Engineer) com instruções do founder em 2026-06-03
> **Escopo:** bevox-harness `src/reasoning/` — 3 audit findings de qualidade dos engines: `a-reasoning-01` (Reflexion learning no-op), `a-reasoning-02` (telemetria cega após escalation), `a-reasoning-03` (ReWOO parallel-waves dead-code)
> **Estimate:** 14h (3 phases — R01 4h, R02 6h, R03 4h)
> **Issue:** bernardTavares/bevox-harness (a-reasoning-01 / -02 / -03; abrir issue umbrella ou 3 issues)

> **NB (verificação 2026-06-03):** Todas as line refs abaixo foram **re-checadas
> contra o código vivo** (a auditoria original precede os merges). O branch
> assumido para implementação é `origin/main` (este worktree está em
> `test/execution-handler-coverage-uplift`; **branch-from-origin/main**). Novos
> testes vão SÓ em `tests/**/*.test.ts` — o `vitest.config.ts` (`include:
> ['tests/**/*.test.ts']`) NÃO roda os testes co-locados em `src/`
> (anomalia pré-existente: `src/runtime/context-wiring.test.ts` + 9 em
> `src/context/` — **não replicar**).
>
> **NB (revisão adversarial 2026-06-03):** Este spec passou por uma 2ª revisão
> adversarial contra o código vivo. Line refs e os hooks propostos confirmados.
> CORREÇÕES aplicadas: (1) **R03 reachability** — escalate-to-rewoo NÃO dispara
> de uma run React pura (plano React é 1-step; o claim "dispara hoje" era falso);
> só via React→plan-execute→rewoo. R03 vira candidato a corte de escopo (§8 OQ1).
> (2) **R02 double-wrap** — o guard ingênuo do spec original deixava a telemetria
> de reflexão MORTA p/ o scheduler (que já entra `ReflexionWrapper(React)`);
> corrigido para emitir/empilhar a cadeia INDEPENDENTE do wrap, e documentado o
> aninhamento multiplicativo de retries que o `wrap-reflexion` sem-`continue`
> causa hoje. (3) **R01** — confirmado que o canal `doctrine` chega ao modelo
> (`LlmClientBridge:795`), logo o fix NÃO é outro no-op. (4) **R03 dependsOn** —
> `executeWaves` honra ORDEM, não fluxo de dados entre steps (limitação nova em
> §8 / OQ6).

## §1. Context

O surface agent loop (`runSurfaceAgentLoop`, `src/runtime/execution-handler.ts:834-968`)
é o orquestrador único de raciocínio para o `scheduler` (o único surface agent).
Ele:

1. Constrói o engine via `strategyRouter.build(agent, agentContext)` (`:849`).
2. Planeja (`engine.plan`, `:850`).
3. Loopa enquanto `engine.shouldContinue` (`:854`): cada step roda dentro de
   `withSpan("reasoning.step", { "engine.type": engine.strategy, ... }, () => engine.step(...))`
   (`:895-904`), observa (`:906`), e avalia escalation via
   `stepEvaluator.evaluate(allObservations, plan, escalationConfig)` (`:910`).
4. Na escalation MUTA a var local `engine`. **DUAS formas distintas** (importante
   p/ R02):
   - **`escalate-to-plan-execute` (`:923-942`) e `escalate-to-rewoo` (`:943-960`)**:
     trocam o engine, EMITEM `engine_strategy`, re-planejam (`:936`/`:956`),
     `engine.reset?.()` (`:940`/`:958`), zeram `stepIndex`, e dão `continue`.
   - **`wrap-reflexion` (`:921-922`)**: SÓ faz `engine = new ReflexionWrapper(...)`.
     NÃO emite `engine_strategy`, NÃO re-planeja, NÃO reseta, NÃO dá `continue` —
     **cai em `stepIndex++` (`:964`)** e segue o loop. Como Rule 1 do
     StepEvaluator (`:49`) re-dispara a cada step que falha, falhas repetidas
     re-embrulham (aninhamento). Ver §2/§4.2.
5. **RETORNA APENAS `Observation[]`** (`:967`) — a instância `engine` escalada é
   local e descartada.

A config de escalation do scheduler (`src/agents/surface/scheduler.agent.ts:15-23`)
é `{ stepThreshold: 3, escalateTo: "plan-execute", parallelThreshold: 2, onFailure: "reflexion" }`.
Status de cada área: reflexion-wrap dispara em falha (LIVE, e o engine JÁ entra
embrulhado — ver §4.2); plan-execute em >3 steps (LIVE); **escalate-to-rewoo NÃO
dispara de uma run React pura** (o plano React é 1-step, então Rule 2 nunca atinge
≥2 independentes a partir de React — só via cadeia React→plan-execute→rewoo;
correção de reachability em §2 a-reasoning-03).

Detalhe arquitetural relevante: o `strategyRouter.build` **já embrulha** o engine
num `ReflexionWrapper` quando `escalation.onFailure === "reflexion"`
(`src/reasoning/strategy-router.ts:79-81`). Como o scheduler tem `onFailure:
"reflexion"`, o engine inicial do scheduler **já é um `ReflexionWrapper(ReactEngine)`**
desde o `build`. (Isto importa para R01 e R02 — ver §4.)

## §2. Problem statement

### a-reasoning-01 — Reflexion "learning" é um no-op

`ReflexionWrapper.step` (`src/reasoning/reflexion.ts:93-124`): na falha, o retry
loop (`:107-117`) chama `_evaluateFailure` (`:153-182`) — uma **micro-call de LLM
real** que retorna um `learnedContext: string` — e depois `augmentContext`
(`:188-202`) devolve uma cópia rasa do context com
`reflexionNotes: [...existing, learnedContext]` anexado via cast
`as unknown as object` (`:200`). O retry re-roda `tryStep` com o context aumentado
(`:113`).

**GAP:** **NENHUM engine LÊ `reflexionNotes`.** Grep confirma que as únicas
referências são (a) dentro de `reflexion.ts` (o writer) e (b) o teste que assere
a escrita (`tests/unit/reasoning/reflexion.test.ts:196-231`). `ReactEngine.step`
(`src/reasoning/react.ts:70-164`) monta o prompt de `plan.goal`+tools
(`buildSystemPrompt`, `:281-304`) e só passa `context.systemPrompt` como `doctrine`
(`:104`); nunca toca `reflexionNotes`. Idem `rewoo.ts`, `plan-execute.ts`,
`direct.ts`. Resultado: o insight aprendido é **computado, custa uma chamada de
LLM, é escrito num campo que ninguém lê, e o retry re-roda IDÊNTICO ao 1º attempt**
→ "learning" é um no-op genuíno. O campo nem está em `AgentExecutionContext`
(`src/agents/execution-context.ts:68-167`) — só existe via cast inseguro.

**Intenção (não obsoleto):** O doc-comment da classe (`reflexion.ts:29-37`) diz
explicitamente "learnedContext is injected into the context's reflexionNotes /
The step is retried ... with the enriched context". `augmentContext` existe e é
exercitado por teste. **Só falta o reader no prompt path.** É feature meio-cabeada
(bug a completar), não código obsoleto.

### a-reasoning-02 — Telemetria cega após escalation

Após uma escalation automática **é impossível, só pela telemetria, saber qual
engine de fato executou/sintetizou.** Quatro causas:

1. **Span per-step carimba `engine.type` no INÍCIO do step** (`:898`, valor =
   `engine.strategy` antes da avaliação de escalation no fim do mesmo step,
   `:912-961`). Uma escalation no fim do step N só aparece no span do step N+1 —
   e para o ÚLTIMO step antes da terminação **não há span seguinte**.

2. **`synthesize` NÃO usa o engine escalado do loop.** O main path **reconstrói
   um engine FRESCO** via `strategyRouter.build` (`:1938`) e chama
   `engine.synthesize(observations, finalPlan, ...)` (`:1945-1949`). O Model-C
   path faz o rebuild+synthesize idêntico (`:498` / `:504-508`). Logo o
   `agentResponse.strategy` reportado ao backend é **SEMPRE o default do agent**
   (`"react"` p/ scheduler), nunca o engine escalado. (`escalated` é hardcoded
   `false` em `react.ts:272`/`rewoo.ts:267`/`direct.ts:171`; só `plan-execute.ts:359`
   o seta de `replanOccurred` — que é replan INTRA-engine, não escalation
   CROSS-engine.)

3. **`wrap-reflexion` não emite `engine_strategy` E aninha wrappers.** O
   `streamCallback` `engine_strategy` event é emitido nas branches plan-execute
   (`:925-934`) e rewoo (`:945-954`), mas a branch `wrap-reflexion` (`:921-922`)
   **não emite nada**. E mesmo os que emitem só disparam quando streaming está
   ligado — **nunca persistidos a um span/trace**. **Pior (descoberto na revisão
   2026-06-03):** wrap-reflexion não dá `continue` → cai em `stepIndex++` e o loop
   continua; como Rule 1 do StepEvaluator (`step-evaluator.ts:49`) re-dispara a
   cada step que falha, falhas sucessivas **aninham `ReflexionWrapper` sobre
   `ReflexionWrapper`** (retries multiplicativos). O fix do R02 deve corrigir AMBOS
   — telemetria E aninhamento — ver §4.2 NB double-wrap.

4. **O loop span `execution.surface.loop` (`:1909-1931`)** registra só
   `reasoning.engine` (= default do agent, `:1913`) + `reasoning.steps` (`:1928`).
   Não há atributo do strategy final/escalado nem da cadeia de escalation.

**NET:** o `/complete` reporta `strategy` errado (sempre o default) e o trace não
distingue uma run escalada. **Intenção (não obsoleto):** observabilidade da
escalation é meta declarada (eventos `engine_strategy`, o campo `escalated` em
`AgentResponse`, o `plan-execute` setando-o). A fiação está incompleta (bug).

### a-reasoning-03 — ReWOO parallel-waves é dead-code

`ReWOOEngine.executeWaves` (`src/reasoning/rewoo.ts:280-314`) + `buildWaves`
topo-sort (`:332-357`) + `executeParallel` chunked-`Promise.all` (`:362-392`) está
totalmente implementado e **unit-testado** (`tests/unit/reasoning/rewoo.test.ts:172-246`:
paralelismo + ordem de dependência + chunking + stop-signal).

**GAP:** **zero callers em `src/`** (grep: só a def `:280` + a auto-referência no
doc-comment `:114`). A branch escalate-to-rewoo (`:943-960`) troca
`engine = new ReWOOEngine()` e então dirige o engine pelo **loop sequencial
genérico** (`engine.step(plan, stepIndex, ...)` em `:903`, `stepIndex++` em `:964`),
que executa por `stepIndex` ascendente e **IGNORA `dependsOn` por completo**. Logo
ReWOO, quando alcançado, **nunca paraleliza e nunca honra o grafo de dependências**
— a razão-de-ser inteira (waves paralelas) é dead-code na camada de orquestração.

**Reachability (CORRIGIDO 2026-06-03 — claim original era falso):** A branch
escalate-to-rewoo **NÃO dispara diretamente de uma run React** apesar do
`parallelThreshold: 2`. Motivo: o engine default do scheduler é `ReactEngine`,
cujo `plan()` retorna SEMPRE um plano de **1 step**
(`react.ts:61` `steps: [{ index: 0, description: "react-loop" }]`), e o loop só
re-planeja nas branches de escalation (`:936`/`:956`) — nunca para o React
rodando. StepEvaluator Rule 2 (`step-evaluator.ts:60`) exige
`countIndependentRemainingSteps(plan) >= 2`; um plano React de 1 step dá no
máximo 1. Logo **escalate-to-rewoo é alcançável SÓ via cadeia
React→plan-execute→rewoo**: depois que `escalate-to-plan-execute`
(`:923-942`, disparada por `>3` steps) re-planeja para um plano MULTI-step com
≥2 ramos independentes, a próxima avaliação PODE então cair em Rule 2. É um path
real e alcançável, mas **mais raro do que "dispara hoje em qualquer run"** —
exige primeiro o threshold de step-count. (Quando alcançado, roda sequencial e
quebrado — o defeito permanece.)

**Decisão wire-vs-remove (explícita):** **WIRE.** O class-doc (`rewoo.ts:29-40`) e
o step()-doc (`:112-115` "In practice, ReWOOEngine executes steps via
_executeWaves()") afirmam que waves são o path primário; `executeWaves` está
implementado + testado; a branch É alcançável (via plan-execute, acima).
Remover (R03-C) jogaria fora capacidade construída e testada e contradiz a
intenção. Recomenda-se WIRE, não DELETE — ver §3 e §8 OQ1. **NB:** dado que o
path é mais raro do que se assumiu, a urgência relativa de R03 vs R01/R02 cai;
se o founder não quiser ReWOO no piloto, R03-C (remover) fica mais defensável
do que o spec original sugeria — ver §8 OQ1.

## §3. Goals & non-goals

**Goals:**

- **R01:** Fazer a reflexão alimentar de fato o retry. Formalizar
  `reflexionNotes?: string[]` em `AgentExecutionContext` (removendo o cast
  inseguro), e fazer `ReactEngine.step` **ler** as notes e prependê-las ao
  prompt de sistema (doctrine) do retry. Teste prova que o retry recebe a note.
- **R02:** Emitir telemetria que identifica o engine efetivo após escalation:
  (a) `runSurfaceAgentLoop` retorna o engine final (+ flag `escalated` + cadeia);
  (b) synthesis (main `:1938` e Model-C `:498`) usa esse engine, não um rebuild;
  (c) loop span (`:1909`) carimba `reasoning.final_strategy` + `reasoning.escalated`
  + `reasoning.escalation_chain`; (d) `engine_strategy` é emitido também na branch
  wrap-reflexion para paridade. Backend passa a receber `strategy`/`escalated`
  reais.
- **R03:** Dirigir ReWOO pela `executeWaves` (já testada) na branch
  escalate-to-rewoo, honrando `dependsOn` + paralelismo, com os gates J8
  (deadline `:870-879`) e J9 (cost-ceiling `:883-892`) aplicados ao redor/dentro
  do path de waves, e `CyclicDependencyError` (`rewoo.ts:349/405`) capturado.
- Todos os 3 fixes mínimos e test-backed sob `tests/**`.

**Non-goals:**

- Não wirar reader de `reflexionNotes` em rewoo/plan-execute/direct neste spec
  (só ReactEngine — o default do scheduler). Follow-up (§8 OQ3).
- Não mudar a fórmula de idempotency-key nem o threading de `stepIndex`
  (track separado, `2026-06-02-idempotency-key-full-threading-design`).
- Não mexer no StepEvaluator rules além do que R03 exigir para honrar `dependsOn`.
- Não alterar o contrato `skills`/`account_denied_tools` (PERM-05).
- Não remover ReWOO (R03-C rejeitado — ver §2/§8 OQ1).

## §4. Architecture proposal

### 4.1 R01 — Reflexion lê as notes no prompt (R01-A, recomendado)

**Opções consideradas:**

| Opção | Resumo | Veredito |
|---|---|---|
| **R01-A** | Formalizar `reflexionNotes?: string[]` em `AgentExecutionContext`; `ReactEngine.step` prepende as notes à doctrine. Engines que não leem ficam byte-idênticos. | **RECOMENDADO** |
| R01-B | Passar `learnedContext` por param explícito na assinatura `step()`. | Rejeitado — breaking change em `engine.ts:117-124` + todo engine + call-site `:903` + todo stub de teste. Blast radius alto demais p/ o valor. |
| R01-C | Deletar a LLM call + `augmentContext`, manter retry cego. | Rejeitado — abandona capacidade documentada (`reflexion.ts:29-37`) e a config `onFailure:'reflexion'`. Reduz, não conserta. |

**Por que R01-A:** menor mudança end-to-end que torna o learning real; casa com a
intenção documentada; mantém engines não-leitores byte-idênticos; mata o cast
inseguro de `reflexion.ts:194/200`.

**Mudança 1 — `src/agents/execution-context.ts`** (adicionar campo opcional ao
interface, ~após `:128` `originalExecutionId`):

```typescript
  /**
   * a-reasoning-01 — Notas de reflexão acumuladas pelo ReflexionWrapper. Em
   * cada retry de falha, o wrapper anexa o `learnedContext` derivado pela
   * micro-call de _evaluateFailure. Engines que suportam reflexão (hoje:
   * ReactEngine) prependem estas notas à doctrine do prompt do retry, para
   * que a 2ª tentativa de fato se beneficie do insight. ABSENT (default) /
   * vazio → comportamento byte-idêntico ao 1º attempt. Engines que não leem
   * o campo (rewoo/plan-execute/direct hoje) o ignoram — follow-up.
   *
   * NB privacidade (harness-llm.md): as notas são derivadas de LLM sobre
   * mensagens de erro/saída de tool; ficam dentro da mesma postura de
   * redaction (nunca logar o prompt completo).
   */
  reflexionNotes?: string[];
```

**Mudança 2 — `src/reasoning/reflexion.ts`** — remover o cast inseguro em
`augmentContext` (`:188-202`), agora que o campo é tipado:

```typescript
  private augmentContext(
    context: AgentExecutionContext,
    learnedContext: string,
  ): AgentExecutionContext {
    const existingNotes = context.reflexionNotes ?? [];
    return {
      ...context,
      reflexionNotes: [...existingNotes, learnedContext],
    };
  }
```

**Mudança 3 — `src/reasoning/react.ts`** — `ReactEngine.step` prepende as notes à
doctrine. Hoje `:104` passa `doctrine: context.systemPrompt`. Trocar por uma
doctrine enriquecida (montada antes do `complete`, perto de `:85`):

```typescript
    // a-reasoning-01 — injeta notas de reflexão (se houver) na doctrine do
    // retry. Sem notas → byte-idêntico (doctrine = systemPrompt puro).
    const reflexionPreamble =
      context.reflexionNotes && context.reflexionNotes.length > 0
        ? `Prior attempt(s) failed. Apply these lessons:\n${context.reflexionNotes
            .map((n, i) => `${i + 1}. ${n}`)
            .join("\n")}\n\n`
        : "";
    const doctrine = reflexionPreamble
      ? `${reflexionPreamble}${context.systemPrompt ?? ""}`
      : context.systemPrompt;
    // ... dentro do complete():  doctrine,
```

`reflexion.ts` já carrega as notas adiante entre retries (`augmentContext` acumula
`[...existing, learnedContext]` e o retry passa `augmented` para `tryStep` `:113`),
então quando o `ReflexionWrapper` embrulha um `ReactEngine` o inner recebe o
context aumentado e lê as notas. Custo de tokens bounded (`maxRetries` default 2;
`maxTokens: 128` por reflexão).

**O `doctrine` ENRIQUECIDO de fato chega ao modelo (verificado 2026-06-03):** o
`LlmClientBridge.complete` (`src/runtime/execution-handler.ts:790-798`) injeta
`req.doctrine` como uma **system message LÍDER** (`:795`), ANTES da `req.system`
(o prompt React de goal+tools) e da `req.user`. Logo o preâmbulo de reflexão vira
conteúdo de sistema entregue ao provider — o retry NÃO é mais idêntico ao 1º
attempt. (Sem isto o fix seria outro no-op; a verificação confirma que o canal
`doctrine` é consumido, não apenas declarado no tipo `LlmCompletionRequest:19`.)
**NB teste:** o `FakeLlmClient.calls[n]` grava o `LlmCompletionRequest` (que TEM
`doctrine`), então o teste de R01 deve assertir `calls[retryIdx].doctrine`
contém a note — NÃO `.system` (que continua o prompt React puro). O hedge
"`.doctrine` (ou `.system`)" no §5 está resolvido: é `.doctrine`.

### 4.2 R02 — Synthesize usa o engine final + atributos de span (R02-A + eventos do R02-B)

**Opções consideradas:**

| Opção | Resumo | Veredito |
|---|---|---|
| **R02-A** | `runSurfaceAgentLoop` retorna `{ observations, engine, escalationChain }`; synthesis usa esse engine; loop span carimba `reasoning.final_strategy`/`escalated`/`escalation_chain`; emite `engine_strategy` em wrap-reflexion. | **RECOMENDADO** (com eventos do R02-B dobrados) |
| R02-B | Só telemetria: registrar cada decisão do StepEvaluator no loop span, sem mudar synthesis. | Parcial — conserta traces mas o `strategy`/`escalated` no `/complete` continuam errados (engine ainda é rebuild default). Dobrado dentro de R02-A. |
| R02-C | Carregar `escalationChain` no `AgentExecutionContext` e ler no synthesis. | Rejeitado como primário — side-channel mutável no context (mesmo smell de reflexionNotes); synthesis ainda roda num rebuild default → strategy literal continua errado. |

**Por que R02-A:** conserta a RAIZ (o `/complete strategy`/`escalated` errado) E o
ponto cego do trace. R02-B sozinho não conserta o contrato `/complete`.

**Mudança 1 — assinatura de retorno de `runSurfaceAgentLoop`
(`src/runtime/execution-handler.ts:834-968`):**

```typescript
export interface SurfaceLoopResult {
  observations: Observation[];
  /** Engine que de fato executou o último step (escalado ou não). */
  engine: ReasoningEngine;
  /** false se nunca escalou; true se houve qualquer swap. */
  escalated: boolean;
  /** Cadeia from→to: ["react", "plan-execute"] etc. 1 elemento = sem escalation. */
  escalationChain: string[];
}

export async function runSurfaceAgentLoop(...): Promise<SurfaceLoopResult> {
  // ... mesmo loop ...
  // inicializar: const escalationChain: string[] = [engine.strategy];
  // em CADA branch de escalation, após mutar `engine`:
  //   escalationChain.push(engine.strategy);
  // (wrap-reflexion: ReflexionWrapper.strategy delega ao inner — :53 — então
  //  empurrar um marcador explícito "reflexion" em vez de engine.strategy,
  //  senão a cadeia repete "react"; ver NB abaixo.)
  return {
    observations: allObservations,
    engine,
    escalated: escalationChain.length > 1,
    escalationChain,
  };
}
```

**NB ReflexionWrapper.strategy:** `reflexion.ts:53` delega `strategy` ao inner.
Isso é correto (reflexion é um wrapper, não um strategy literal de `AgentResponse`).
Para a cadeia ser legível, na branch wrap-reflexion empurrar a string literal
`"reflexion"` (não `engine.strategy`, que devolveria `"react"`). Para
`final_strategy` reportado ao backend, usar `engine.strategy` (delegado) — assim
`strategy` continua um valor válido do enum `AgentResponse["strategy"]` e
`escalated:true` carrega a semântica de "houve reflexão".

**Mudança 2 — emitir `engine_strategy` também em wrap-reflexion (`:921-922`)** —
hoje sem emit. A forma CORRETA do bloco (que NÃO re-embrulha um engine já-wrapped,
mas AINDA assim emite telemetria + cadeia) está detalhada no **NB double-wrap
abaixo** — o guard ingênuo de "só faz tudo se não-wrapped" deixaria a telemetria
MORTA para o scheduler (que já entra embrulhado). Ver NB.

**NB double-wrap (CORRIGIDO 2026-06-03 — o guard ingênuo torna a telemetria
MORTA para o único agent vivo):** o scheduler **já entra** com
`ReflexionWrapper(ReactEngine)` (via router `:79-81`, porque `onFailure:
'reflexion'`). Então na PRIMEIRA decisão `wrap-reflexion` o `engine` JÁ é um
`ReflexionWrapper`. Um guard ingênuo

```typescript
        if (!(engine instanceof ReflexionWrapper)) {   // ← ARMADILHA
          engine = new ReflexionWrapper({ inner: engine });
          escalationChain.push("reflexion");
          // ...emit...
        }
```

**pula o corpo inteiro** para o scheduler — nunca empurra `"reflexion"` na cadeia,
nunca emite `engine_strategy`. Resultado: a telemetria de reflexão que R02 quer
adicionar **jamais dispararia** para o único surface agent. Pior: hoje SEM guard,
falhas repetidas re-disparam Rule 1 (`step-evaluator.ts:49`) a cada step que
falha (a branch wrap-reflexion **não dá `continue`** — cai em `stepIndex++` `:964`),
então a cada falha um `new ReflexionWrapper` extra é aninhado, **multiplicando
`maxRetries` de forma não-intencional** (cada camada re-tenta `maxRetries` vezes
a inner, que por sua vez re-tenta — explosão multiplicativa de micro-calls de LLM).

**Decisão correta:** NÃO re-embrulhar (evita a explosão multiplicativa), MAS
emitir a telemetria + empurrar a cadeia INDEPENDENTE de já estar embrulhado.
Separar as duas responsabilidades:

```typescript
      if (decision.action === "wrap-reflexion") {
        // Só embrulha se ainda não houver wrapper (evita aninhamento
        // multiplicativo de retries). O scheduler JÁ entra embrulhado pelo
        // router, então normalmente NÃO re-embrulha.
        if (!(engine instanceof ReflexionWrapper)) {
          engine = new ReflexionWrapper({ inner: engine });
        }
        // Telemetria/cadeia disparam SEMPRE (mesmo já-embrulhado), senão a
        // observabilidade de reflexão fica morta p/ o scheduler — que é o
        // caso vivo. Empurra só uma vez por run para a cadeia não inflar com
        // N falhas repetidas (dedup: só empurra se o topo != "reflexion").
        if (escalationChain[escalationChain.length - 1] !== "reflexion") {
          escalationChain.push("reflexion");
        }
        if (agentContext.streamCallback) {
          try {
            await agentContext.streamCallback({
              type: "engine_strategy",
              payload: { from: fromStrategy, to: "reflexion", reason: decision.action },
            });
          } catch { /* best-effort */ }
        }
        // (sem `continue` — comportamento legado: cai em stepIndex++)
      }
```

(Mantém `retriesUsed` correto — um único wrapper acumula; ver §8 risco R02.)

> **NB semântica de `escalated`:** com esta correção, uma run do scheduler que
> SÓ acionou reflexão (engine final ainda é `ReflexionWrapper(React)`,
> `.strategy === "react"`) terá `escalationChain = ["react", "reflexion"]` →
> `escalated = chain.length > 1 = true`. Isto reporta `escalated: true` ao
> backend para runs que tecnicamente não trocaram de STRATEGY literal (só
> retentaram). É o comportamento DESEJADO (houve um evento de recuperação), mas
> é uma mudança de contrato observável — alinhar com §8 OQ2. Alternativa se o
> backend quiser `escalated` == "trocou de strategy literal": derivar
> `escalated` de `engine.strategy !== agentDef.reasoning.default` em vez de
> `chain.length > 1`. Decisão em §8 OQ2.

**Mudança 3 — synthesis usa o engine do loop (main path, `:1909-1949`).** Capturar
o resultado e usar `loopResult.engine` em vez de reconstruir:

```typescript
        const loopResult = await withSpan(
          "execution.surface.loop",
          { "agent.name": agentDef.name, "reasoning.engine": agentDef.reasoning?.default },
          async (loopSpan) => {
            const r = await runWithTimeout(
              runSurfaceAgentLoop(agentDef, input, agentContext, permittedTools, executeTool, traceCallback),
              config.harness.maxExecutionTimeMs / 2,
              `SurfaceAgent(${agentName})`,
            );
            loopSpan.setAttribute("reasoning.steps", r.observations.length);
            loopSpan.setAttribute("reasoning.final_strategy", r.engine.strategy);
            loopSpan.setAttribute("reasoning.escalated", r.escalated);
            loopSpan.setAttribute("reasoning.escalation_chain", r.escalationChain.join(">"));
            return r;
          },
        );
        const observations = loopResult.observations;
        // ... synthesize com o engine ESCALADO, não um rebuild:
        const engine = loopResult.engine;       // ← era strategyRouter.build(...) (:1938)
        const finalPlan = { goal: input, steps: [{ index: 0, description: "surface-execution" }], estimatedComplexity: "medium" as const };
        const remainingMs = Math.max(1, deadlineMs - Date.now());
        const agentResponse = await runWithTimeout(
          engine.synthesize(observations, finalPlan, agentContext),
          remainingMs, `Synthesize(${agentName})`,
        );
```

**Mudança 4 — Model-C path (`:491-508`) — MESMA troca** (risco §8: se só o main
path for tocado, Model-C silenciosamente mantém o bug):

```typescript
    const loopResult = await runWithTimeout(
      runSurfaceAgentLoop(agentDef, input, agentContext, permittedTools, executeTool),
      config.harness.maxExecutionTimeMs / 2, `ModelC-SurfaceAgent(${agentName})`,
    );
    const observations = loopResult.observations;
    const engine = loopResult.engine;           // ← era strategyRouter.build(...) (:498)
    // ... synthesize idêntico ...
```

`agentResponse.strategy`/`escalated` (lidos em `:519` Model-C e `:1971` main no
`buildCompletePayload`) passam a refletir o engine real. **Mudança de comportamento
visível ao backend** — ver §7/§8.

### 4.3 R03 — ReWOO via executeWaves na branch escalate-to-rewoo (R03-A, recomendado)

**Opções consideradas:**

| Opção | Resumo | Veredito |
|---|---|---|
| **R03-A** | Na branch escalate-to-rewoo, após `engine = new ReWOOEngine()` + plan, detectar ReWOO e chamar `engine.executeWaves(...)` em vez do loop sequencial; empurrar as observations em `allObservations`. Reusa 100% do código de waves testado. | **RECOMENDADO** |
| R03-B | Hook opcional `runAll?()` no interface `ReasoningEngine` (espelhando `reset?()`); orquestrador prefere `runAll` quando presente. | Adiável — mais limpo mas toca o interface; mais superfície de design que o piloto exige. Migrar para isto se um 2º batch-engine surgir. |
| R03-C | Remover ReWOO da auto-escalation + deletar executeWaves. | **Rejeitado COMO PRIMÁRIO, mas RE-AVALIAR** — joga fora capacidade construída/testada e contradiz `rewoo.ts:29-40`. PORÉM: o path é mais raro do que se assumiu (só via React→plan-execute→rewoo, NÃO direto de React — §2 reachability), nunca exercitado em prod, e o step dependente roda cego ao output do pré-requisito (§8 risco R03). Se o founder não tem caso de uso para ReWOO paralelo no piloto, R03-C é defensável — §8 OQ1. |

**Por que R03-A:** ativa o path paralelo já testado; localizado (não toca o
interface); reusa `executeWaves`/`buildWaves`/`executeParallel` sem reescrever.

**Mudança — branch escalate-to-rewoo (`:943-960`):** após construir e planejar o
ReWOOEngine, executar via waves dentro de um span próprio, e **NÃO** voltar ao
loop sequencial para esse engine. As waves rodam o plano inteiro de uma vez
(o `executeWaves` já tem o stop-check por wave, `rewoo.ts:293-294`), então após
elas a run de ReWOO está completa → break do while.

```typescript
      } else if (decision.action === "escalate-to-rewoo") {
        const rewoo = new ReWOOEngine();
        engine = rewoo;
        escalationChain.push(engine.strategy);
        if (agentContext.streamCallback) {
          try {
            await agentContext.streamCallback({
              type: "engine_strategy",
              payload: { from: fromStrategy, to: engine.strategy, reason: decision.action },
            });
          } catch { /* best-effort */ }
        }
        const remainingInput = `${input}\n\nCompleted so far:\n${allObservations.map((o) => o.summary).join("\n")}`;

        // J8 — gate de deadline ANTES de disparar waves (paralelo é caro).
        if (agentContext.deadlineMs != null && Date.now() >= agentContext.deadlineMs) {
          throw new ExecutionAbortError("wall_clock_timeout", `...`, false);
        }
        // J9 — gate de custo idem.
        if (agentContext.costCeilingCents != null &&
            (agentContext.costAccumulator?.costCents ?? 0) >= agentContext.costCeilingCents) {
          throw new ExecutionAbortError("cost_ceiling", `...`, false);
        }

        try {
          plan = await rewoo.plan(remainingInput, agentContext);
        } catch (err) {
          if (err instanceof CyclicDependencyError) {
            // plano cíclico → não escalar p/ ReWOO; tratar como abort recuperável
            // OU fallback (decidir; ver §8 OQ). Por ora: abort não-retryable.
            throw new ExecutionAbortError("invalid_plan", err.message, false);
          }
          throw err;
        }

        // a-reasoning-03 — path PARALELO real (executeWaves), honra a ORDEM de
        // dependsOn (não fluxo de dados entre steps — ver §8 risco R03).
        const waveObs = await withSpan(
          "reasoning.rewoo.waves",
          { "engine.type": engine.strategy, "plan.length": plan.steps?.length, "execution.id": agentContext.executionId },
          async () => rewoo.executeWaves(plan, tools, agentContext, executeTool, traceCallback),
        );
        allObservations.push(...waveObs);

        // J9 — re-check pós-waves (waves podem ter cruzado o teto).
        if (agentContext.costCeilingCents != null &&
            (agentContext.costAccumulator?.costCents ?? 0) >= agentContext.costCeilingCents) {
          throw new ExecutionAbortError("cost_ceiling", `...`, false);
        }
        break; // ReWOO roda o plano inteiro de uma vez → run completa.
      }
```

**Observações:**
- `executeWaves` chama `this.step(...)` internamente (`rewoo.ts:377`), que respeita
  o stop-signal por wave via `shouldContinue` (`:293`). Os gates J8/J9 ficam ANTES
  e DEPOIS das waves; gate por-wave fica de fora do piloto (waves são bounded pelo
  plano + `maxParallel`).
- `CyclicDependencyError` (`rewoo.ts:349/405`) hoje é inalcançável em prod (o path
  sequencial nunca chama `buildWaves`); com R03-A ele passa a ser alcançável →
  **deve ser capturado** (acima). Decisão fallback-vs-abort: §8 OQ.
- A a-reasoning-04 generation-stamping assume o loop sequencial (`engine.reset?.()`
  `:958` + `planGeneration`); o path de waves NÃO re-entra no while, então não há
  acumulação de history a corromper — não regride a-reasoning-04 (ver §8 risco R03).

## §5. Implementation plan

Branch-from `origin/main`. Ordem: R01 (isolado, menor risco) → R02 (toca retorno do
loop + 2 synthesis sites) → R03 (depende do `escalationChain`/retorno do R02).

### Phase 1 — R01 Reflexion learning (4h)

**Files:**
- `src/agents/execution-context.ts` — adicionar `reflexionNotes?: string[]` ao
  `AgentExecutionContext` (após `originalExecutionId`, ~`:128`).
- `src/reasoning/reflexion.ts` — `augmentContext` (`:188-202`): remover cast
  `as unknown as object`, usar campo tipado.
- `src/reasoning/react.ts` — `step` (`:85-105`): montar `reflexionPreamble` +
  doctrine enriquecida; passar `doctrine` enriquecida ao `complete` (`:104`).

**Testes (`tests/**`):**
- `tests/unit/reasoning/reflexion.test.ts` — estender:
  - o teste existente `:196-231` (escrita das notes + sem-mutação) continua válido;
  - NOVO: com `inner = new ReactEngine()` REAL + `FakeLlmClient` com 1ª resposta
    falha + reflexão `{learnedContext:'use param X'}` + 2ª resposta sucesso,
    assere `FakeLlmClient.calls[retryIdx].doctrine` do retry contém `'use param X'`
    (é `.doctrine`, não `.system` — confirmado §4.1: o ReAct prompt fica em
    `.system`, a doctrine enriquecida em `.doctrine`). **NB:** a 1ª chamada React
    falha, depois há a micro-call `_evaluateFailure` (que tem seu PRÓPRIO
    `system`/`user`, sem `doctrine` enriquecida), DEPOIS a chamada do retry React
    com a doctrine enriquecida. Indexar `calls` com cuidado: filtrar pela chamada
    cujo `.system` é o prompt React (contém "autonomous agent"), não a do
    failure-analyst;
  - NOVO: em sucesso no 1º attempt, `FakeLlmClient.calls` NÃO inclui a reflexão
    (nenhuma micro-call de `_evaluateFailure`).
- `tests/unit/reasoning/react.test.ts` (criar se não existir) — `step` com
  `context.reflexionNotes = ['note A']` → `doctrine` contém `'note A'`; sem notes →
  `doctrine === context.systemPrompt` (byte-idêntico).

### Phase 2 — R02 escalated-engine telemetry (6h)

**Files:**
- `src/runtime/execution-handler.ts`:
  - definir `interface SurfaceLoopResult`; mudar retorno de `runSurfaceAgentLoop`
    (`:834/:967`) para `SurfaceLoopResult`; acumular `escalationChain`; guard
    de double-wrap em wrap-reflexion (`:921-922`); emitir `engine_strategy` em
    wrap-reflexion.
  - main path (`:1909-1949`): capturar `loopResult`; carimbar
    `reasoning.final_strategy`/`escalated`/`escalation_chain` no `loopSpan`; usar
    `loopResult.engine` no synthesize.
  - Model-C path (`:491-508`): MESMA captura + uso de `loopResult.engine`
    (**obrigatório** — senão Model-C mantém o bug).

**Testes (`tests/**`):**
- `tests/unit/runtime/surface-loop-escalation.test.ts` (NOVO) — exercitar
  `runSurfaceAgentLoop` direto (é exportado, `:834`) com um stub agent cuja
  escalation força um swap (ex.: `onFailure:'reflexion'` + step que falha; ou
  `stepThreshold:1` + observations stub p/ plan-execute):
  - assere `result.escalated === true`, `result.escalationChain` esperado,
    `result.engine.strategy` = engine escalado;
  - injeta `streamCallback` spy → assere evento `engine_strategy` dispara
    INCLUSIVE na branch wrap-reflexion;
  - assere que double-wrap NÃO ocorre (engine final é UM ReflexionWrapper).
- `tests/unit/runtime/surface-loop-span.test.ts` (NOVO) — injetar fake `Tracer`
  no `withSpan` (param injetável, `spans.ts:15`) OU spy em `span.setAttribute`;
  assere `reasoning.final_strategy`/`escalated`/`escalation_chain` setados após
  escalation. (Se mais simples, testar via o helper que monta o loop span.)

### Phase 3 — R03 ReWOO parallel waves (4h)

**Files:**
- `src/runtime/execution-handler.ts` — branch escalate-to-rewoo (`:943-960`):
  trocar o drive sequencial pela chamada `executeWaves` dentro de span
  `reasoning.rewoo.waves`, com gates J8/J9 antes/depois, captura de
  `CyclicDependencyError`, e `break` do while; import de `CyclicDependencyError`
  de `../reasoning/rewoo.js`.

**Testes (`tests/**`):**
- `tests/unit/reasoning/rewoo.test.ts` — os testes de `executeWaves` existentes
  (`:172-246`) cobrem paralelismo/ordem/chunking; reusar.
- `tests/unit/runtime/surface-loop-rewoo.test.ts` (NOVO) — orquestração.
  **NB de setup (reachability):** NÃO dá para forçar escalate-to-rewoo só
  setando `parallelThreshold` num agent React — o plano React é 1-step e Rule 2
  nunca atinge ≥2 independentes (§2 a-reasoning-03). Para exercitar a branch é
  preciso OU (a) um stub agent cujo `reasoning.default` seja `plan-execute` com
  um plano multi-step de ≥2 ramos independentes (dispara Rule 2 direto), OU (b)
  encenar a cadeia React→plan-execute→rewoo (mais frágil). Recomenda-se (a) para
  o teste de orquestração ser determinístico. Rastrear ordem de chamadas pelo fake
  `executeTool`, assere:
  - steps dependentes executam DEPOIS dos pré-requisitos (prova ORDEM de
    `dependsOn` honrada — o path sequencial atual FALHA isto). **NÃO** assertir
    fluxo de dados entre steps (não implementado — §8 risco R03 / OQ6);
  - steps independentes na mesma wave;
  - J8/J9: setar `deadlineMs`/`costCeilingCents` cruzados → `ExecutionAbortError`;
  - plano cíclico → `CyclicDependencyError` capturado → desfecho esperado.

> **Dependência de build (flag, §8):** o suite vitest pode não rodar em CI até
> `j-build-01` (binding rolldown faltando) e `j-build-02` (prettier red) serem
> resolvidos. Verificar localmente (`npm run test -- tests/unit/reasoning
> tests/unit/runtime`) e sinalizar no PR.

## §6. Testing strategy

Os três fixes são testáveis SEM LLM real, com o harness existente: `FakeLlmClient`
(`tests/fakes/llm-client.fake.ts` — fila de `LlmCompletionResponse|Error`, grava
`.calls`) + `makeContext`/`llmJson`/`llmText` (`tests/unit/reasoning/_helpers.ts`).
Novos testes vão SÓ em `tests/**/*.test.ts`.

> **NB helper:** `makeContext` (`_helpers.ts:4-21`) ainda usa `accountId: 1` (campo
> legado, não em `AgentExecutionContext`). Não bloqueia (objeto anotado), mas ao
> adicionar `reflexionNotes` ao context, novos testes devem setar via spread
> (`{...makeContext(llm), reflexionNotes: [...]}`) — campo opcional, compila.

**R01:** unit em `reflexion.test.ts` + `react.test.ts` (ver §5 Phase 1). Pontos
críticos: (a) retry RECEBE a note na doctrine (com `ReactEngine` real); (b) sucesso
no 1º attempt → zero reflexão; (c) original context não mutado (já coberto
`:229-231`).

**R02:** unit em `tests/unit/runtime/` exercitando `runSurfaceAgentLoop` exportado.
`withSpan` aceita `tracer` injetável (`spans.ts:15`) → fake tracer/recorder p/
assertir atributos. `streamCallback` spy p/ `engine_strategy` (incl. wrap-reflexion).
Assert: `result.engine`/`escalated`/`escalationChain` corretos; `agentResponse.strategy`
!= default após escalation (via teste de fluxo que chama o synthesis path, ou
unit do retorno + um teste fino do site de synthesis).

**R03:** unit `executeWaves` (reuso `rewoo.test.ts:172-246`) + orquestração nova em
`tests/unit/runtime/`. Rastrear ordem via fake `executeTool`; provar `dependsOn`
honrado (o que o path sequencial atual NÃO faz); provar J8/J9 abortam; provar
`CyclicDependencyError` capturado.

**Regressão:** path não-escalado (scheduler em ≤3 steps sem falha) deve ficar
byte-idêntico — `reflexionNotes` ausente, `escalationChain = ["react"]`,
`escalated=false`, synthesis usa o engine (ReflexionWrapper(React)) cujo
`.strategy` = `"react"`. Confirmar `execution-handler.flow.test.ts` continua verde
com o novo tipo de retorno.

## §7. Migration & rollback

**Ativação gradual:**
1. **R01** — deploy isolado; sem `reflexionNotes` no context (default ausente) o
   comportamento é byte-idêntico; só runs que escalam para reflexão (falha de step)
   passam a injetar a note. Sem mudança de contrato externo.
2. **R02** — muda o tipo de retorno de `runSurfaceAgentLoop` (interno) + os 2
   synthesis sites. **Mudança visível ao backend:** `/complete.strategy` e
   `.escalated` passam a refletir o engine REAL (antes sempre `"react"`/`false`).
   Isto é a CORREÇÃO, mas é observável — alinhar com o owner do contrato
   `/complete` (§8 OQ2). Spans novos são aditivos (atributos extras, não-breaking).
3. **R03** — escalate-to-rewoo passa de sequencial para PARALELO. **Mudança de
   comportamento de execução:** tools podem disparar concorrentemente (ver §8
   risco R03 — idempotency/side-effects). Gate atrás de revisão de segurança das
   mutation tools.

**Rollback:**
- R01: reverter `react.ts` (doctrine volta a `systemPrompt` puro) + remover campo;
  `reflexion.ts` volta ao cast. Sem dado destruído.
- R02: reverter o tipo de retorno p/ `Observation[]` + os 2 synthesis sites p/
  `strategyRouter.build`. `/complete` volta a reportar o default. Spans extras somem.
- R03: reverter a branch escalate-to-rewoo p/ o drive sequencial. ReWOO volta a
  rodar sequencial (quebrado, mas status quo). Sem dado destruído.

Cada phase é revertível de forma independente (R03 depende do retorno do R02 —
reverter R02 exige reverter R03 antes).

## §8. Risks & open questions

### Riscos

- **Cross-cutting (R02):** `execution-handler.ts` é grande e quente, com DOIS
  synthesis sites (main `:1938` + Model-C `:498`). **Qualquer mudança deve tocar
  AMBOS** ou Model-C mantém o bug silenciosamente. Teste de fluxo deve cobrir os
  dois paths.
- **Build/CI:** o suite vitest pode não iniciar em CI até `j-build-01`
  (`@rolldown/binding-linux-x64-gnu` faltando) + `j-build-02` (prettier 146 files
  red). Verificar local; sinalizar no PR.
- **R01:** `reflexionNotes` toca um tipo amplamente importado — campo OPCIONAL,
  então `makeContext` e contexts de teste continuam compilando. Tokens de retry
  sobem (bounded: `maxRetries` 2 × `maxTokens` 128). Risco PII: notas são
  LLM-derived de erro/saída de tool; manter dentro da postura de redaction
  (`harness-llm.md`: nunca logar prompt completo) — não logar a doctrine montada.
- **R02:** mudar o retorno de `runSurfaceAgentLoop` ripple p/ Model-C (`:491`) +
  `execution-handler.flow.test.ts`. Sintetizar com o engine ESCALADO (ex.:
  ReWOO/PlanExecute) em vez do default pode mudar o TEXTO da resposta vs hoje —
  isso é a CORREÇÃO, mas é mudança visível ao backend; declarar. `ReflexionWrapper.synthesize`
  injeta `retriesUsed` (`:80-87`) — preservar quando o engine final é wrapper.
- **R02 — double-wrap / explosão de retries (CORRIGIDO, ver §4.2 NB):** a branch
  wrap-reflexion **não dá `continue`** (cai em `stepIndex++` `:964`), e
  StepEvaluator Rule 1 (`step-evaluator.ts:49`) re-dispara a CADA step que falha.
  HOJE, sem guard, cada falha aninha um `new ReflexionWrapper` → retries
  MULTIPLICATIVOS (camada externa re-tenta `maxRetries`× a interna, que re-tenta
  de novo). O fix R02 deve embrulhar **no máximo uma vez** (guard `instanceof`)
  MAS emitir telemetria/cadeia INDEPENDENTE de já estar embrulhado — senão a
  observabilidade fica morta para o scheduler (que já entra
  `ReflexionWrapper(React)` via router `:79-81`). O guard ingênuo "tudo-ou-nada"
  do spec original estava ERRADO; ver §4.2 NB double-wrap para a forma correta.
- **R02 — `escalated` semântica (ver §4.2 NB final + §8 OQ2):** `escalationChain.length > 1`
  reporta `escalated: true` para runs que SÓ retentaram via reflexão (strategy
  literal continua `"react"`). Pode ser desejado (houve recuperação) ou não
  (backend pode esperar "trocou de strategy"). Decisão em OQ2.
- **R03:** rotear ReWOO por `executeWaves` muda execução de sequencial p/ PARALELA
  — tools de mutação side-effecting (create/cancel/reschedule) poderiam disparar
  concorrentemente. **Confirmar:** (a) a derivação de idempotency-key (ADR-023,
  `sha256(execution_id:step_index:tool_name)`) permanece única por step sob
  paralelismo — note que no path de waves o `step_index` vem do `PlanStep.index`,
  não de um contador sequencial, então deve ficar único; (b) gates J8/J9 aplicados
  ao redor das waves (per-wave gate fica fora do piloto). `buildWaves` lança
  `CyclicDependencyError` (`:349`) em ciclo — orquestrador DEVE capturar (hoje
  inalcançável em prod). a-reasoning-04 generation-stamping assume o loop
  sequencial; o path de waves dá `break` e não re-entra no while, então não
  acumula history → não regride a-reasoning-04.
- **R03 — `dependsOn` honra ORDEM, não DADOS (limitação verificada
  2026-06-03):** `executeWaves`/`buildWaves` ordena waves por `dependsOn` (step
  dependente roda numa wave POSTERIOR), mas `ReWOOEngine.step` (`rewoo.ts:116-209`)
  monta o prompt SÓ de `currentStep.description` + `plan.goal` + tools — **não
  injeta as observations/outputs dos pré-requisitos** no contexto do step
  dependente. Ou seja: o step dependente roda DEPOIS, mas CEGO ao resultado do
  pré-requisito (ReWOO clássico passa "evidence" do planner adiante; esta
  implementação não). O teste de orquestração de R03 deve assertir SÓ a ORDEM
  (dependente após pré-requisito), não fluxo de dados — senão dá falso-verde. Se
  o piloto precisar de fluxo de dados real entre steps, é follow-up separado (não
  neste spec) — adicionar §8 OQ6.
- **R03 — stop-signal pré-waves não curto-circuita:** `executeWaves` checa
  `shouldContinue` contra SUA própria lista local de observations (começa vazia,
  `rewoo.ts:287/293`), não contra o `allObservations` já acumulado no loop antes
  da escalation. Um stop-signal numa observation PRÉ-waves não impede a 1ª wave de
  rodar. Aceitável no piloto (escalation só ocorre se a run ainda não parou), mas
  declarar.

### Open questions

1. **ReWOO no piloto? (CLAIM DE URGÊNCIA CORRIGIDO 2026-06-03)** escalate-to-rewoo
   **NÃO dispara de uma run React pura** apesar do `parallelThreshold:2` — o plano
   React é 1-step, então Rule 2 (`>= 2` independentes) nunca atinge a partir de
   React (ver §2 a-reasoning-03 "Reachability"). É alcançável SÓ via cadeia
   React→plan-execute→rewoo (após o step-count threshold re-planejar para
   multi-step). Logo a urgência é MENOR do que o spec original alegava. Decisão
   real: (a) se ReWOO paralelo é desejado no piloto → WIRE (R03-A); (b) se NÃO →
   R03-C (remover executeWaves + a branch) fica MAIS defensável agora que sabemos
   que o path é raro e nunca exercitado em prod. **Recomendação atualizada:**
   confirmar com o founder se há QUALQUER caso de uso para ReWOO paralelo no
   piloto antes de gastar 4h em R03; se não, R03-C (delete) é a jogada honesta e
   reduz superfície. R03 é o candidato mais forte a CORTAR do escopo deste spec.
2. **Contrato `/complete` (R02) — incl. semântica de `escalated`:** o backend deve
   receber só `strategy` final + `escalated` bool, ou a cadeia de escalation
   completa? E `escalated` deve significar "houve QUALQUER swap/reflexão"
   (`chain.length > 1` — o que marca `true` em runs que só retentaram via
   reflexão, strategy literal ainda `"react"`) OU "trocou de STRATEGY literal"
   (`engine.strategy !== reasoning.default`)? As duas semânticas divergem
   exatamente no caso reflexion-only (o caso mais COMUM do scheduler, dado
   `onFailure:'reflexion'`). Confirmar com o owner do contrato de callbacks
   (`harness-payload.md`: campos obrigatórios `response_text`, `sentiment`,
   `strategy`, `usage`). Por ora: `strategy`+`escalated` (`chain.length>1`);
   cadeia fica no span. Ver §4.2 NB final.
3. **Escopo das `reflexionNotes`:** propagar além do step que falhou (loop inteiro)
   ou ficar step-scoped como hoje? Este spec mantém step-scoped (mínimo). Follow-up
   se o founder quiser memória de reflexão por execução.
4. **ReWOO + plano cíclico:** em `CyclicDependencyError`, abortar (não-retryable,
   como proposto) ou cair num fallback sequencial? Proposto: abort não-retryable
   (plano cíclico é determinístico). Confirmar.
5. **Reader de reflexionNotes em outros engines:** wirar em
   rewoo/plan-execute/direct é follow-up; o scheduler usa React como default,
   então React-only cobre o caso vivo. Confirmar que nenhum agent usa default
   `plan-execute`/`rewoo` hoje (scheduler é o único surface agent → OK).
   **NB importante p/ R01 + R02 juntos:** quando o scheduler escala para
   plan-execute/rewoo E houve reflexão antes, o engine escalado **não lê
   `reflexionNotes`** (só React lê). Não é regressão (hoje ninguém lê), mas
   significa que o "learning" do R01 só beneficia o engine React — se a run
   escalar para plan-execute, as notes acumuladas são silenciosamente ignoradas
   pelo novo engine. Aceitável no piloto; declarar.
6. **Fluxo de dados entre steps ReWOO (R03):** `executeWaves` honra a ORDEM de
   `dependsOn` mas o step dependente roda CEGO ao output do pré-requisito
   (`rewoo.ts:116-209` monta prompt só de `description`+goal+tools; ver §8 risco
   R03). ReWOO clássico passa "evidence" do planner adiante. Se o piloto precisar
   de fluxo de dados real (step B usa o resultado de step A), é trabalho ADICIONAL
   fora deste spec — `executeWaves` "funcionando" não é suficiente. Confirmar se
   os casos de uso de scheduling precisam disso ou se ordenação pura basta.

## §9. Definition of done

- [ ] **Phase 1 (R01)** merged:
  - [ ] `reflexionNotes?: string[]` em `AgentExecutionContext`
  - [ ] `reflexion.ts:augmentContext` sem cast inseguro
  - [ ] `react.ts:step` lê notes → doctrine do retry
  - [ ] Testes: retry recebe a note (ReactEngine real); sucesso → zero reflexão;
        sem-mutação; sem notes → byte-idêntico
- [ ] **Phase 2 (R02)** merged:
  - [ ] `runSurfaceAgentLoop` retorna `SurfaceLoopResult` (engine + escalated + chain)
  - [ ] wrap-reflexion: embrulha NO MÁXIMO uma vez (guard `instanceof`, evita
        aninhamento multiplicativo) MAS emite `engine_strategy` + empurra cadeia
        INDEPENDENTE de já estar embrulhado (com dedup do topo da cadeia) — senão
        a telemetria fica morta p/ o scheduler que já entra wrapped (§4.2 NB)
  - [ ] main path synthesize usa `loopResult.engine` + loop span carimba
        `reasoning.final_strategy`/`escalated`/`escalation_chain`
  - [ ] **Model-C path synthesize usa `loopResult.engine`** (ambos os sites)
  - [ ] Testes: escalationChain/engine/escalated corretos; engine_strategy DISPARA
        na branch wrap-reflexion MESMO com engine já-wrapped; sem aninhamento
        multiplicativo (engine final é UM wrapper); span attrs setados;
        `/complete strategy`/`escalated` corretos pós-escalation (incl. caso
        reflexion-only: strategy=`react`, escalated por semântica de OQ2)
- [ ] **Phase 3 (R03 — CONFIRMAR ESCOPO via §8 OQ1 antes de implementar)** merged:
  - [ ] escalate-to-rewoo dirige `executeWaves` (não o loop sequencial)
  - [ ] gates J8/J9 antes/depois das waves; `CyclicDependencyError` capturado
  - [ ] Testes: setup via stub agent `default:'plan-execute'` multi-step (NÃO via
        React+parallelThreshold, que é inalcançável — §2 reachability); ORDEM de
        `dependsOn` honrada (não fluxo de dados); independentes na mesma wave;
        J8/J9 abortam; ciclo capturado
- [ ] Sem regressão em `execution-handler.flow.test.ts` + suite reasoning
- [ ] Code review aprovado (AI Engineer + Code Reviewer)
- [ ] Findings `a-reasoning-01/-02/-03` marcados resolvidos no doc de auditoria

## §10. References

- **Audit findings:** `a-reasoning-01` (Reflexion no-op), `a-reasoning-02`
  (escalated-engine telemetry), `a-reasoning-03` (ReWOO parallel-waves dead-code).
  Relacionado: `a-reasoning-04` (generation-stamping, já LANDED — engine.ts:24-33/63-70).
- **ADRs / regras:** ADR-006 (autonomy modes / executeOrPropose), ADR-023
  (idempotency-key), `harness-llm.md` (redaction), `harness-payload.md`
  (`/complete` contract).
- **Código fonte (verificado 2026-06-03 contra origin/main):**
  - `src/runtime/execution-handler.ts:834-968` — `runSurfaceAgentLoop` (retorno
    `Observation[]` `:967`; span step `:895-904`; escalation `:912-961`;
    wrap-reflexion sem emit E sem `continue` → cai em `stepIndex++` `:964`, logo
    re-dispara/aninha em falhas repetidas `:921-922`; plan-execute COM emit+continue
    `:923-942`; rewoo COM emit+continue `:943-960`; gates J8 `:870-879` /
    J9 `:883-892`)
  - `src/runtime/execution-handler.ts:790-798` — `LlmClientBridge.complete`:
    `req.doctrine` vira system message LÍDER `:795` (prova que o canal doctrine
    do R01 chega ao modelo)
  - `src/runtime/execution-handler.ts:1909-1949` — main synthesis (loop span
    `:1909-1931`, rebuild engine `:1938`, synthesize `:1945-1949`)
  - `src/runtime/execution-handler.ts:491-523` — Model-C synthesis (rebuild `:498`,
    synthesize `:504-508`, sendComplete strategy `:519`)
  - `src/reasoning/reflexion.ts:29-37` (doc intent), `:93-124` (step+retry),
    `:153-182` (`_evaluateFailure`), `:188-202` (`augmentContext` + cast `:194/:200`),
    `:53` (`strategy` delega ao inner), `:80-87` (synthesize injeta `retriesUsed`)
  - `src/reasoning/react.ts:70-164` (step), `:104` (`doctrine: context.systemPrompt`),
    `:272` (`escalated:false` hardcoded), `:281-304` (`buildSystemPrompt`)
  - `src/reasoning/rewoo.ts:280-314` (`executeWaves`), `:332-357` (`buildWaves`),
    `:362-392` (`executeParallel`), `:349/:405` (`CyclicDependencyError`),
    `:112-115` (doc "via _executeWaves"), `:267` (`escalated:false`)
  - `src/reasoning/plan-execute.ts:359` (`escalated: this.replanOccurred`)
  - `src/reasoning/strategy-router.ts:37-84` (build), `:79-81` (wrap reflexion)
  - `src/reasoning/step-evaluator.ts:45-76` (evaluate; Rule 1 reflexion `:49-54`,
    Rule 2 rewoo `:60-65`, Rule 3 plan-execute `:68-73`)
  - `src/reasoning/engine.ts:92-96` (`ToolExecutor` 3-arg), `:112-147`
    (`ReasoningEngine` interface, `reset?()` `:146`), `:78-85` (`AgentResponse`)
  - `src/agents/execution-context.ts:68-167` (`AgentExecutionContext`;
    `streamCallback` `:92`, `originalExecutionId` `:128`)
  - `src/agents/surface/scheduler.agent.ts:15-23` (escalation config)
  - `src/observability/spans.ts:11-36` (`withSpan`, tracer injetável `:15`)
- **Testes (verificados):**
  - `tests/unit/reasoning/reflexion.test.ts:196-231` (augmentContext write + no-mutation)
  - `tests/unit/reasoning/rewoo.test.ts:172-246` (executeWaves parallel/deps/chunk/stop)
  - `tests/unit/reasoning/_helpers.ts:4-29` (`makeContext`/`llmJson`/`llmText`)
  - `tests/fakes/llm-client.fake.ts:16-42` (`FakeLlmClient`)
  - `tests/unit/runtime/` (alvo dos novos testes de orquestração)
  - `vitest.config.ts` (`include: ['tests/**/*.test.ts']` — NÃO co-locar em src/)
- **Spec relacionada:** `2026-06-02-idempotency-key-full-threading-design.md`
  (`stepIndex` threading no `ToolExecutor` — branch separada `mutation-stack`/#59;
  este spec NÃO depende dela e usa o `ToolExecutor` 3-arg vivo).
