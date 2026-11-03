# Integrações Externas do Agent Harness

O Agent Harness depende de cinco sistemas externos: fila de jobs (BullMQ/Redis), provedores de LLM (OpenAI e Gemini), serviço de calendário (HTTP REST), plataforma Bevox (callbacks HTTP) e o próprio Redis como session store. Este documento descreve cada integração, seus contratos e o papel que desempenham no ciclo de vida de uma execução.

Veja também: [bootstrap e ciclo de vida](./bootstrap-e-ciclo-de-vida.md) | [fluxo de execução](./fluxo-de-execucao.md)

---

## Diagrama de integrações

```
                          ┌─────────────────────────────────────┐
                          │          Agent Harness               │
                          │                                      │
      BullMQ/Redis ───────►  bullmq-consumer                    │
      (fila de jobs)      │       │                             │
                          │       ▼                             │
                          │  execution-handler                   │
                          │       │                             │
              ┌───────────┼───────┼─────────────┐              │
              │           │       │             │               │
              ▼           │       ▼             ▼               │
        LLM Gateway       │  Calendar        Bevox             │
      (OpenAI/Gemini) ◄───┘   Client        Callbacks          │
                          │       │             │               │
                          │       └──────┬──────┘               │
                          │              ▼                      │
                          │       Session Store                 │
                          │        (Redis)                      │
                          └─────────────────────────────────────┘
```

---

## BullMQ Consumer

**Arquivo:** `src/integration/bullmq-consumer.ts`

### Visão geral

O BullMQ Consumer é o ponto de entrada de execuções no harness. Ele instancia um `Worker` do BullMQ conectado ao Redis e fica aguardando jobs na fila configurada. Cada job recebido é encaminhado para `handleExecution`, que conduz o ciclo completo de uma execução de agente.

### Configuração da fila

O nome da fila é lido de `config.harness.queueName` (variável de ambiente `HARNESS_QUEUE_NAME`). A conexão Redis utiliza `config.redis.url`. Não há concorrência configurada explicitamente — o BullMQ usa o padrão (1 job por vez por worker).

### Ciclo de vida do worker

| Função | Responsabilidade |
|---|---|
| `startConsumer(ctx)` | Cria o `Worker`, registra listener de erro e salva referência em `activeWorker` |
| `stopConsumer()` | Chama `activeWorker.close()` e limpa a referência |
| `getActiveWorker()` | Retorna o worker ativo ou `null` |

O `startConsumer` recebe um `ExecutionContext` que contém todas as dependências compartilhadas (session store, LLM gateway, calendar client, etc.) e o repassa a `handleExecution` a cada job.

### Processamento de jobs e retry

O callback do worker chama `handleExecution(payload, ctx)`. Em caso de erro, a exceção é relançada (`throw err`), o que permite que o BullMQ aplique a política de retry configurada na publicação do job (backoff, tentativas máximas, etc.) — o harness em si não define essa política, ela fica a cargo do publicador.

### Payload schema

O payload do job chega como `job.data` (tipado como `unknown`). A validação e o parsing são responsabilidade de `handleExecution` e do runtime de execução.

---

## LLM Gateway

**Arquivo:** `src/integration/llm-gateway.ts`

### Visão geral

O LLM Gateway abstrai a comunicação com provedores de modelos de linguagem atrás de uma interface uniforme (`LLMGateway`). O harness suporta dois provedores nativamente — OpenAI e Gemini — e pode ser estendido para outros.

### Interface pública

```typescript
interface LLMGateway {
  complete(options: LLMRequestOptions): Promise<LLMResponse>
}
```

`LLMRequestOptions` aceita:

| Campo | Tipo | Descrição |
|---|---|---|
| `messages` | `LLMMessage[]` | Histórico de mensagens (`system`, `user`, `assistant`, `tool`) |
| `tools` | `LLMTool[]` | Ferramentas disponíveis (JSON Schema) |
| `responseSchema` | `Record<string, unknown>` | Saída estruturada (incompatível com `tools`) |
| `maxTokens` | `number` | Máximo de tokens gerados (padrão: 2048) |
| `temperature` | `number` | Temperatura de amostragem (padrão: 0) |

`LLMResponse` retorna:

| Campo | Tipo | Descrição |
|---|---|---|
| `content` | `string \| null` | Texto gerado |
| `tool_calls` | `LLMToolCall[]` | Chamadas de ferramenta solicitadas pelo modelo |
| `usage` | `{ input_tokens, output_tokens, total_tokens }` | Contagem de tokens |
| `model` | `string` | Identificador do modelo usado |
| `provider` | `string` | Nome do provider (`openai` ou `gemini`) |
| `latency_ms` | `number` | Latência medida pelo harness |

