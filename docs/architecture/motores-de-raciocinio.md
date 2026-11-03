# Motores de Raciocínio

O bevox-agent-harness oferece cinco motores de raciocínio com complexidade crescente. O motor adequado para cada execução é selecionado dinamicamente pelo `StrategyRouter` com base na configuração do agente, e pode ser escalado em tempo de execução pelo `StepEvaluator`.

Referências cruzadas: [agentes](./agentes-e-registro.md) | [fluxo de execução](./fluxo-de-execucao.md)

---

## Visão Geral

| Motor | Estratégia | Complexidade | Padrão para |
|---|---|---|---|
| `DirectEngine` | `direct` | Baixa | Agentes `pipeline` |
| `ReactEngine` | `react` | Média | Agentes `surface` (padrão) |
| `PlanExecuteEngine` | `plan-execute` | Alta | Tarefas multi-etapa complexas |
| `ReWOOEngine` | `rewoo` | Muito alta | Tarefas com etapas independentes paralelizáveis |
| `ReflexionWrapper` | (wrapper) | — | Qualquer engine com retry automático |

O `ReflexionWrapper` não é um motor independente — é um decorador que envolve qualquer um dos quatro motores base para adicionar lógica de auto-reflexão e retry.

---

## Interface `ReasoningEngine`

Todo motor concreto implementa o seguinte contrato definido em `src/reasoning/engine.ts`:

```typescript
export interface ReasoningEngine {
  readonly strategy: AgentResponse['strategy']

  plan(input: string, context: AgentExecutionContext): Promise<Plan>

  step(
    plan: Plan,
    stepIndex: number,
    tools: ToolDefinition[],
    context: AgentExecutionContext,
    executeTool: ToolExecutor,
    traceCallback?: TraceCallback,
  ): Promise<StepResult>

  observe(stepResult: StepResult, context: AgentExecutionContext): Promise<Observation>

  shouldContinue(
    observations: Observation[],
    plan: Plan,
    context: AgentExecutionContext,
  ): Promise<boolean>

  synthesize(
    observations: Observation[],
    plan: Plan,
    context: AgentExecutionContext,
  ): Promise<AgentResponse>
}
```

### Responsabilidade de cada método

- **`plan`** — Recebe o input do usuário e produz um `Plan` com os passos a executar.
- **`step`** — Executa um passo do plano, chamando uma ferramenta via `executeTool` ou respondendo diretamente.
- **`observe`** — Transforma um `StepResult` em uma `Observation` sumarizada, sinalizando parada (`stopSignal`) se necessário.
- **`shouldContinue`** — Decide se o loop de execução deve continuar após o último passo observado.
- **`synthesize`** — Consolida todas as observações em um `AgentResponse` final.

---

## Tipos Compartilhados

Todos os tipos abaixo estão definidos em `src/reasoning/engine.ts`.

### `PlanStep`

```typescript
export interface PlanStep {
  index: number
  description: string
  /** Dica do planejador — não vinculante. */
  toolName?: string
  toolParams?: unknown
  /** Índices de passos que devem completar antes (usado pelo ReWOOEngine). */
  dependsOn?: number[]
}
```

### `Plan`

```typescript
export interface Plan {
  goal: string
  steps: PlanStep[]
  estimatedComplexity: 'low' | 'medium' | 'high'
}
```

### `StepResult`

```typescript
export interface StepResult {
  stepIndex: number
  success: boolean
  toolName?: string
  toolParams?: unknown
  toolOutput?: unknown
  errorMessage?: string
  /** Chain-of-thought do ReAct antes da ação. */
  thinkingTrace?: string
  durationMs: number
}
```

### `Observation`

```typescript
export interface Observation {
  stepIndex: number
  /** Output sumarizado pelo LLM ou bruto. */
  summary: string
  success: boolean
  raw: StepResult
  /** Score de divergência opcional do PlanExecuteEngine (0–1). */
  divergenceScore?: number
  /** Indica parada (send-message / request-human). */
  stopSignal?: boolean
}
```

