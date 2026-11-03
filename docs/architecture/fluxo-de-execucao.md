# Fluxo de Execução

Este documento descreve o fluxo completo que o harness percorre desde o recebimento de um job BullMQ até o envio do resultado final à plataforma Bevox. A orquestração é realizada por `handleExecution` em `src/runtime/execution-handler.ts`.

---

## Visão Geral

Cada job despachado pelo Bevox carrega um `ExecutionPayload`. O `ExecutionHandler` valida esse payload, garante unicidade via Redis, cria uma sessão, executa dois agentes de pipeline (análise e memória), roteia para o agente de superfície adequado, constrói o contexto, filtra permissões, executa o loop de raciocínio e envia o resultado completo — tudo em **10 passos ordenados** com orçamento de tempo dividido em três fatias.

Qualquer falha dentro do bloco principal aciona um boundary de erro: o harness tenta enviar um callback `/complete` com `strategy: "failed"` (com `Idempotency-Key`, suprimido se um `/complete` de sucesso já saiu — guard `completeSent`), atualiza o status da sessão para `"failed"` e relança a exceção. O BullMQ re-tenta conforme o `attempts:7` do produtor (LIVE); esgotado o retry, o `worker.on("failed")` escreve `status='dead_letter'` no backend (sinal authoritativo, acende a replay UI de staff) e retém o job localmente no `failed` set (`removeOnFail.age`) para forense. NÃO há fila DLQ dedicada no harness.

---

## Diagrama de Sequência Completo

```
Bevox (BullMQ)          ExecutionHandler          Redis            Bevox Callback API
      |                        |                     |                      |
      |---[job: rawPayload]--->|                     |                      |
      |                        |                     |                      |
      |                   [1] Validar payload (Zod)  |                      |
      |                        |  parse OK           |                      |
      |                        |                     |                      |
      |                   [2] Dedup SET NX -----------|-> SET harness:dedup:{id} EX 3600 NX
      |                        |<-- nil (dup) --------|   (nil = já existe, abort)
      |                        |<-- "1" (novo) -------|                     |
      |                        |                     |                      |
      |                   [3] Criar session ----------|-> SET harness:session:{id} EX 86400
      |                        |                     |                      |
      |                   [4] Callback "running" -----|------------------->/status
      |                        |                     |                      |
      |                   [5a] MessageAnalyzerAgent  |                      |
      |                        |  (timeout 25% budget)|                     |
      |                        |  -> intent, sentiment, topics, urgency     |
      |                        |                     |                      |
      |                   [5b] MemoryExtractorAgent  |                      |
      |                        |  (timeout 25% budget)|                     |
      |                        |  (falha não-fatal)  |                      |
      |                        |                     |                      |
      |                   [6] AgentRouter.resolve(intent)                   |
      |                        |  -> agentName ou "request-human"           |
      |                        |                     |                      |
      |                        | se request-human:   |                      |
      |                        |------------------------------------------->/complete (strategy: request-human)
      |                        |                     |                      |
      |                   [7] Build context (5 camadas)                     |
      |                        |  buildPermissionContext                    |
      |                        |                     |                      |
      |                   [8] filterPermittedTools   |                      |
      |                        |  -> permittedTools[]|                      |
      |                        |                     |                      |
      |                   [9] runSurfaceAgentLoop    |                      |
      |                        |  (timeout 50% budget)|                     |
      |                        |  engine.plan()      |                      |
      |                        |  loop:              |                      |
      |                        |    engine.step()    |                      |
      |                        |    engine.observe() |                      |
      |                        |    stepEvaluator    |                      |
      |                        |      -> escalation? |                      |
      |                        |  engine.synthesize()|                      |
      |                        |                     |                      |
      |                  [10] Callback "complete" ----|------------------->/complete
      |                        |  update session: completed                 |
      |                        |                     |                      |
      |<--[job done]-----------|                     |                      |
```

---

## Os 10 Passos em Detalhe

### 1. Validar Payload (Zod)

