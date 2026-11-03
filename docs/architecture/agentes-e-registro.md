# Agentes e Sistema de Registro

Este documento descreve a arquitetura de agentes do bevox-agent-harness: os tipos disponíveis, as interfaces que os definem, o registro centralizado, o roteamento de intenções e o guia para criação de novos agentes.

**Veja também:** [motores de raciocínio](./motores-de-raciocinio.md) · [ferramentas](./ferramentas-e-permissoes.md) · [fluxo de execução](./fluxo-de-execucao.md)

---

## Tipos de agente

```typescript
export type AgentType = 'pipeline' | 'surface'
```

### `pipeline` — pré-processamento

Agentes de pipeline são executados **antes** da resposta ao usuário, na fase de análise e enriquecimento da execução. Eles não interagem diretamente com o contato; seu papel é preparar dados para os agentes de surface e alimentar a memória do sistema.

Características:
- Executam chamadas LLM únicas e estruturadas (padrão DirectEngine, motor `direct`).
- Não enviam mensagens nem acessam ferramentas de ação (`denied: ['*']` ou lista explícita).
- Persistem resultados em tabelas auxiliares (classificações, perfil, fatos).
- Falhas são toleradas: o pipeline continua mesmo que um agente de pré-processamento retorne erro.

**Quando usar:** análise de sentimento/intenção, extração de dados pessoais, enriquecimento de contexto, validações silenciosas.

### `surface` — interação com o usuário

Agentes de surface são executados **durante** a fase de raciocínio e respondem diretamente ao contato. São os agentes que escolhem ferramentas, formulam respostas e encaminham para humano quando necessário.

Características:
- Usam motores de raciocínio iterativos (`react`, `plan-execute`, `rewoo`) com escalação configurável.
- Possuem permissões granulares: ferramentas obrigatórias (`required`), opcionais e negadas (`denied`).
- São selecionados dinamicamente pelo `AgentRouter` com base na intenção classificada.
- O método `execute()` atua como stub — a execução real é conduzida pelo `ExecutionHandler` via `runSurfaceAgentLoop`.

**Quando usar:** resposta ao contato, agendamento, cancelamento, FAQ, qualquer fluxo que produza uma mensagem de saída.

---

## Interface `AgentDefinition`

Definida em `src/agents/types.ts`, é a "ficha técnica" de um agente. Todo agente deve declarar exatamente uma instância desta interface.

```typescript
export interface AgentDefinition {
  name: string
  type: AgentType
  description: string
  reasoning: ReasoningConfig
  permissions: AgentPermissions
}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `name` | `string` | Identificador único do agente no registro. Usado para resolver rotas (`AgentRouter`) e recuperar a instância (`AgentRegistry.resolve`). Deve ser kebab-case (ex.: `"message-analyzer"`). |
| `type` | `'pipeline' \| 'surface'` | Determina em qual fase o agente é executado e como é tratado pelo harness. |
| `description` | `string` | Texto livre descrevendo o propósito do agente. Usado em logs e futuramente em interfaces de administração. |
| `reasoning` | `ReasoningConfig` | Configura o motor de raciocínio padrão e as regras de escalação. Ver seção abaixo. |
| `permissions` | `AgentPermissions` | Lista de ferramentas que o agente pode ou não utilizar. Ver seção abaixo. |

### `ReasoningConfig`

```typescript
export interface ReasoningConfig {
  default: 'direct' | 'react' | 'plan-execute' | 'rewoo'
  escalation?: {
    stepThreshold?: number
    escalateTo?: 'plan-execute' | 'rewoo'
    parallelThreshold?: number
    onFailure?: 'reflexion'
  }
}
```

| Campo | Descrição |
|---|---|
| `default` | Motor utilizado na ausência de condições de escalação. `direct` é adequado para agentes pipeline; `react` é o ponto de partida para agentes surface. |
| `escalation.stepThreshold` | Número de passos de raciocínio após o qual o motor escalona para `escalateTo`. |
| `escalation.escalateTo` | Motor de destino na escalação por número de passos (`plan-execute` ou `rewoo`). |
| `escalation.parallelThreshold` | Se o plano contiver N ou mais sub-tarefas independentes, usa ReWOO para execução paralela. |
| `escalation.onFailure` | Motor de recuperação aplicado quando o raciocínio falha. `reflexion` implementa autocrítica iterativa. |

Para detalhes sobre cada motor, consulte [motores de raciocínio](./motores-de-raciocinio.md).

### `AgentPermissions`

```typescript
export interface AgentPermissions {
  required: string[]
  optional?: string[]
  denied: string[]
}
```

| Campo | Descrição |
|---|---|
| `required` | Ferramentas sem as quais o agente não pode operar. O harness valida a disponibilidade antes de iniciar a execução. |
| `optional` | Ferramentas que o agente pode usar se disponíveis, mas cuja ausência não impede a execução. |
| `denied` | Ferramentas explicitamente proibidas para este agente. O valor `['*']` nega todas as ferramentas (comum em agentes pipeline). |

Para a lista completa de ferramentas e seus identificadores, consulte [ferramentas](./ferramentas-e-permissoes.md).

---

## `BaseAgent` — classe abstrata

Definida em `src/agents/base-agent.ts`.

```typescript
export abstract class BaseAgent {
  readonly definition: AgentDefinition