### `AgentResponse`

```typescript
export interface AgentResponse {
  answer: string
  observations: Observation[]
  totalSteps: number
  strategy: 'direct' | 'react' | 'plan-execute' | 'rewoo'
  escalated: boolean
  retriesUsed: number
}
```

---

## Tabela Comparativa

| Engine | Quando usar | Prós | Contras |
|---|---|---|---|
| `DirectEngine` | Extração estruturada, análise de mensagem, sem tools | Latência mínima, determinístico, sem overhead de loop | Não pode usar tools, sem raciocínio iterativo |
| `ReactEngine` | Agente conversacional com acesso a tools, fluxo imprevisível | Flexível, o LLM decide o próximo passo a cada iteração | Sem plano upfront, pode andar em círculos, custo por iteração |
| `PlanExecuteEngine` | Tarefas complexas com sequência bem definida de etapas | Plano visível, suporte a re-planejamento dinâmico | Execução sequencial, micro-chamada de LLM por observação |
| `ReWOOEngine` | Tarefas com muitas etapas independentes paralelizáveis | Execução paralela em waves, reduz latência total | Complexidade de dependências, risco de ciclos, experimental |
| `ReflexionWrapper` | Qualquer cenário em que erros transitórios são esperados | Retry automático com aprendizado, transparente para o caller | Até 2 micro-chamadas extras por falha, aumenta latência em casos de erro |

---

## Cada Engine em Detalhe

### DirectEngine (`src/reasoning/direct.ts`)

Motor single-shot sem uso de ferramentas. Projetado para agentes do tipo `pipeline` (ex.: `MessageAnalyzerAgent`, `MemoryExtractorAgent`) que precisam apenas extrair JSON estruturado de um input.

Os métodos `plan`, `observe` e `shouldContinue` são stubs triviais. Todo o trabalho real acontece em `step`, que faz uma única chamada ao LLM com `responseFormat: json_object`.

```
┌─────────────────────────────────────┐
│             DirectEngine            │
│                                     │
│  Input ──► LLM (json_object) ──►   │
│            parse JSON               │
│               │                     │
│               ▼                     │
│         AgentResponse               │
│  (strategy: 'direct', steps: 1)    │
└─────────────────────────────────────┘
```

**Configuração (`DirectEngineConfig`):**

- `outputSchema` — JSON Schema descritivo do output esperado (opcional).
- `modelOverride` — substitui `context.accountConfig.llmModel`.
- `systemPrompt` — padrão: `"Return ONLY valid JSON. No markdown, no explanation."`

`shouldContinue` sempre retorna `false` — o DirectEngine jamais entra em loop.

---

### ReactEngine (`src/reasoning/react.ts`)

Implementa o padrão clássico ReAct (Reasoning + Acting): a cada iteração o LLM produz um `thinking` (chain-of-thought) e decide chamar uma tool ou fornecer a resposta final.

```
┌──────────────────────────────────────────────┐
│               ReactEngine                    │
│                                              │
│  ┌──────────┐                                │
│  │  Input   │                                │
│  └────┬─────┘                                │
│       │                                      │
│       ▼                                      │
│  ┌─────────────────────────────────────┐     │
│  │  step N: LLM decide                 │     │
│  │  { thinking, toolName, toolParams } │     │
│  └──────┬──────────────┬───────────────┘     │
│         │ tool call    │ texto final          │
│         ▼              ▼                     │
│  ┌────────────┐   ┌──────────────┐           │
│  │ executeTool│   │  synthesize  │           │
│  └─────┬──────┘   └──────────────┘           │
│        │ observe                             │
│        ▼                                     │
│  shouldContinue? ──► sim ──► step N+1        │
│        │                                     │
│        └──► não ──► synthesize               │
└──────────────────────────────────────────────┘
```

**Condições de parada (`shouldContinue`):**