### Roteamento por provider e modelo

A factory `createLLMGateway(agentConfig)` resolve o provider e o modelo a partir de `agentConfig.default_model`. O formato esperado é `provider/model` (ex.: `openai/gpt-4o`, `gemini/gemini-1.5-pro`). Quando ausente, usa as variáveis de ambiente `DEFAULT_LLM_PROVIDER` e `DEFAULT_LLM_MODEL`.

```
agentConfig.default_model  ──►  resolveProvider()  ──►  "openai" → OpenAIAdapter
                                                    └──►  "gemini" → GeminiAdapter
                                                    └──►  desconhecido → OpenAIAdapter (fallback + warn)
```

### LlmClientBridge (adapters internos)

Cada adapter implementa `LLMGateway.complete()` com a lógica específica do provider:

- **OpenAIAdapter**: chama `POST https://api.openai.com/v1/chat/completions`. Suporta `tools` (com `tool_choice: auto`) e `responseSchema` (via `response_format: json_schema`). Requer `OPENAI_API_KEY`.
- **GeminiAdapter**: chama `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`. Mensagens `system` são convertidas em turnos `user`/`model` com prefixo `[SYSTEM]`. Suporta `tools` via `functionDeclarations` e `responseSchema` via `responseMimeType: application/json`. Requer `GEMINI_API_KEY`.

### Usage tracking

Ambos os adapters retornam `usage` com contagens de tokens normalizadas (`input_tokens`, `output_tokens`, `total_tokens`) independente das diferenças de nomenclatura entre as APIs (`prompt_tokens`/`completion_tokens` no OpenAI vs. `promptTokenCount`/`candidatesTokenCount` no Gemini). A latência em milissegundos é medida internamente com `Date.now()`.

---

## Calendar Client

**Arquivo:** `src/integration/calendar-client.ts`

### Visão geral

O Calendar Client é um HTTP client thin que encapsula chamadas REST ao serviço de calendário da Bevox. Todos os métodos são funções assíncronas exportadas diretamente (não há classe).

### Base URL e timeouts

A base URL é lida de `config.calendar.baseUrl` (variável `CALENDAR_BASE_URL`). Todas as requisições usam `AbortSignal.timeout(10000)` — timeout de **10 segundos**. Erros HTTP são convertidos em `Error` com status code e corpo da resposta.

### Métodos disponíveis

| Função | Método HTTP | Endpoint | Descrição |
|---|---|---|---|
| `checkHealth()` | GET | `/health` | Verifica se o serviço está acessível |
| `getAvailability(calendarId, date, serviceId?)` | GET | `/api/v1/calendars/{id}/availability?date=&serviceId=` | Retorna horários disponíveis |
| `createAppointment(calendarId, body, token?)` | POST | `/api/v1/calendars/{id}/appointments` | Cria um agendamento |
| `cancelAppointment(appointmentId, reason, token?)` | POST | `/api/v1/appointments/{id}/cancel` | Cancela um agendamento |
| `listAppointments(calendarId, dateFrom?, dateTo?, token?)` | GET | `/api/v1/calendars/{id}/appointments?dateFrom=&dateTo=` | Lista agendamentos de um calendário |
| `rescheduleAppointment(appointmentId, newDate, newStartTime, token?)` | PATCH | `/api/v1/appointments/{id}` | Reagenda um compromisso |
| `addToWaitlist(calendarId, body, token?)` | POST | `/api/v1/calendars/{id}/waitlist` | Adiciona à lista de espera |

### Autenticação

Os métodos que aceitam `token` opcional enviam o header `Authorization: Bearer {token}`. O token é o token de sessão do usuário final, não um token de serviço. O `checkHealth` e o `getAvailability` não requerem autenticação.

---

## Bevox Callbacks

**Arquivo:** `src/integration/bevox-callback.ts`

### Visão geral

O módulo de callbacks é responsável por notificar a plataforma Bevox sobre o progresso e resultado de cada execução. Utiliza um helper interno `post()` que adiciona automaticamente o header de autenticação `X-Execution-Token` e aplica timeout de 10 segundos em todas as chamadas.

### Autenticação

Todas as chamadas enviam o header `X-Execution-Token: {token}`, onde `token` é o token de execução recebido no payload do job. A base URL é configurada por `config.bevox.callbackBaseUrl`.

### Os 4 endpoints

#### 1. Atualização de status — `updateStatus`

```
POST /api/v1/executions/{executionId}/status
Body: { status: string }
```