  constructor(definition: AgentDefinition) { ... }

  abstract execute(context: AgentExecutionContext): Promise<AgentResult>

  get name(): string
  get type(): AgentType
}
```

Todo agente concreto deve estender `BaseAgent` e implementar o método `execute()`.

### Método `execute()`

**Recebe:** `AgentExecutionContext` — contexto completo da execução, incluindo banco de dados, logger, cliente LLM, histórico de mensagens e identificadores da conta/contato/conversa (ver seção a seguir).

**Retorna:** `Promise<AgentResult>`:

```typescript
export interface AgentResult {
  success: boolean      // true se o agente concluiu sem erro fatal
  output: unknown       // payload de saída (estrutura livre, definida por cada agente)
  error?: string        // mensagem de erro se success = false
  modelUsed?: string    // identificador do modelo LLM utilizado
  processingMs?: number // tempo total de execução em milissegundos
}
```

As propriedades `name` e `type` são derivadas diretamente da `AgentDefinition` injetada no construtor.

---

## `AgentExecutionContext` — contexto de execução

Definido em `src/agents/execution-context.ts`. É o objeto passado a todo agente no momento da execução, fornecendo tudo que o agente precisa sem acesso a singletons globais.

```typescript
export interface AgentExecutionContext {
  // Identificadores
  executionId: string
  accountId: number
  contactId?: bigint
  conversationKey: string
  messageId?: bigint

  // Infraestrutura
  db: Pool
  logger: Logger

  // LLM
  llmClient: LlmClient
  accountConfig?: AccountConfig

  // Dados da conversa
  messages?: ConversationMessage[]
}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `executionId` | `string` | UUID único para esta execução. Usado em registros de auditoria e logs. |
| `accountId` | `number` | ID da conta (tenant) dona da conversa. Toda operação no banco deve ser filtrada por este valor. |
| `contactId` | `bigint?` | ID do contato. Pode ser ausente em execuções sem contato identificado (ex.: webhook anônimo). |
| `conversationKey` | `string` | Chave composta que identifica a conversa (geralmente `"accountId:channelId:contactRef"`). |
| `messageId` | `bigint?` | ID da mensagem que disparou a execução. Pode ser ausente em execuções programadas. |
| `db` | `Pool` | Pool de conexões PostgreSQL (pg). Use para consultas diretas ou para obter um `PoolClient` em transações. |
| `logger` | `Logger` | Logger Pino com contexto da execução já embutido. Prefira este logger ao invés de criar instâncias próprias. |
| `llmClient` | `LlmClient` | Cliente para chamadas de completude ao LLM. A implementação concreta é injetada pelo runtime (sub-projeto 4). |
| `accountConfig` | `AccountConfig?` | Configurações por conta: `llmModel`, `llmProvider`. Permite override do modelo padrão por tenant. |
| `messages` | `ConversationMessage[]?` | Histórico de mensagens da conversa disponíveis nesta execução. Cada item tem `direction`, `content`, `role`, `messageId` e `createdAt`. |

### Interfaces auxiliares do contexto

