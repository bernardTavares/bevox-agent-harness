# Ferramentas e Sistema de Permissões

O harness expõe **13 ferramentas** organizadas em **4 categorias** funcionais. O acesso a cada ferramenta é controlado por **3 camadas de permissão** avaliadas em sequência antes de qualquer execução.

Referências relacionadas: [agentes](./agentes-e-registro.md) · [fluxo de execução](./fluxo-de-execucao.md)

---

## Visão Geral

```
13 ferramentas
├── calendar   (6)  — surface only
├── messaging  (2)  — surface only  [stop tools]
├── memory     (3)  — pipeline, pipeline, both
└── knowledge  (1)  — surface only
         ↓
  3 camadas de permissão
  ├── Camada 1 — Estática do agente   (denied[], agentType mismatch)
  ├── Camada 2 — Contexto de execução (unavailable, account denied)
  └── Camada 3 — evaluatePermission() → PermissionResult
```

---

## Interface `ToolDefinition`

Definida em `src/tools/types.ts`. Toda ferramenta implementa esta interface:

```typescript
export interface ToolDefinition {
  name: string                    // Identificador único (kebab-case)
  description: string             // Descrição legível para o LLM
  category: ToolCategory          // 'calendar' | 'messaging' | 'memory' | 'knowledge'
  agentType: ToolAgentType        // 'pipeline' | 'surface' | 'both'
  parameters: Record<string, unknown>  // JSON Schema (type: 'object' com properties)
  execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult>
}
```

- `name` deve ser único no registro; uma segunda tentativa de registrar o mesmo nome lança `Error`.
- `parameters` é um JSON Schema completo (incluindo `type`, `required`, `properties`) repassado ao LLM para geração de chamadas de função.
- `agentType` declara quem pode usar a ferramenta. O avaliador de permissões usa este valor para reforçar restrições de tipo — mesmo que o campo seja informativo na definição, a Camada 1 aplica a regra de forma programática para `pipeline` e `surface`.

---

## Interface `ToolResult`

Valor de retorno de toda execução de ferramenta:

```typescript
export interface ToolResult {
  success: boolean
  data?: unknown          // Payload de sucesso, estrutura livre por ferramenta
  error?: string          // Código de erro curto (ex.: 'INVALID_PARAMS')
  detail?: string         // Mensagem descritiva para logs e debugging
  errorCode?: 'PERMISSION_DENIED' | 'NOT_FOUND' | 'INVALID_PARAMS' | 'EXTERNAL_ERROR' | string
}
```

Convenção adotada pelas ferramentas existentes:
- Em falhas de validação: `success: false, error: 'INVALID_PARAMS', detail: <campo faltante>`.
- Em falhas de integração externa: `success: false, error: '<SERVIÇO>_ERROR', detail: String(err)`.
- Em sucesso: `success: true, data: { ... }`.

---

## As 13 Ferramentas

| Nome | Categoria | agentType | Descrição |
|------|-----------|-----------|-----------|
| `read-calendar` | calendar | surface | Consulta horários disponíveis em um calendário para uma data |
| `list-appointments` | calendar | surface | Lista agendamentos de um calendário em um intervalo de datas |
| `create-appointment` | calendar | surface | Cria um novo agendamento no calendário |
| `cancel-appointment` | calendar | surface | Cancela um agendamento existente |
| `reschedule-appointment` | calendar | surface | Reagenda um agendamento para nova data e horário |
| `waitlist-add` | calendar | surface | Adiciona o cliente à lista de espera de um calendário |
| `send-message` | messaging | surface | Envia resposta ao cliente (STOP tool — encerra o loop) |
| `request-human` | messaging | surface | Transfere a conversa para um agente humano (STOP tool) |
| `read-profile` | memory | both | Lê perfil do contato (campos fixos + fatos conhecidos) |
| `write-profile` | memory | pipeline | Atualiza campos fixos do perfil de contato |
| `write-fact` | memory | pipeline | Insere um fato dinâmico sobre o contato com score de confiança |
| `search-faq` | knowledge | surface | Busca semântica na base de FAQ via pg_trgm |

> **STOP tools**: `send-message` e `request-human` devem encerrar o loop de raciocínio ao serem invocadas. Elas chamam `bevoxCallback.sendComplete()` internamente, sinalizando o término da execução ao harness.

---

## ToolRegistry

Implementado como singleton em `src/tools/registry.ts`. Armazena todas as ferramentas registradas durante o bootstrap (estágio 5).

