# Visão Geral da Arquitetura — Agent Harness

## Propósito

O **bevox-agent-harness** é o processo de execução de agentes de IA do ecossistema Bevox v2. Ele não expõe uma API HTTP pública; em vez disso, consome jobs de uma fila BullMQ despachados pelo **orchestration-service** e devolve resultados para o Bevox via callbacks HTTP.

No fluxo geral do produto:

1. Um evento de conversa (mensagem de usuário, gatilho de automação etc.) chega ao orchestration-service do Bevox v2.
2. O orchestration-service enfileira um job na fila BullMQ `bevox.execution.dispatch` com o `ExecutionPayload`.
3. O harness consome o job, executa o pipeline de agentes e chama `POST /api/v1/executions/{id}/complete` no Bevox com a resposta final, sentimento e estratégia utilizada.
4. O orchestration-service entrega o resultado ao canal de origem (WhatsApp, chat web, etc.).

O harness roda como **processo Node.js independente**, o que permite escalá-lo separadamente do orchestration-service, reiniciá-lo sem afetar a API pública e processar múltiplos jobs em paralelo via workers BullMQ.

---

## Diagrama de Arquitetura

```text
  Bevox v2
  orchestration-service
        |
        | BullMQ job (ExecutionPayload)
        | queue: bevox.execution.dispatch
        v
+-----------------------------------------------+
|         BullMQ Consumer                        |
|  src/integration/bullmq-consumer.ts            |
|  Worker → handleExecution()                    |
+------------------+----------------------------+
                   |
                   v
+--------------------------------------------------+
|          Execution Handler                        |
|  src/runtime/execution-handler.ts                 |
|                                                   |
|  1. Valida payload (zod)                          |
|  2. Dedup Redis (SET NX / 1h TTL)                 |
|  3. Cria sessão no Session Store                  |
|  4. Cria LLM Gateway (OpenAI | Gemini)            |
|                                                   |
|  ┌─────────────────────────────────────────┐      |
|  │  PIPELINE (sem tools, sem interação)    │      |
|  │                                         │      |
|  │  ┌──────────────────────────────────┐   │      |
|  │  │  MessageAnalyzerAgent            │   │      |
|  │  │  src/agents/pipeline/            │   │      |
|  │  │  → intent, sentiment, topics,    │   │      |
|  │  │    urgency, sentimentConfidence  │   │      |
|  │  └──────────────────────────────────┘   │      |
|  │                                         │      |
|  │  ┌──────────────────────────────────┐   │      |
|  │  │  MemoryExtractorAgent (non-fatal)│   │      |
|  │  │  src/agents/pipeline/            │   │      |
|  │  │  → persiste fatos no PostgreSQL  │   │      |
|  │  └──────────────────────────────────┘   │      |
|  └──────────────┬──────────────────────────┘      |
|                 │ intent                           |
|                 v                                  |
|  ┌──────────────────────────────────────────┐      |
|  │  Agent Router                            │      |
|  │  src/runtime/agent-router.ts             │      |
|  │  → resolve(intent) → agentName           │      |
|  └───────────────┬──────────────────────────┘      |
|                  │                                  |
|                  v                                  |
|  ┌──────────────────────────────────────────┐      |
|  │  Surface Agent (ex: SchedulerAgent)      │      |
|  │  src/agents/surface/                     │      |
|  │                                          │      |
|  │  Permissions Evaluator                   │      |
|  │  src/permissions/evaluator.ts            │      |
|  │  → filtra tools permitidas               │      |
|  │                                          │      |
|  │  ┌────────────────────────────────────┐  │      |
|  │  │  Reasoning Loop                    │  │      |
|  │  │  src/runtime/execution-handler.ts  │  │      |
|  │  │  runSurfaceAgentLoop()             │  │      |
|  │  │                                    │  │      |
|  │  │  Strategy Router                   │  │      |
|  │  │  src/reasoning/strategy-router.ts  │  │      |
|  │  │  ┌─────────────────────────────┐   │  │      |
|  │  │  │ DirectEngine                │   │  │      |
|  │  │  │ ReactEngine (default)       │   │  │      |
|  │  │  │ PlanExecuteEngine           │   │  │      |
|  │  │  │ ReWOOEngine                 │   │  │      |
|  │  │  │ ReflexionWrapper (on-fail)  │   │  │      |
|  │  │  └─────────────────────────────┘   │  │      |
|  │  │                                    │  │      |
|  │  │  Step Evaluator (escalonamento)    │  │      |
|  │  │  src/reasoning/step-evaluator.ts   │  │      |
|  │  └──────────────┬─────────────────────┘  │      |
|  │                 │ ToolExecutor            │      |
|  │                 v                         │      |
|  │  ┌────────────────────────────────────┐  │      |
|  │  │  Tool Registry                     │  │      |
|  │  │  src/tools/registry.ts             │  │      |
|  │  │  • read/list/create/cancel/        │  │      |
|  │  │    reschedule/waitlist (calendar)  │  │      |
|  │  │  • send-message / request-human   │  │      |
|  │  │  • read/write-profile, write-fact  │  │      |
|  │  │  • search-faq                      │  │      |
|  │  └──────┬─────────────────────────────┘  │      |
|  └─────────┼──────────────────────────────── ┘      |
|            │                                        |
+------------┼----------------------------------------+
             |
      ┌──────┴──────────────────────────────┐
      │                                      │
      v                                      v
+─────────────────┐          +───────────────────────+
│  Calendar Client │          │  LLM Gateway           |
│  src/integration/│          │  src/integration/      |
│  calendar-client │          │  llm-gateway.ts        |
│  → HTTP REST     │          │  • OpenAI API          |
│  Calendar Service│          │  • Gemini API          |
+─────────────────+          +───────────────────────+

  Dependências de infraestrutura (bootstrap + runtime):

  +──────────────────+    +──────────────────────────+
  │  Session Store    │    │  DB (PostgreSQL)          |
  │  Redis (ioredis)  │    │  pg.Pool                  |
  │  harness:dedup:*  │    │  memórias, perfis, FAQ    |
  │  harness:session: │    |  src/memory/             |
  +──────────────────+    +──────────────────────────+

  Retorno ao Bevox:

  Execution Handler
        |
        | POST /api/v1/executions/{id}/status   (running)
        | POST /api/v1/executions/{id}/complete  (resposta final)
        v
  Bevox orchestration-service (BEVOX_CALLBACK_BASE_URL)
```