```typescript
// Chamada LLM estruturada
interface LlmCompletionRequest {
  model: string
  system: string
  user: string
  responseFormat?: { type: 'json_object' | 'text' }
  maxTokens?: number
}

// Resposta LLM
interface LlmCompletionResponse {
  content: string
  model: string
  promptTokens?: number
  completionTokens?: number
}

// Mensagem do histórico
interface ConversationMessage {
  direction: 'incoming' | 'outgoing'
  content: string
  role?: 'user' | 'assistant' | 'system'
  messageId?: bigint
  createdAt?: Date
}
```

---

## Os 3 agentes existentes

### 1. `MessageAnalyzerAgent`

| Atributo | Valor |
|---|---|
| **Nome** | `message-analyzer` |
| **Tipo** | `pipeline` |
| **Arquivo** | `src/agents/pipeline/message-analyzer.agent.ts` |
| **Propósito** | Classifica a mensagem recebida: sentimento, intenção, tópicos e urgência |
| **Motor padrão** | `direct` (sem escalação) |
| **Permissões required** | nenhuma |
| **Permissões denied** | `['*']` — nega todas as ferramentas |

**Funcionamento:** extrai o texto de todas as mensagens com `direction: 'incoming'` do contexto, faz uma única chamada LLM com `responseFormat: json_object` e persiste o resultado na tabela `message_classifications`.

**Output (`AgentResult.output`):**
```typescript
{
  sentiment: 'positive' | 'neutral' | 'negative' | 'frustrated' | 'angry' | 'confused'
  sentimentConfidence: number   // 0–1
  intent: string                // ex.: "scheduling", "question", "unknown"
  intentConfidence: number      // 0–1
  topics: string[]              // ex.: ["appointment", "doctor"]
  urgency: 'low' | 'medium' | 'high' | 'critical'
}
```

O campo `intent` produzido por este agente é o valor consumido pelo `AgentRouter` para selecionar o agente de surface.

---

### 2. `MemoryExtractorAgent`

| Atributo | Valor |
|---|---|
| **Nome** | `memory-extractor` |
| **Tipo** | `pipeline` |
| **Arquivo** | `src/agents/pipeline/memory-extractor.agent.ts` |
| **Propósito** | Extrai dados pessoais explicitamente mencionados pelo contato e atualiza perfil e fatos |
| **Motor padrão** | `direct` (sem escalação) |
| **Permissões required** | `read-profile`, `write-profile`, `write-fact` |
| **Permissões denied** | `send-message`, `request-human`, `create-appointment`, `cancel-appointment` |

**Funcionamento:** carrega o perfil atual e os fatos ativos do contato (`contactId` obrigatório), envia ao LLM o texto das mensagens recebidas e espera um JSON com itens classificados como `fixed` (campos de perfil) ou `dynamic` (fatos livres). Aplica threshold de confiança (itens abaixo de 0.5 são descartados) e persiste dentro de uma transação com `pg_advisory_xact_lock` para evitar escritas concorrentes no mesmo contato.

**Output (`AgentResult.output`):**
```typescript
{
  extracted: number    // total de itens gravados
  fixed: number        // itens gravados em contact_profiles
  dynamic: number      // itens gravados em contact_facts
  discarded: number    // itens com confiança < 0.5
}
// ou, se não havia nada a extrair:
{ extracted: [], skipped: false }
// ou, se skipped por ausência de contactId ou mensagem:
{ skipped: true, reason: 'no_contact_id' | 'no_incoming_message' }
```

---

### 3. `SchedulerAgent`

| Atributo | Valor |
|---|---|
| **Nome** | `scheduler` |
| **Tipo** | `surface` |
| **Arquivo** | `src/agents/surface/scheduler.agent.ts` |
| **Propósito** | Trata intenções de agendamento: marcar, cancelar, reagendar consultas e perguntas gerais |
| **Motor padrão** | `react` |
| **Escalação** | após 3 passos → `plan-execute`; 2+ sub-tarefas paralelas → `rewoo`; falha → `reflexion` |
| **Permissões required** | `read-calendar`, `create-appointment`, `send-message` |
| **Permissões optional** | `cancel-appointment`, `reschedule-appointment`, `waitlist-add`, `search-faq`, `read-profile` |
| **Permissões denied** | `write-profile`, `write-fact` |

