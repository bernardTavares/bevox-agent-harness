# Guia de Contribuição

Este documento explica como configurar o ambiente de desenvolvimento e como estender o harness com novos agentes, tools e motores de raciocínio.

## Documentos relacionados

- [Visão Geral](./visao-geral.md)
- [Bootstrap e Ciclo de Vida](./bootstrap-e-ciclo-de-vida.md)
- [Agentes e Registro](./agentes-e-registro.md)
- [Motores de Raciocínio](./motores-de-raciocinio.md)
- [Ferramentas e Permissões](./ferramentas-e-permissoes.md)
- [Contexto e Tokenização](./contexto-e-tokenizacao.md)
- [Memória e Classificação](./memoria-e-classificacao.md)
- [Integrações Externas](./integracoes-externas.md)
- [Fluxo de Execução](./fluxo-de-execucao.md)

---

## Setup do ambiente

### Pré-requisitos

| Dependência  | Versão mínima |
|---|---|
| Node.js      | 20+           |
| PostgreSQL   | 16+           |
| Redis        | 7+            |

### Passos iniciais

```bash
# 1. Clonar o repositório
git clone <repo-url>
cd bevox-agent-harness

# 2. Instalar dependências
npm install

# 3. Copiar o arquivo de variáveis de ambiente
cp .env.example .env
```

Abra o arquivo `.env` e preencha os valores obrigatórios:

```dotenv
# Banco de dados principal e do Bevox (podem ser o mesmo em dev)
DATABASE_URL=postgres://bevox:bevox@127.0.0.1:5432/bevox
BEVOX_DB_URL=postgres://bevox:bevox@127.0.0.1:5432/bevox

# Redis (BullMQ)
REDIS_URL=redis://127.0.0.1:6379

# Callback da plataforma Bevox
BEVOX_CALLBACK_BASE_URL=http://localhost:3000/api/v1

# Serviço de calendário externo
CALENDAR_SERVICE_URL=http://localhost:3009/api/v1

# Provedor LLM — pelo menos uma chave deve ser preenchida
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=
DEFAULT_LLM_PROVIDER=openai
DEFAULT_LLM_MODEL=gpt-4o-mini
```

### Rodar as migrations

As migrations devem ser aplicadas no banco apontado por `BEVOX_DB_URL` (banco compartilhado com a plataforma):

```bash
psql $DATABASE_URL -f migrations/001_memory_and_classifications.sql
```

A migration cria três tabelas: `contact_profiles`, `contact_facts` e `message_classifications`. Consulte [Memória e Classificação](./memoria-e-classificacao.md) para detalhes de esquema.

### Iniciar em modo desenvolvimento

```bash
npm run dev
```

O comando usa `tsx watch`, que reinicia automaticamente ao detectar alterações nos arquivos TypeScript em `src/`.

---

## Scripts disponíveis

| Script        | Comando          | Descrição                                                    |
|---|---|---|
| `dev`         | `tsx watch src/index.ts` | Servidor de desenvolvimento com hot-reload        |
| `build`       | `tsc`            | Compilação TypeScript para `dist/`                           |
| `start`       | `node dist/index.js` | Executa o build compilado (produção)                     |
| `test`        | `vitest run`     | Executa todos os testes unitários e de integração uma vez    |
| `lint`        | `eslint src/`    | Verificação estática de código                               |

---

## Como testar

O projeto usa **Vitest** como framework de testes. Para rodar:

```bash
npm test
```

Os testes ficam em `src/context/` e seguem estas convenções:

- Arquivos de teste unitário: `*.test.ts`
- Arquivos de teste de integração: `*.integration.test.ts`
- Cada arquivo de teste cobre o módulo de mesmo nome (ex.: `context-builder.test.ts` testa `context-builder.ts`)
- Mocks são declarados inline com `vi.fn()` / `vi.mock()` do Vitest — sem bibliotecas adicionais
- Testes de integração que precisam de banco de dados usam uma conexão real; certifique-se de que `DATABASE_URL` aponta para um banco de testes