---

## Stack Tecnológico

| Tecnologia | Versão (package.json) | Propósito |
|---|---|---|
| Node.js / TypeScript | `typescript ^5.9.3` | Runtime e tipagem estática |
| BullMQ | `^5.58.5` | Fila de jobs Redis; consumer de execuções |
| ioredis | `^5.8.1` | Client Redis — fila BullMQ, dedup, session store |
| pg | `^8.16.3` | Client PostgreSQL — memória, perfis, FAQ |
| zod | `^4.1.11` | Validação e parse do `ExecutionPayload` |
| pino | `^9.9.4` | Logger estruturado JSON com níveis por módulo |
| tsx | `^4.19.3` | Execução TypeScript em dev (`npm run dev`) |
| vitest | `^4.1.0` | Framework de testes unitários e de integração |
| dotenv | `^16.6.1` | Carregamento de variáveis de ambiente |

LLMs suportados (configuração em runtime, sem dependência npm dedicada — chamadas via `fetch` nativo):

| Provedor | Seleção |
|---|---|
| OpenAI | `DEFAULT_LLM_PROVIDER=openai` + `OPENAI_API_KEY` |
| Google Gemini | `DEFAULT_LLM_PROVIDER=gemini` + `GEMINI_API_KEY` |

---

## Decisões de Design

### Por que BullMQ e não HTTP direto