**Funcionamento:** o método `execute()` é um stub que retorna erro se chamado diretamente. A execução real é conduzida pelo `ExecutionHandler` via `runSurfaceAgentLoop`, que usa a `reasoning` config para selecionar e orquestrar o motor correto. O agente existe no registro principalmente como portador da `AgentDefinition` (permissões e configuração de raciocínio).

**Output:** determinado pelo motor de raciocínio em execução; tipicamente inclui a mensagem enviada ao contato e metadados de ferramentas utilizadas.

---

## `AgentRegistry` — singleton de registro

Definido em `src/agents/registry.ts`.

O `AgentRegistry` é um singleton que mantém o mapa de todos os agentes registrados no sistema. O registro é populado durante o bootstrap (estágio 3) e permanece imutável durante a vida do processo.

```typescript
export class AgentRegistry {
  static getInstance(): AgentRegistry
  register(agent: BaseAgent): void
  resolve(name: string): BaseAgent
  listByType(type: AgentType): BaseAgent[]
  has(name: string): boolean
}
```

### Métodos

| Método | Assinatura | Comportamento |
|---|---|---|
| `getInstance()` | `() → AgentRegistry` | Retorna a instância singleton, criando-a na primeira chamada. |
| `register()` | `(agent: BaseAgent) → void` | Registra um agente pelo `agent.name`. Lança erro se o nome já estiver registrado (proteção contra duplo-registro). |
| `resolve()` | `(name: string) → BaseAgent` | Retorna o agente com o nome informado. Lança erro se não encontrado. Use para recuperar um agente específico para execução. |
| `listByType()` | `(type: AgentType) → BaseAgent[]` | Retorna todos os agentes de um tipo (`'pipeline'` ou `'surface'`). Útil para executar todos os agentes de pipeline em sequência. |
| `has()` | `(name: string) → boolean` | Verifica se um agente está registrado sem lançar exceção. Usado internamente pelo `AgentRouter`. |

O registro utiliza um `Map<string, BaseAgent>` interno, portanto as operações de leitura têm complexidade O(1).

---

## `AgentRouter` — mapeamento de intenção para agente

Definido em `src/runtime/agent-router.ts`.

O `AgentRouter` recebe a string de intenção produzida pelo `MessageAnalyzerAgent` e retorna o nome do agente de surface a ser executado.

### Tabela de rotas padrão (`DEFAULT_ROUTE_RULES`)

| Intenção | Agente | Fallback | Prioridade |
|---|---|---|---|
| `scheduling` | `scheduler` | `request-human` | 10 |
| `scheduling_confirmation` | `scheduler` | `request-human` | 10 |
| `scheduling_cancellation` | `scheduler` | `request-human` | 10 |
| `scheduling_reschedule` | `scheduler` | `request-human` | 10 |
| `question` | `scheduler` | `request-human` | 5 |
| `unknown` | `scheduler` | `request-human` | 1 |

As regras são ordenadas por prioridade decrescente na construção do router. Em caso de sobreposição, a regra de maior prioridade vence.

### Método `resolve()`

```typescript
resolve(intent: string, agentRegistry: AgentRegistry): string
```

Percorre as regras em ordem de prioridade. Para a primeira regra que corresponda à intenção:
1. Verifica se o agente está registrado via `agentRegistry.has()`.
2. Se sim, retorna o nome do agente.
3. Se não, loga um aviso e retorna `rule.fallback`.

Se nenhuma regra corresponder à intenção, loga um aviso e retorna `'request-human'`.

O valor especial `'request-human'` indica ao `ExecutionHandler` que nenhum agente autônomo deve responder e a conversa deve ser escalada para atendimento humano.

### Extensão com regras extras

```typescript
export function createAgentRouter(extraRules: RouteRule[] = []): AgentRouter
```

A função `createAgentRouter` aceita regras adicionais que são mescladas com `DEFAULT_ROUTE_RULES`. Use `priority` maior que 10 para sobrepor as regras padrão.

---

## Guia: como criar um novo agente

### Passo 1 — Criar o arquivo do agente