---

## Receita: criar novo agente

### Passo 1 — Criar o arquivo do agente

Escolha o diretório conforme o tipo:

- **Pipeline** (processamento interno, sem interação direta com o usuário): `src/agents/pipeline/`
- **Surface** (interage diretamente com o usuário): `src/agents/surface/`

Crie o arquivo, por exemplo `src/agents/surface/my-agent.agent.ts`.

### Passo 2 — Implementar a factory function retornando `AgentDefinition`

Baseie-se no `SchedulerAgent` em `src/agents/surface/scheduler.agent.ts`:

```typescript
import { BaseAgent } from '../base-agent'
import type { AgentDefinition, AgentResult } from '../types'
import type { AgentExecutionContext } from '../execution-context'

export const myAgentDefinition: AgentDefinition = {
  name: 'my-agent',           // identificador único no registry
  type: 'surface',            // 'surface' | 'pipeline'
  description: 'Descrição do que este agente faz.',

  reasoning: {
    default: 'react',         // motor padrão
    escalation: {
      stepThreshold: 3,       // escalona após N passos
      escalateTo: 'plan-execute',
      parallelThreshold: 2,
      onFailure: 'reflexion',
    },
  },

  permissions: {
    required: ['send-message', 'read-calendar'],  // tools que devem existir
    optional: ['search-faq'],                      // tools usadas se disponíveis
    denied: ['write-profile'],                     // tools explicitamente bloqueadas
  },
}

export class MyAgent extends BaseAgent {
  constructor() {
    super(myAgentDefinition)
  }

  async execute(context: AgentExecutionContext): Promise<AgentResult> {
    // Agentes surface são executados via runSurfaceAgentLoop no ExecutionHandler.
    // Implemente aqui apenas se o agente for do tipo 'pipeline'.
    void context
    return {
      success: false,
      output: null,
      error: 'MyAgent.execute() deve ser chamado via runSurfaceAgentLoop',
    }
  }
}

export function createMyAgent(): MyAgent {
  return new MyAgent()
}
```

### Passo 3 — Registrar no stage `register-agents`

Edite `src/bootstrap/stages.ts`:

```typescript
// 1. Importar
import { createMyAgent } from '../agents/surface/my-agent.agent'

// 2. Adicionar o nome de todas as tools requeridas ao KNOWN_TOOL_NAMES (se novas)
const KNOWN_TOOL_NAMES = [
  // ... tools existentes ...
  'minha-nova-tool',
]

// 3. Registrar dentro do stage 'register-agents'
agentRegistry.register(createMyAgent())
```

O stage valida que todos os nomes em `permissions.required` existem em `KNOWN_TOOL_NAMES` antes de continuar o bootstrap. Se uma tool ainda não foi criada, adicione o nome agora e implemente a tool (ver próxima receita).

### Passo 4 — Adicionar routing rules (somente agentes surface)

Edite `src/runtime/agent-router.ts` e adicione entradas em `DEFAULT_ROUTE_RULES`:

```typescript
export const DEFAULT_ROUTE_RULES: RouteRule[] = [
  // ... regras existentes ...
  {
    intent: 'my-intent',
    agent: 'my-agent',       // deve corresponder a AgentDefinition.name
    fallback: 'request-human',
    priority: 8,             // maior valor = maior prioridade em caso de overlap
  },
]
```

Os intents são produzidos pelo `MessageAnalyzerAgent` e chegam em `AgentExecutionPayload.intent`.

### Passo 5 — Testar

Crie `src/agents/surface/my-agent.agent.test.ts` e verifique pelo menos:

1. Que `myAgentDefinition` tem os campos obrigatórios preenchidos
2. Que `createMyAgent()` retorna uma instância de `BaseAgent`
3. Que as `permissions.required` não contêm tools inválidas

---