Chamado no **início** da execução (status `running`) e ao **final** (status `completed` ou `failed`). Permite que a plataforma Bevox reflita o estado atual da execução em tempo real.

#### 2. Envio de traces — `sendTrace`

```
POST /api/v1/executions/{executionId}/traces
Body: { traces: [TraceEntry] }
```

Chamado a cada passo relevante do raciocínio do agente. Um `TraceEntry` contém:

| Campo | Tipo | Valores possíveis |
|---|---|---|
| `step` | `number` | Número sequencial do passo |
| `type` | `string` | `"thought"`, `"action"`, `"observation"` |
| `content` | `string` | Conteúdo textual do passo |
| `timestamp` | `string` | ISO 8601 |

#### 3. Streaming de resposta — `sendStream`

```
POST /api/v1/executions/{executionId}/stream
Body: { chunk: string, index: number }
```

Chamado durante a geração da resposta final para enviar chunks incrementais ao frontend. O `index` é um contador sequencial iniciado em zero.

#### 4. Conclusão da execução — `sendComplete`

```
POST /api/v1/executions/{executionId}/complete
Body: CompletePayload
```

Chamado **uma única vez** ao final da execução bem-sucedida. O `CompletePayload` contém:

| Campo | Tipo | Obrigatório |
|---|---|---|
| `response` | `string` | Sim — resposta final ao usuário |
| `sentiment` | `string` | Não |
| `strategy` | `string` | Não |
| `usage` | `{ prompt_tokens, completion_tokens }` | Não |

### Ordem dos callbacks numa execução típica

```
updateStatus("running")
  → sendTrace({ type: "thought", ... })  [0..N vezes]
  → sendTrace({ type: "action", ... })   [0..N vezes]
  → sendTrace({ type: "observation", ...}) [0..N vezes]
  → sendStream(chunk, index)             [0..N vezes]
  → sendComplete({ response, ... })
  → updateStatus("completed")
```

Em caso de falha: `updateStatus("failed")` sem chamada a `sendComplete`.

---

## Session Store

**Arquivo:** `src/session/session-store.ts`
**Tipos:** `src/session/types.ts`

### Visão geral

O `SessionStore` é um repositório Redis-backed que mantém o estado de cada execução ativa. É instanciado durante o bootstrap e injetado no `ExecutionContext`, sendo compartilhado por todos os módulos do pipeline.

### Padrão de chave

```
harness:session:{executionId}
```

### TTL

Cada chave expira automaticamente após **24 horas** (`SESSION_TTL_SECONDS = 86400`). O TTL é renovado a cada operação `create` e `update`.

### Estrutura de dados

`Session` (como armazenada no Redis):

```typescript
interface Session {
  id: string;           // execution_id
  state: SessionState;
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
}
```

`SessionState` (estado da execução):

| Campo | Tipo | Descrição |
|---|---|---|
| `executionId` | `string` | Identificador único da execução |
| `accountId` | `number` | Conta Bevox |
| `conversationId` | `number` | Conversa associada |
| `contactId` | `number?` | Contato (opcional) |
| `status` | `SessionStatus` | `pending`, `running`, `completed`, `failed` |
| `startedAt` | `string` | ISO 8601 |
| `completedAt` | `string?` | ISO 8601, preenchido ao final |
| `meta` | `Record<string, unknown>?` | Metadados arbitrários do pipeline |

### Métodos

| Método | Assinatura | Comportamento |
|---|---|---|
| `create` | `(executionId, state) → Session` | Cria nova entrada com `createdAt` e `updatedAt` = agora, TTL 24h |
| `get` | `(executionId) → Session \| null` | Lê e desserializa do Redis; retorna `null` se não existir |
| `update` | `(executionId, patch) → Session \| null` | Merge parcial de `SessionState`, atualiza `updatedAt`, renova TTL; retorna `null` se não existir |
| `delete` | `(executionId) → void` | Remove a chave imediatamente |

### Ciclo de vida da sessão

```
Job recebido ──► create(executionId, { status: "pending" })
                      │
                      ▼
              update({ status: "running" })
                      │
                      ├── [módulos do pipeline escrevem em meta]
                      │
                      ▼
              update({ status: "completed", completedAt })
                      │
                      ▼
              delete(executionId)   ← ou expira após 24h
```

---

## Referências cruzadas

- [Bootstrap e ciclo de vida](./bootstrap-e-ciclo-de-vida.md) — como o `ExecutionContext` (que contém todas as integrações) é montado na inicialização.
- [Fluxo de execução](./fluxo-de-execucao.md) — como as integrações são acionadas sequencialmente durante o processamento de um job.