O harness não expõe uma API HTTP para receber jobs. O orchestration-service publica jobs na fila BullMQ (`HARNESS_QUEUE_NAME`, padrão `bevox.execution.dispatch`) e o harness consome de forma assíncrona.

**Benefícios concretos:**

- **Desacoplamento de ciclo de vida**: o harness pode reiniciar, escalar ou ser substituído sem que o orchestration-service precise mudar. A fila absorve o tráfego durante um restart.
- **Retry nativo**: quando `handleExecution` lança uma exceção, o BullMQ recoloca o job na fila conforme as opções configuradas (backoff exponencial, máximo de tentativas) — sem lógica de retry no código da aplicação.
- **Backpressure**: o worker processa somente o que consegue; jobs em excesso ficam enfileirados no Redis sem pressionar o processo.
- **Processo separado**: o harness roda em container/processo próprio, com sua própria heap Node.js e limites de memória, evitando que a carga de raciocínio LLM afete a latência da API principal do Bevox.

### Por que pipeline + surface

Os agentes são divididos em dois tipos (`AgentType`):

- **Pipeline** (`MessageAnalyzerAgent`, `MemoryExtractorAgent`): executam antes de qualquer interação. Extraem contexto, classificam intenção, persistem fatos em memória. Não têm acesso a tools de ação; usam o engine `direct` (uma única chamada LLM).
- **Surface** (`SchedulerAgent` e futuros agentes): recebem o contexto já enriquecido e agem sobre o mundo — chamam tools de calendário, enviam mensagens, solicitam intervenção humana.

Essa separação garante que a **análise de contexto nunca bloqueia nem é bloqueada pela execução de tools**, e que o surface agent já começa com intenção e sentimento classificados, reduzindo calls LLM redundantes.

### Por que múltiplos engines de raciocínio

Nem toda tarefa exige o mesmo nível de planejamento. O `StrategyRouter` seleciona o engine conforme `AgentDefinition.reasoning.default`:

| Engine | Quando usar | Comportamento |
|---|---|---|
| `DirectEngine` | Agentes pipeline, respostas simples | Uma chamada LLM, sem loop |
| `ReactEngine` | Surface agents (padrão) | Loop Thought→Action→Observation; até 10 passos |
| `PlanExecuteEngine` | Tarefas multi-etapa complexas | Planeja todos os passos; replana se divergência > 0.6 |
| `ReWOOEngine` | Passos com dependências paralelas | Executa até 5 steps em paralelo |
| `ReflexionWrapper` | Qualquer engine com `onFailure: reflexion` | Envolve o engine base com loop de autocrítica |

O `StepEvaluator` pode **escalonar progressivamente** em runtime: se o número de steps ultrapassar `stepThreshold` ou ocorrer falha, o engine é substituído por um mais poderoso sem perder as observações acumuladas. Isso evita que tarefas simples paguem o custo de planejamento completo.

### Por que singleton registries

`AgentRegistry` e `ToolRegistry` são singletons (`getInstance()`). Isso reflete o modelo de execução:

- O harness é um **processo único** — não há múltiplas instâncias competindo pelo mesmo registry no mesmo processo.
- O bootstrap registra todos os agentes e tools **uma única vez** nas stages 3 e 5, antes de o consumer iniciar. Chamadas posteriores ao registry são somente leitura.
- Um registry singleton facilita a **injeção em testes** (pode-se passar instâncias via parâmetro no `ExecutionContext`) e abre caminho para **hot-reload futuro** sem reiniciar o processo — basta trocar o conteúdo do singleton.

---

## Relação com Bevox v2