Escolha o diretório conforme o tipo:
- Agente pipeline: `src/agents/pipeline/meu-agente.agent.ts`
- Agente surface: `src/agents/surface/meu-agente.agent.ts`

### Passo 2 — Definir a `AgentDefinition` e implementar a classe

```typescript
import { BaseAgent } from '../base-agent'
import { AgentDefinition, AgentResult } from '../types'
import { AgentExecutionContext } from '../execution-context'

const DEFINITION: AgentDefinition = {
  name: 'meu-agente',            // kebab-case, único no sistema
  type: 'pipeline',              // ou 'surface'
  description: 'Descrição curta do que este agente faz',
  reasoning: {
    default: 'direct',           // 'direct' para pipeline; 'react' como ponto de partida para surface
    // escalation: { ... }       // apenas para agentes surface que precisam escalar
  },
  permissions: {
    required: [],                // ferramentas sem as quais o agente não pode operar
    optional: [],                // ferramentas usadas quando disponíveis
    denied: ['*'],               // para pipeline: negar tudo; para surface: listar explicitamente
  },
}

export class MeuAgenteAgent extends BaseAgent {
  constructor() {
    super(DEFINITION)
  }

  async execute(context: AgentExecutionContext): Promise<AgentResult> {
    // Para agentes pipeline: lógica de processamento, chamada LLM, persistência
    // Para agentes surface: retornar erro orientando uso via runSurfaceAgentLoop
    return { success: true, output: { /* ... */ } }
  }
}

export function createMeuAgenteAgent(): MeuAgenteAgent {
  return new MeuAgenteAgent()
}
```

Para agentes pipeline que usam o banco de dados diretamente, injete `Pool` no construtor (ver `MessageAnalyzerAgent` e `MemoryExtractorAgent` como referência).

### Passo 3 — Registrar no bootstrap (estágio 3)

Localize o arquivo de bootstrap do sistema e adicione o registro do novo agente no estágio 3 (registro de agentes):

```typescript
import { createMeuAgenteAgent } from '../agents/pipeline/meu-agente.agent'

// dentro da função de bootstrap, estágio 3:
const registry = AgentRegistry.getInstance()
registry.register(createMeuAgenteAgent())
```

Consulte [bootstrap e ciclo de vida](./bootstrap-e-ciclo-de-vida.md) para localizar o ponto exato de registro.

### Passo 4 — Adicionar regra de roteamento (apenas para agentes surface)

Se o novo agente for do tipo `surface`, adicione uma ou mais `RouteRule` ao criar o router:

```typescript
import { createAgentRouter } from '../runtime/agent-router'

const router = createAgentRouter([
  {
    intent: 'minha_intencao',
    agent: 'meu-agente',
    fallback: 'request-human',
    priority: 10,       // maior que regras existentes para sobrepô-las, ou igual para coexistir
  },
])
```

Se a intenção for nova (não produzida pelo `MessageAnalyzerAgent`), também atualize o prompt de classificação daquele agente.

### Passo 5 — Verificar

- O nome em `DEFINITION.name` deve ser único no registry (o `register()` lança erro em duplicatas).
- Permissões `required` devem estar disponíveis no harness para o tipo de conta esperado.
- Para agentes pipeline, verifique se o agente é tolerante a falha (retornar `success: false` sem lançar exceção).

---

## Arquivos-chave

| Arquivo | Responsabilidade |
|---|---|
| `src/agents/types.ts` | Tipos base: `AgentType`, `AgentDefinition`, `ReasoningConfig`, `AgentPermissions`, `AgentResult` |
| `src/agents/base-agent.ts` | Classe abstrata `BaseAgent` |
| `src/agents/registry.ts` | Singleton `AgentRegistry` |
| `src/agents/execution-context.ts` | Interface `AgentExecutionContext` e tipos auxiliares (LLM, mensagens, config) |
| `src/agents/pipeline/message-analyzer.agent.ts` | Agente `message-analyzer` |
| `src/agents/pipeline/memory-extractor.agent.ts` | Agente `memory-extractor` |
| `src/agents/surface/scheduler.agent.ts` | Agente `scheduler` |
| `src/runtime/agent-router.ts` | `AgentRouter`, `DEFAULT_ROUTE_RULES`, `RouteRule` |