O payload bruto recebido do BullMQ é validado contra `executionPayloadSchema` usando `safeParse`. Em caso de falha a execução é abortada silenciosamente (sem callback) e um log de erro é emitido.

Campos do `ExecutionPayload`:

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `execution_id` | `string (UUID)` | sim | Identificador único da execução |
| `execution_token` | `string` | sim | Token bearer para chamadas de callback |
| `callback_base_url` | `string (URL)` | não | Override da base URL de callback |
| `account` | `object { id: number }` | não | Conta proprietária (forma aninhada) |
| `account_id` | `number (int)` | não | Conta proprietária (forma plana, alternativa) |
| `conversation` | `Record<string, unknown>` | não | Dados da conversa (inclui `id`) |
| `messages` | `MessageSchema[]` | não | Histórico de mensagens (default `[]`) |
| `context` | `Record<string, unknown>` | não | Contexto adicional livre |
| `agent_config` | `Record<string, unknown>` | não | Configurações do agente (`default_model`, `system_prompt`) |
| `skills` | `string[]` | não | Skills habilitadas para esta execução (default `[]`) |

Onde `MessageSchema` é `{ role: "user" | "assistant" | "system"; content: string }`.

O `accountId` é resolvido como `account_id ?? account.id ?? 0`.

### 2. Deduplicação Redis

Antes de qualquer trabalho efetivo, o handler tenta adquirir um lock atômico:

```
SET harness:dedup:{execution_id}  "1"  EX 3600  NX
```

- Chave: `harness:dedup:{execution_id}`
- TTL: **3600 segundos** (1 hora)
- Semântica: `NX` garante que apenas o primeiro worker a processar este job prossegue.
- Se o comando retornar `null` (chave já existente), o job é descartado com log de aviso — sem callback, sem sessão.

### 3. Criar Sessão

Um `SessionStore` é instanciado com a conexão Redis e `create` é chamado com o estado inicial:

```ts
{
  executionId: execution_id,
  accountId,
  conversationId,   // payload.conversation.id ?? 0
  status: 'running',
  startedAt: new Date().toISOString(),
}
```