1. Uma stop-tool (`send-message`, `request-human`) foi chamada (`stopSignal = true`).
2. `observations.length >= maxSteps` (padrão: 10).
3. O LLM retornou resposta em texto (sem `toolName`) — resposta final implícita.

**Configuração (`ReactEngineConfig`):**

- `maxSteps` — padrão: `10`.
- `stopTools` — padrão: `['send-message', 'request-human']`.

---

### PlanExecuteEngine (`src/reasoning/plan-execute.ts`)

Motor plan-first com execução sequencial. O LLM gera um plano numerado na chamada `plan()` e cada passo é executado em ordem. Após cada passo, uma micro-chamada de LLM calcula um `divergenceScore` (0–1) para avaliar se o resultado diverge da expectativa.

```
┌─────────────────────────────────────────────────────────┐
│                   PlanExecuteEngine                     │
│                                                         │
│  Input ──► plan() ──► [passo 0, passo 1, ..., passo N] │
│                               │                         │
│              ┌────────────────┘                         │
│              │  para cada passo (sequencial):            │
│              ▼                                          │
│         step(i) ──► executeTool                         │
│              │                                          │
│              ▼                                          │
│         observe() ──► scoreDivergence() (micro-LLM)     │
│              │                                          │
│              ▼                                          │
│   divergenceScore > 0.6?                                │
│       ├── sim ──► _replan() ──► substitui passos        │
│       │          restantes no plan.steps                │
│       │          replanOccurred = true                  │
│       └── não ──► próximo passo                         │
│              │                                          │
│              ▼                                          │
│   shouldContinue? ──► não ──► synthesize()              │
│   (escalated = replanOccurred)                          │
└─────────────────────────────────────────────────────────┘
```

**Quando re-planeja:**

O re-planejamento ocorre quando `divergenceScore > replanThreshold` (padrão: `0.6`) e `allowReplan = true` (padrão). A função `_replan` faz uma chamada ao LLM com o sumário dos passos já concluídos e solicita passos revisados para o restante. Os novos passos substituem in-place os passos remanescentes em `plan.steps`. O campo `escalated` do `AgentResponse` é marcado como `true` se algum re-planejamento ocorreu.

**Configuração (`PlanExecuteEngineConfig`):**

- `maxSteps` — padrão: `15`.
- `allowReplan` — padrão: `true`.
- `replanThreshold` — padrão: `0.6`.

---

### ReWOOEngine (`src/reasoning/rewoo.ts`)

Motor experimental de execução paralela baseado no padrão ReWOO (Reasoning Without Observation between steps). O LLM produz um plano com anotações de dependência (`dependsOn`), e o engine agrupa passos em "waves" topológicas — cada wave contém apenas passos cujas dependências já foram concluídas. Os passos de uma mesma wave são executados em paralelo, limitados a `maxParallel` (padrão: 5) concorrentes.

```
┌──────────────────────────────────────────────────────────┐
│                      ReWOOEngine                         │
│                                                          │
│  Input ──► plan() ──► passos com dependsOn[]             │
│                                │                         │
│                     validateNoCycles() (DFS)             │
│                                │                         │
│                     buildWaves() ──► topological sort    │
│                                │                         │
│              ┌─────────────────┘                         │
│              │  para cada wave:                          │
│              ▼                                           │
│   shouldContinue? ──► não ──► parar                      │
│              │                                           │
│   executeParallel(wave, maxParallel=5)                   │
│     ├── step(0) ─┐                                       │
│     ├── step(2) ─┤── Promise.all ──► resultados          │
│     └── step(4) ─┘                                       │
│              │                                           │
│         observe() para cada resultado                    │
│              │                                           │
│         próxima wave (passos que dependiam dos           │
│         completados nesta wave)                          │
│              │                                           │
│         synthesize()                                     │
└──────────────────────────────────────────────────────────┘
```

**Grafo de dependências e waves:**