```typescript
export class ToolRegistry {
  static getInstance(): ToolRegistry        // Retorna a instância singleton
  register(tool: ToolDefinition): void      // Registra; lança Error se nome duplicado
  resolve(name: string): ToolDefinition | undefined   // Busca sem lançar
  resolveOrThrow(name: string): ToolDefinition        // Busca; lança se não encontrar
  markUnavailable(name: string): void       // Marca ferramenta como indisponível em runtime
  isAvailable(name: string): boolean        // true se registrada E não marcada indisponível
  getUnavailableNames(): string[]           // Lista de nomes marcados como indisponíveis
  getAllTools(): ToolDefinition[]           // Todas as ferramentas registradas
  listByCategory(category: ToolCategory): ToolDefinition[]  // Filtro por categoria
  has(name: string): boolean               // Verifica presença no registro
  all(): ToolDefinition[]                  // Alias de getAllTools()
}
```

A função `registerAllTools(registry)` exportada por `src/tools/index.ts` registra as 13 ferramentas no bootstrap. Nenhuma ferramenta é registrada automaticamente; todas requerem chamada explícita.

---

## As 3 Camadas de Permissão

A função central é `evaluatePermission()` em `src/permissions/evaluator.ts`. Ela avalia as camadas **em ordem** e retorna assim que encontrar uma negação.

### Camada 1 — Estática do Agente

Verifica restrições declaradas na definição do agente, que são conhecidas antes da execução.

**1a. Lista de negação do agente** (`agent.permissions.denied`):

```typescript
if (agent.permissions.denied.includes(tool.name)) {
  return { granted: false, tool: tool.name, reason: 'AGENT_STATIC_DENIED' }
}
```

Exemplo: agente com `denied: ['write-fact', 'write-profile']` nunca acessa ferramentas de escrita em memória, independente do contexto.

**1b. Incompatibilidade de tipo** (`AGENT_TYPE_MISMATCH`):

```typescript
// Ferramentas exclusivas de pipeline:
const PIPELINE_ONLY_TOOLS = new Set(['write-profile', 'write-fact'])
// Ferramentas exclusivas de surface:
const SURFACE_ONLY_TOOLS  = new Set(['send-message', 'request-human'])

if (PIPELINE_ONLY_TOOLS.has(tool.name) && agent.type === 'surface') {
  return { granted: false, tool: tool.name, reason: 'AGENT_TYPE_MISMATCH' }
}
if (SURFACE_ONLY_TOOLS.has(tool.name) && agent.type === 'pipeline') {
  return { granted: false, tool: tool.name, reason: 'AGENT_TYPE_MISMATCH' }
}
```

Um agente `surface` nunca acessa `write-profile` ou `write-fact`. Um agente `pipeline` nunca acessa `send-message` ou `request-human`.

---

### Camada 2 — Contexto de Execução

Verifica restrições conhecidas apenas em runtime, fornecidas via `PermissionContext`.

**2a. Ferramenta indisponível** (`TOOL_UNAVAILABLE`):

```typescript
if (context.unavailableTools.includes(tool.name)) {
  return { granted: false, tool: tool.name, reason: 'TOOL_UNAVAILABLE' }
}
```

Usado quando um serviço externo está fora do ar (ex.: `markUnavailable('read-calendar')` durante manutenção do calendário).

**2b. Negação a nível de conta** (`EXECUTION_CONTEXT_DENIED`):

```typescript
if (context.accountDeniedTools.includes(tool.name)) {
  return { granted: false, tool: tool.name, reason: 'EXECUTION_CONTEXT_DENIED' }
}
```

Permite que contas específicas desabilitem ferramentas por configuração, sem alterar definições de agentes.

---

### Camada 3 — Avaliação Final

Se nenhuma camada anterior negou, a permissão é concedida:

```typescript
return { granted: true, tool: tool.name }
```

O tipo `PermissionResult` representa o resultado final:

```typescript
export type PermissionResult =
  | { granted: true;  tool: string }
  | { granted: false; tool: string; reason: PermissionDenialReason }

export type PermissionDenialReason =
  | 'AGENT_STATIC_DENIED'       // Camada 1a
  | 'AGENT_TYPE_MISMATCH'       // Camada 1b
  | 'TOOL_UNAVAILABLE'          // Camada 2a
  | 'EXECUTION_CONTEXT_DENIED'  // Camada 2b
```

A função `filterPermittedTools()` aplica `evaluatePermission()` a cada ferramenta de uma lista e emite um `logger.warn` se alguma ferramenta marcada como `required` no agente foi negada.

---

## PermissionContext

Construído por `buildPermissionContext()` em `src/permissions/permission-context.ts` antes de cada execução:

```typescript
export interface PermissionContext {
  agentName: string          // Nome do agente em execução
  agentType: 'pipeline' | 'surface'
  accountId: number          // ID da conta (extraído do payload)
  inboxId?: number           // ID da caixa de entrada, se disponível
  conversationKey: string    // Chave da conversa (string ou execution_id como fallback)
  unavailableTools: string[] // Ferramentas desabilitadas em runtime (Camada 2a)
  accountDeniedTools: string[] // Ferramentas bloqueadas para esta conta (Camada 2b)
}
```