A sessão é armazenada em `harness:session:{execution_id}` com TTL de **86 400 segundos** (24 horas). Veja o ciclo de vida completo na seção [Session Lifecycle](#session-lifecycle) abaixo.

### 4. Callback de Status "running"

`updateStatus(execution_id, execution_token, 'running')` faz um POST para:

```
POST {callbackBaseUrl}/api/v1/executions/{execution_id}/status
X-Execution-Token: {execution_token}

{ "status": "running" }
```

Timeout da requisição HTTP: **10 segundos** (configurado via `AbortSignal.timeout`).

### 5. Pipeline de Agentes

Dois agentes especializados rodam em sequência antes do agente de superfície, compartilhando o `AgentExecutionContext` base.

#### 5a. MessageAnalyzerAgent (timeout = 25% do budget)

- Nome registrado: `message-analyzer`
- Timeout: `maxExecutionTimeMs / 4`
- Saída esperada: `{ intent, sentiment, sentimentConfidence, topics, urgency }`
- Caso o agente não esteja registrado, valores padrão são usados: `intent: "unknown"`, `sentiment: "neutral"`, `sentimentConfidence: 0.5`.
- Falha neste agente é fatal — a exceção sobe para o boundary de erro.

#### 5b. MemoryExtractorAgent (timeout = 25% do budget)

- Nome registrado: `memory-extractor`
- Timeout: `maxExecutionTimeMs / 4`
- Falha é **não-fatal**: erros são capturados e logados como aviso; a execução continua.
- Só executado se o agente estiver registrado.

Veja detalhes dos agentes em [agentes](./agentes-e-registro.md).

### 6. Rotear para Agente de Superfície (AgentRouter)

O `AgentRouter` recebe o `intent` extraído pelo `MessageAnalyzerAgent` e percorre as regras de rota em ordem decrescente de prioridade:

```
Tabela de rotas padrão (DEFAULT_ROUTE_RULES):

intent                    agent        fallback        priority
scheduling              → scheduler    request-human     10
scheduling_confirmation → scheduler    request-human     10
scheduling_cancellation → scheduler    request-human     10
scheduling_reschedule   → scheduler    request-human     10
question                → scheduler    request-human      5
unknown                 → scheduler    request-human      1
```

Regras adicionais podem ser injetadas via `createAgentRouter(extraRules)`.

Lógica de resolução:
1. Primeira regra que casa com o intent é selecionada.
2. Se o agente mapeado **não estiver registrado**, usa-se o `fallback` da regra.
3. Se nenhuma regra casar, retorna `"request-human"`.

Quando o resultado é `"request-human"`, o handler envia imediatamente um callback `/complete` com `strategy: "request-human"` e encerra a execução sem passar pelo loop de surface agent.

Caso `AgentRouter` não tenha sido injetado no harness, o fallback direto é `"scheduler"` (se registrado) ou `"request-human"`.

### 7. Build de Contexto (5 Camadas)

Após identificar o agente de superfície, o handler constrói o contexto de permissões em 5 camadas via `buildPermissionContext`:

1. **Ferramentas registradas** — lista completa do `ToolRegistry`
2. **Ferramentas indisponíveis** — nomes que `toolRegistry.getUnavailableNames()` reporta
3. **Definição do agente** — `AgentDefinition` com `allowedTools`, `deniedTools`, `requiredSkills`
4. **Payload da execução** — skills habilitadas, `account_id`, dados de conversa
5. **Ferramentas indisponíveis (exclusão)** — removidas da lista final

O contexto resultante (`PermissionContext`) alimenta o passo seguinte. Veja [contexto](./contexto-e-tokenizacao.md) para tokenização e [permissões](./ferramentas-e-permissoes.md) para a lógica de filtragem.

### 8. Filtrar Permissões

`filterPermittedTools(allTools, agentDef, permCtx)` aplica as regras de `allowedTools` / `deniedTools` da definição do agente e remove ferramentas indisponíveis. O resultado é a lista `permittedTools[]` que será oferecida ao agente de superfície.

### 9. Loop do Agente de Superfície (timeout = 50% do budget)

`runSurfaceAgentLoop` executa o raciocínio principal com timeout de `maxExecutionTimeMs / 2`.

Fluxo interno:

```
1. strategyRouter.build(agent, agentContext)  → ReasoningEngine inicial
2. engine.plan(input, agentContext)           → Plan
3. while engine.shouldContinue(observations, plan, ctx):
   a. engine.step(plan, stepIndex, tools, ctx, executeTool, traceCallback)
   b. engine.observe(stepResult, ctx)          → Observation
   c. allObservations.push(observation)
   d. stepEvaluator.evaluate(observations, plan, escalationConfig)
      → continue | wrap-reflexion | escalate-to-plan-execute | escalate-to-rewoo
   e. se escalation:
      - wrap-reflexion        → ReflexionWrapper({ inner: engine })
      - escalate-to-plan-execute → PlanExecuteEngine(); re-plan; stepIndex = 0
      - escalate-to-rewoo        → ReWOOEngine();       re-plan; stepIndex = 0
4. engine.synthesize(observations, finalPlan, ctx) → AgentResponse
```

Configuração de escalação (lida de `agent.reasoning.escalation`):

| Parâmetro | Default |
|---|---|
| `stepThreshold` | 5 |
| `parallelThreshold` | 2 |
| `onFailure` | `"abort"` |
| `escalateTo` | `"plan-execute"` |

Observações acumuladas são preservadas em todos os swaps de engine. Veja os motores em [motores](./motores-de-raciocinio.md).

### 10. Callback de Conclusão

Após a síntese do `AgentResponse`, o handler envia:

```
POST {callbackBaseUrl}/api/v1/executions/{execution_id}/complete
X-Execution-Token: {execution_token}

{
  "response":   "<resposta final>",
  "sentiment":  "<sentiment do MessageAnalyzer>",
  "strategy":   "<strategy reportada pelo engine>",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0 }
}
```

Em seguida atualiza a sessão para `status: "completed"` com `completedAt`.

---

## Timeouts — Divisão do Budget

O tempo total de execução é configurado por `harness.maxExecutionTimeMs`.

| Fase | Fração | Exemplo (60 s) |
|---|---|---|
| MessageAnalyzerAgent | 25% | 15 s |
| MemoryExtractorAgent | 25% | 15 s |
| SurfaceAgent loop | 50% | 30 s |

As três fatias são independentes e sequenciais. O timeout do SurfaceAgent é o maior porque inclui chamadas LLM iterativas, uso de ferramentas e possível escalação de engine.

---

## Error Handling

### Falha de Validação (Passo 1)

- Ocorre **antes** da aquisição do lock e da criação de sessão.
- Não há callback enviado ao Bevox.
- Log de erro com `parseResult.error.flatten()`.
- O job BullMQ pode ser descartado ou recolocado na fila, conforme política do worker.

### Execução Duplicada (Passo 2)

- Retorno silencioso — apenas log de aviso.
- Nenhum efeito colateral (sem sessão, sem callback).

### Timeout de Pipeline Agent

- `MessageAnalyzerAgent`: timeout fatal — exceção sobe ao boundary.
- `MemoryExtractorAgent`: timeout não-fatal — log de aviso, execução continua.

### Timeout do Surface Agent Loop

- Rejeita a Promise do `runWithTimeout`.
- Capturado pelo `catch` do boundary de erro (ver abaixo).

### Falha de LLM

- Erros nas chamadas ao `LLMGateway` (HTTP 4xx/5xx, timeout de 10 s do AbortSignal) propagam como exceções.
- Capturadas pelo boundary de erro.

### Falha de Tool

- O `executeTool` interno retorna `{ success: false, error: "Tool not found: ..." }` para ferramentas inexistentes, sem lançar exceção.
- Erros em `tool.execute()` propagam e podem ser absorvidos pela lógica de observação do engine ou subir ao boundary.

### Boundary de Erro (Passo Catch-All)

Qualquer exceção não tratada dentro do bloco `try`:

1. Log de erro com `execution_id` e `err`.
2. Tentativa de `sendComplete` com `strategy: "failed"` — erros nessa tentativa são suprimidos e logados como aviso.
3. `sessionStore.update(execution_id, { status: 'failed' })` — erros suprimidos.
4. Exceção relançada para o worker BullMQ. Retry via `attempts:7` do produtor (LIVE); retry esgotado → `status='dead_letter'` no backend (authoritativo) + retenção local no `failed` set. Sem fila DLQ dedicada no harness.

Veja integrações externas em [integrações](./integracoes-externas.md).

---

## Session Lifecycle

A sessão é persistida no Redis em `harness:session:{execution_id}` com TTL de 24 horas.

```
         Passo 3                Passo 4+                Passo 10 (sucesso)
           |                      |                           |
        created ──────────────> running ──────────────────> completed
                                  |
                                  | (qualquer exceção no try)
                                  |
                               failed
```

Transições de estado:

| De | Para | Gatilho |
|---|---|---|
| — | `running` | `sessionStore.create(...)` no passo 3 |
| `running` | `completed` | `sessionStore.update({ status: 'completed', completedAt })` no passo 10 |
| `running` | `failed` | `sessionStore.update({ status: 'failed' })` no boundary de erro |

A sessão expira automaticamente após 24 horas, independentemente do estado final.

---

## Referências Cruzadas

- [Agentes e Registro](./agentes-e-registro.md) — registro, resolução e definição de `AgentDefinition`
- [Motores de Raciocínio](./motores-de-raciocinio.md) — `ReasoningEngine`, `PlanExecuteEngine`, `ReWOOEngine`, `ReflexionWrapper`, `stepEvaluator`
- [Contexto e Tokenização](./contexto-e-tokenizacao.md) — construção das 5 camadas de contexto e contagem de tokens
- [Ferramentas e Permissões](./ferramentas-e-permissoes.md) — `filterPermittedTools`, `buildPermissionContext`, `ToolRegistry`
- [Integrações Externas](./integracoes-externas.md) — callbacks Bevox, `LLMGateway`, configuração de endpoints