| Aspecto | Detalhe |
|---|---|
| Quem despacha | `orchestration-service` do Bevox v2 |
| Como despacha | Publica job BullMQ na fila `bevox.execution.dispatch` (configurável via `HARNESS_QUEUE_NAME`) |
| Payload enviado | `ExecutionPayload`: `execution_id` (UUID), `execution_token`, `messages[]`, `account_id`, `agent_config`, `conversation`, `skills[]`, `callback_base_url` (opcional) |
| Autenticação de callback | Header `X-Execution-Token: <execution_token>` em todos os POSTs de retorno |
| Status intermediário | `POST /api/v1/executions/{id}/status` com `{ status: "running" }` logo após iniciar |
| Resultado final | `POST /api/v1/executions/{id}/complete` com `{ response, sentiment, strategy, usage }` |
| Deduplicação | Redis `SET NX` na chave `harness:dedup:{execution_id}` com TTL de 1 hora — jobs duplicados são descartados silenciosamente |
| Fallback humano | Se o `AgentRouter` resolver `request-human`, o harness chama `/complete` com `strategy: "request-human"` e resposta vazia, sinalizando ao Bevox para acionar um operador |

---

## Arquivos-Chave

| Arquivo | Papel |
|---|---|
| `src/index.ts` | Entry point — registra shutdown handlers e inicia o bootstrap |
| `src/bootstrap/runner.ts` | Orquestra as stages sequencialmente com logging e tratamento de falhas |
| `src/bootstrap/stages.ts` | Define as 7 stages de inicialização (infra-check → start-consumer) |
| `src/bootstrap/shutdown.ts` | Handlers SIGTERM/SIGINT — drena o worker BullMQ antes de encerrar |
| `src/runtime/execution-handler.ts` | Core da execução — orquestra pipeline, routing, surface loop e callbacks |
| `src/runtime/harness.ts` | `AgentHarness` — mantém referências a registries e session store |
| `src/runtime/agent-router.ts` | Mapeia `intent` → nome do surface agent |
| `src/integration/bullmq-consumer.ts` | Worker BullMQ que chama `handleExecution` por job |
| `src/integration/bevox-callback.ts` | Funções `updateStatus` e `sendComplete` para callbacks HTTP ao Bevox |
| `src/integration/llm-gateway.ts` | Adaptadores OpenAI e Gemini; factory `createLLMGateway` |
| `src/integration/calendar-client.ts` | Client HTTP para o Calendar Service externo |
| `src/reasoning/strategy-router.ts` | Seleciona e instancia o `ReasoningEngine` adequado ao agente |
| `src/reasoning/step-evaluator.ts` | Decide escalonamento de engine após cada step |
| `src/agents/types.ts` | Tipos centrais: `AgentDefinition`, `AgentType`, `ReasoningConfig`, `AgentPermissions` |
| `src/tools/registry.ts` | Singleton `ToolRegistry` — registra e resolve tools por nome |
| `src/agents/registry.ts` | Singleton `AgentRegistry` — registra e resolve agentes por nome e tipo |
| `src/session/session-store.ts` | Gerencia estado da execução no Redis (`harness:session:*`) |
| `src/permissions/evaluator.ts` | Filtra tools permitidas por agente e contexto |
| `src/config/harness-config.ts` | Agrega todas as configs de env em um objeto tipado |

---

## Documentação Relacionada

- [Bootstrap e Ciclo de Vida](./bootstrap-e-ciclo-de-vida.md) — detalhamento das 7 stages de inicialização
- [Agentes e Registro](./agentes-e-registro.md) — tipos de agentes, ciclo de vida e AgentRegistry
- [Motores de Raciocínio](./motores-de-raciocinio.md) — DirectEngine, ReactEngine, PlanExecuteEngine, ReWOOEngine, ReflexionWrapper
- [Contexto e Tokenização](./contexto-e-tokenizacao.md) — ContextBuilder, camadas e tokenizer
- [Ferramentas e Permissões](./ferramentas-e-permissoes.md) — ToolRegistry, PermissionsEvaluator e tool catalog
- [Memória e Classificação](./memoria-e-classificacao.md) — ContactFacts, ContactProfile e MessageAnalyzer
- [Integrações Externas](./integracoes-externas.md) — LLM Gateway, Calendar Client e Bevox Callback
- [Fluxo de Execução](./fluxo-de-execucao.md) — diagrama de sequência passo a passo