O `accountId` é resolvido a partir de `payload.account_id ?? payload.account?.id ?? 0`. O `conversationKey` usa `payload.conversation.id` quando disponível, caindo para `payload.execution_id` como fallback.

---

## Diagrama de Filtragem

```
┌─────────────────────────────────┐
│  ToolRegistry.all()             │  13 ferramentas registradas
│  [read-calendar, list-appts,    │
│   create-appt, cancel-appt,     │
│   reschedule-appt, waitlist-add,│
│   send-message, request-human,  │
│   read-profile, write-profile,  │
│   write-fact, search-faq, ...]  │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  Camada 1 — Filtro Estático     │
│  • agent.permissions.denied     │  → AGENT_STATIC_DENIED
│  • PIPELINE_ONLY / SURFACE_ONLY │  → AGENT_TYPE_MISMATCH
└────────────┬────────────────────┘
             │ ferramentas que passaram
             ▼
┌─────────────────────────────────┐
│  Camada 2 — Filtro de Contexto  │
│  • context.unavailableTools     │  → TOOL_UNAVAILABLE
│  • context.accountDeniedTools   │  → EXECUTION_CONTEXT_DENIED
└────────────┬────────────────────┘
             │ ferramentas permitidas
             ▼
┌─────────────────────────────────┐
│  filterPermittedTools()         │
│  → ToolDefinition[]             │  enviadas ao motor de raciocínio
│  + warn se required foi negada  │
└─────────────────────────────────┘
```

---

## Guia: Como Criar uma Nova Ferramenta

**Passo 1 — Criar o arquivo da ferramenta**

Crie `src/tools/<categoria>/<nome>.tool.ts`. Siga a convenção de nome em kebab-case:

```typescript
import type { ToolDefinition, ToolResult } from '../types'
import type { AgentExecutionContext } from '../../agents/execution-context'

interface MinhaTool Params {
  parametro_a: string
  parametro_b?: number
}

export const minhaToolTool: ToolDefinition = {
  name: 'minha-tool',
  description: 'Descrição curta e clara para o LLM.',
  category: 'calendar',        // ou 'messaging' | 'memory' | 'knowledge'
  agentType: 'surface',        // ou 'pipeline' | 'both'
  parameters: {
    type: 'object',
    required: ['parametro_a'],
    properties: {
      parametro_a: { type: 'string', description: 'Descrição do parâmetro' },
      parametro_b: { type: 'number' },
    },
  },
  async execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult> {
    const p = params as MinhaToolParams
    if (!p.parametro_a) {
      return { success: false, error: 'INVALID_PARAMS', detail: 'parametro_a é obrigatório' }
    }
    try {
      // lógica da ferramenta
      return { success: true, data: { resultado: '...' } }
    } catch (err) {
      return { success: false, error: 'EXTERNAL_ERROR', detail: String(err) }
    }
  },
}
```

**Passo 2 — Registrar em `src/tools/index.ts`**

Adicione o import e a chamada `registry.register()` dentro de `registerAllTools()`:

```typescript
import { minhaToolTool } from './<categoria>/minha-tool.tool'

// dentro de registerAllTools():
registry.register(minhaToolTool)
```

Adicione também ao bloco `export { ... }` no final do arquivo.

**Passo 3 — Verificar restrições de tipo**

Se a ferramenta for exclusiva de pipeline ou surface, adicione o nome aos conjuntos hardcoded em `src/permissions/evaluator.ts`:

```typescript
const PIPELINE_ONLY_TOOLS = new Set(['write-profile', 'write-fact', 'minha-tool'])
// ou
const SURFACE_ONLY_TOOLS  = new Set(['send-message', 'request-human', 'minha-tool'])
```

Ferramentas com `agentType: 'both'` não precisam de entrada nesses conjuntos.

**Passo 4 — Testar**

- Confirme que `ToolRegistry.getInstance().has('minha-tool')` retorna `true` após bootstrap.
- Teste o caminho de erro (`INVALID_PARAMS`) e o caminho de sucesso.
- Se a ferramenta chama serviço externo, teste com o serviço indisponível e verifique o `ToolResult` de falha.

**Checklist**

- [ ] Arquivo em `src/tools/<categoria>/<nome>.tool.ts`
- [ ] Interface de parâmetros tipada localmente
- [ ] Validação de parâmetros obrigatórios no início de `execute()`
- [ ] Retorno `ToolResult` em todos os caminhos (sem `throw`)
- [ ] Registrado em `registerAllTools()` e exportado de `src/tools/index.ts`
- [ ] Restrição de tipo aplicada no evaluator (se `pipeline` ou `surface` puro)