## Receita: criar nova tool

### Passo 1 — Criar o arquivo da tool

Organize por categoria em `src/tools/<categoria>/`. As categorias existentes são:

- `calendar/` — operações no serviço de agenda
- `messaging/` — envio de mensagens e escalação humana
- `memory/` — leitura e escrita de perfil e fatos
- `knowledge/` — busca em base de conhecimento

Crie, por exemplo, `src/tools/calendar/my-action.tool.ts`.

### Passo 2 — Implementar `ToolDefinition` com `execute()`

Baseie-se em `src/tools/calendar/create-appointment.tool.ts`:

```typescript
import type { ToolDefinition, ToolResult } from '../types'
import type { AgentExecutionContext } from '../../agents/execution-context'

interface MyActionParams {
  required_field: string
  optional_field?: string
}

export const myActionTool: ToolDefinition = {
  name: 'my-action',                         // deve ser único no registry
  description: 'Descrição para o LLM usar na seleção da tool.',
  category: 'calendar',                      // categoria organizacional
  agentType: 'surface',                      // 'surface' | 'pipeline' | 'both'

  // JSON Schema dos parâmetros (exposto ao LLM)
  parameters: {
    type: 'object',
    required: ['required_field'],
    properties: {
      required_field: { type: 'string', description: 'Descrição do campo.' },
      optional_field: { type: 'string' },
    },
  },

  async execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult> {
    const p = params as MyActionParams

    // Validar parâmetros obrigatórios
    if (!p.required_field) {
      return { success: false, error: 'INVALID_PARAMS', detail: 'required_field é obrigatório' }
    }

    try {
      // Lógica da tool — use context.db, context.accountConfig, etc. conforme necessário
      const data = { result: p.required_field }
      return { success: true, data }
    } catch (err) {
      return { success: false, error: 'EXECUTION_ERROR', detail: String(err) }
    }
  },
}
```

### Passo 3 — Registrar em `src/tools/index.ts`

```typescript
// 1. Importar
import { myActionTool } from './calendar/my-action.tool'

// 2. Adicionar dentro de registerAllTools()
export function registerAllTools(registry: ToolRegistry): void {
  // ... registros existentes ...
  registry.register(myActionTool)
}

// 3. Reexportar
export { myActionTool }
```

### Passo 4 — Adicionar permissões nos agentes

Todo agente que precisar usar a nova tool deve declará-la em `permissions`:

```typescript
permissions: {
  required: ['my-action'],   // tool obrigatória — o bootstrap lança erro se não existir
  optional: [],
  denied: [],
},
```

Lembre-se também de adicionar o nome ao `KNOWN_TOOL_NAMES` em `src/bootstrap/stages.ts` (validação pré-registro, ver Passo 3 da receita de agentes).

---

## Receita: criar novo motor de raciocínio

### Passo 1 — Implementar a interface `ReasoningEngine`

A interface está definida em `src/reasoning/engine.ts`. Todo motor deve implementar cinco métodos:

```typescript
import type { AgentExecutionContext } from '../agents/execution-context'
import type { ToolDefinition } from '../tools/types'
import type {
  AgentResponse,
  Observation,
  Plan,
  ReasoningEngine,
  StepResult,
  ToolExecutor,
  TraceCallback,
} from './engine'

export class MyEngine implements ReasoningEngine {
  readonly strategy: AgentResponse['strategy'] = 'react' // use um valor existente ou expanda o union type

  /** Cria o plano inicial a partir do input do usuário. */
  async plan(input: string, context: AgentExecutionContext): Promise<Plan> {
    return {
      goal: input,
      steps: [{ index: 0, description: 'my-step' }],
      estimatedComplexity: 'low',
    }
  }

  /** Executa um passo: chama o LLM, decide a tool, invoca executeTool. */
  async step(
    plan: Plan,
    stepIndex: number,
    tools: ToolDefinition[],
    context: AgentExecutionContext,
    executeTool: ToolExecutor,
    traceCallback?: TraceCallback,
  ): Promise<StepResult> {
    // ... lógica de raciocínio ...
    return { stepIndex, success: true, durationMs: 0 }
  }

  /** Converte StepResult em Observation (resumo legível + stopSignal). */
  async observe(stepResult: StepResult, context: AgentExecutionContext): Promise<Observation> {
    return {
      stepIndex: stepResult.stepIndex,
      summary: JSON.stringify(stepResult.toolOutput ?? ''),
      success: stepResult.success,
      raw: stepResult,
      stopSignal: false,
    }
  }

  /** Decide se o loop deve continuar ou parar. */
  async shouldContinue(observations: Observation[], plan: Plan, context: AgentExecutionContext): Promise<boolean> {
    return observations.length < 10
  }

  /** Consolida todas as observações na resposta final. */
  async synthesize(observations: Observation[], plan: Plan, context: AgentExecutionContext): Promise<AgentResponse> {
    const last = observations[observations.length - 1]
    return {
      answer: last?.summary ?? '',
      observations,
      totalSteps: observations.length,
      strategy: this.strategy,
      escalated: false,
      retriesUsed: 0,
    }
  }
}
```

Consulte `src/reasoning/react.ts` como referência completa de implementação.

### Passo 2 — Adicionar o motor no `StrategyRouter`

Edite `src/reasoning/strategy-router.ts`:

```typescript
// 1. Importar
import { MyEngine } from './my-engine'

// 2. Adicionar case no switch dentro de build()
case 'my-strategy':
  engine = new MyEngine()
  break
```

Se o novo motor requer que o tipo `AgentResponse['strategy']` seja expandido, edite também a union type em `src/reasoning/engine.ts`:

```typescript
strategy: 'direct' | 'react' | 'plan-execute' | 'rewoo' | 'my-strategy'
```

### Passo 3 — Configurar em `AgentDefinition.reasoning`

Com o motor registrado, qualquer agente pode usá-lo:

```typescript
reasoning: {
  default: 'my-strategy',
  escalation: {
    stepThreshold: 5,
    escalateTo: 'plan-execute',
    onFailure: 'reflexion',
  },
},
```

O `StrategyRouter` seleciona o motor automaticamente em tempo de execução. Ver [Motores de Raciocínio](./motores-de-raciocinio.md) para entender o ciclo completo.

---

## Convenções de código

| Aspecto | Convenção |
|---|---|
| **Validação de entrada** | Use **Zod** para validar dados externos (payloads de API, variáveis de ambiente). Erros de validação devem ser tratados antes de entrar na lógica de negócio. |
| **Logging** | Use **Pino** (`import pino from 'pino'`). Instancie com `{ name: 'nome-do-modulo' }`. Nunca use `console.log` em código de produção. |
| **Registries** | `AgentRegistry` e `ToolRegistry` são **singletons** — acesse via `.getInstance()`. Nunca instancie diretamente fora de testes. |
| **Criação de agentes e tools** | Prefira **factory functions** (`createSchedulerAgent()`, `createMyAgent()`) ao invés de `new Agent()` espalhados pelo código. |
| **Tipos** | Defina tipos e interfaces em `types.ts` dentro de cada módulo (ex.: `src/agents/types.ts`, `src/tools/types.ts`). Evite tipos inline em arquivos de implementação. |
| **TypeScript** | `strict: true` habilitado. Sem `any` implícito. Compile com `npm run build` antes de abrir PRs. |
| **Testes** | Framework: **Vitest**. Arquivos: `*.test.ts` (unitário) e `*.integration.test.ts` (integração). Testes ficam junto ao código que testam, em `src/`. |
| **Nomenclatura de arquivos** | `kebab-case` para arquivos e diretórios. Sufixo obrigatório: `.agent.ts`, `.tool.ts`, `.test.ts`, `.layer.ts` conforme o tipo. |