```
Passos:  0 ──► 2 ──► 4
         1 ──► 3
         (5 independente)

Wave 1: [0, 1, 5]   (sem dependências)
Wave 2: [2, 3]      (dependem de 0 e 1)
Wave 3: [4]         (depende de 2)
```

Se um ciclo for detectado (em `validateNoCycles` via DFS ou durante `buildWaves`), um `CyclicDependencyError` é lançado.

`shouldContinue` retorna `false` assim que qualquer observação contiver `stopSignal = true`.

**Configuração (`ReWOOEngineConfig`):**

- `maxParallel` — padrão: `5`.

> **Nota:** O ReWOOEngine é marcado como `@experimental` e não é o padrão para nenhum agente. Para ativá-lo, defina `reasoning: { default: 'rewoo' }` na definição do agente.

---

### ReflexionWrapper (`src/reasoning/reflexion.ts`)

Decorador que envolve qualquer `ReasoningEngine`. Não altera o comportamento de `plan`, `observe` ou `shouldContinue` — apenas intercepta `step` para adicionar retry com auto-reflexão em caso de falha.

```
┌──────────────────────────────────────────────────────────┐
│                   ReflexionWrapper                       │
│                                                          │
│  step() chamado:                                         │
│     1. tenta inner.step()                                │
│             │                                            │
│             ├── sucesso ──► retorna resultado            │
│             │                                            │
│             └── falha ──► loop até maxRetries:           │
│                   │                                      │
│                   ▼                                      │
│          _evaluateFailure() (micro-LLM)                  │
│          ──► { learnedContext: "..." }                   │
│                   │                                      │
│          augmentContext()                                │
│          ──► context.reflexionNotes.push(learnedContext) │
│                   │                                      │
│          inner.step() com contexto enriquecido           │
│                   │                                      │
│             ├── sucesso ──► retorna resultado            │
│             └── (continua loop)                          │
│                   │                                      │
│          retries esgotados ──► retorna falha com         │
│          mensagem "[ReflexionWrapper] Failed after N     │
│          retries. Last error: ..."                       │
└──────────────────────────────────────────────────────────┘
```

O método `synthesize` delega para `inner.synthesize` e injeta o contador `retriesUsed` no `AgentResponse` final.

**Configuração (`ReflexionWrapperConfig`):**

- `inner` — engine a ser decorado (obrigatório).
- `maxRetries` — padrão: `2`.

---

## Strategy Router

`src/reasoning/strategy-router.ts` — fábrica stateless que constrói o `ReasoningEngine` correto para um agente.

### Lógica de resolução

```
agent.reasoning.default
        │
        ├── 'direct'       ──► new DirectEngine()
        ├── 'react'        ──► new ReactEngine({ maxSteps: 10, ... })
        ├── 'plan-execute' ──► new PlanExecuteEngine({ maxSteps: 15, ... })
        ├── 'rewoo'        ──► new ReWOOEngine({ maxParallel: 5 })
        └── (ausente)      ──► inferDefault(agent.type)
                                  ├── 'pipeline' ──► 'direct'
                                  └── outros     ──► 'react'

após construir o engine base:

agent.reasoning.escalation.onFailure === 'reflexion'?
        ├── sim ──► new ReflexionWrapper({ inner: engine })
        └── não ──► engine sem modificação
```

O método `inferDefault` mapeia o tipo do agente ao motor padrão: agentes `pipeline` recebem `direct`; todos os outros recebem `react`.

A função `mergeConfig` faz um shallow merge entre os defaults do router e eventuais overrides da definição do agente — os overrides têm precedência.

O singleton exportado é `strategyRouter` (instância única de `StrategyRouter`).

---

## Step Evaluator

`src/reasoning/step-evaluator.ts` — avaliador de lógica pura (sem chamadas ao LLM) executado após cada passo durante a execução de agentes `surface`. Decide se a estratégia deve ser escalada.

### Interface de configuração

```typescript
export interface EscalationConfig {
  /** Após este número de passos, escalar para PlanExecute. */
  stepThreshold: number
  /** Se >= este número de tarefas independentes restarem, escalar para ReWOO. */
  parallelThreshold: number
  onFailure: 'reflexion' | 'abort'
  /** Engine alvo quando a contagem de passos é excedida. */
  escalateTo: 'plan-execute' | 'rewoo'
}
```

### Decisões possíveis

```typescript
export type EscalationDecision =
  | { action: 'continue' }
  | { action: 'escalate-to-plan-execute'; reason: string }
  | { action: 'escalate-to-rewoo'; reason: string }
  | { action: 'wrap-reflexion'; reason: string }
```

### Critérios de decisão (em ordem de prioridade)

```
evaluate(observations, plan, config):
  │
  ├── 1. último passo falhou E config.onFailure === 'reflexion'
  │        ──► { action: 'wrap-reflexion', reason: '...' }
  │
  ├── 2. passos independentes restantes >= config.parallelThreshold
  │        ──► { action: 'escalate-to-rewoo', reason: '...' }
  │
  ├── 3. observations.length > config.stepThreshold
  │        ──► { action: 'escalate-to-plan-execute', reason: '...' }
  │
  └── 4. nenhum critério atendido
           ──► { action: 'continue' }
```

"Passos independentes restantes" são os passos do plano que ainda não foram executados E que possuem `dependsOn === []` (sem pré-requisitos). O singleton exportado é `stepEvaluator`.

---

## Fluxo de Escalation

O diagrama abaixo mostra como um agente pode progredir pelos motores durante uma única execução, dependendo das decisões do `StepEvaluator`:

```
                    ┌─────────────┐
          Input ──► │   Direct    │  (agentes pipeline)
                    └──────┬──────┘
                           │ (não se aplica a surface)
                           │
                    ┌──────▼──────┐
          padrão ──►│    ReAct    │◄── agent.reasoning.default: 'react'
                    └──────┬──────┘
                           │
              ┌────────────┼────────────────────┐
              │            │                    │
   stepThreshold    parallelThreshold    onFailure: 'reflexion'
    excedido         excedido                   │
              │            │                    ▼
              ▼            ▼          ┌──────────────────────┐
    ┌──────────────┐ ┌──────────┐    │  ReflexionWrapper    │
    │ PlanExecute  │ │  ReWOO   │    │  (envolve qualquer   │
    │              │ │          │    │   engine atual)       │
    └──────┬───────┘ └────┬─────┘    └──────────────────────┘
           │              │
           └──────┬───────┘
                  │
                  ▼
           synthesize()
          AgentResponse
```

**Regras de escalation (resumo):**

- `Direct` → nunca escala (agentes pipeline).
- `ReAct` → escala para `PlanExecute` se `observations.length > stepThreshold`.
- `ReAct` → escala para `ReWOO` se passos independentes restantes `>= parallelThreshold`.
- Qualquer engine → `ReflexionWrapper` se último passo falhou e `onFailure === 'reflexion'`.
- `ReflexionWrapper` é um wrapper, não um destino final de escalation — ele envolve o engine atual no momento da decisão.

---

## Localização dos Arquivos

| Arquivo | Descrição |
|---|---|
| `src/reasoning/engine.ts` | Interfaces e tipos compartilhados |
| `src/reasoning/direct.ts` | `DirectEngine` |
| `src/reasoning/react.ts` | `ReactEngine` |
| `src/reasoning/plan-execute.ts` | `PlanExecuteEngine` |
| `src/reasoning/rewoo.ts` | `ReWOOEngine` + `CyclicDependencyError` |
| `src/reasoning/reflexion.ts` | `ReflexionWrapper` |
| `src/reasoning/strategy-router.ts` | `StrategyRouter` + singleton `strategyRouter` |
| `src/reasoning/step-evaluator.ts` | `StepEvaluator` + singleton `stepEvaluator` |
