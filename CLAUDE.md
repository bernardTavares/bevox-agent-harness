# Bevox Agent Harness — Contexto do Projeto

## O que é

Harness de execução de agentes IA para a plataforma Bevox. Consome jobs via BullMQ, executa pipeline de agentes (análise de mensagem + extração de memória), roteia para agente de superfície com motores de raciocínio (ReAct, Plan&Execute, ReWOO), e retorna resultado via callbacks HTTP.

## Arquitetura

Processo Node.js/TypeScript isolado. NÃO expõe API REST — consome de fila BullMQ e produz callbacks HTTP.

```
BullMQ Queue (bevox.execution.dispatch)
  → Execution Handler
    → Pipeline Agents (MessageAnalyzer, MemoryExtractor)
    → Agent Router (intent → agent)
    → Context Builder (4 layers ativos atrás de CONTEXT_BUILDER_ENABLED; Calendar adiada — CTX-01/#39)
    → Permission Filter (3 camadas)
    → Surface Agent Loop (reasoning engine + tools)
  → Bevox Callbacks (POST /executions/{id}/complete)
```

## Stack

- **Runtime**: Node.js 20+, TypeScript 5.9 (ESM/NodeNext desde Sprint B.0)
- **Queue**: BullMQ 5 / Redis (ioredis 5)
- **DB**: PostgreSQL 16 (pg 8)
- **Validação**: Zod 4
- **Logging**: Pino 9
- **Testes**: Vitest 4
- **Dev**: tsx (hot reload)

## Estrutura de Diretórios

```
src/
  agents/           — Definições e implementações de agentes
    pipeline/       — MessageAnalyzer, MemoryExtractor
    surface/        — Scheduler
  bootstrap/        — 7 estágios de inicialização
  config/           — Env (Zod) + harness config
  context/          — Context builder com 5 layers (4 vivos via CONTEXT_BUILDER_ENABLED=true; CalendarLayer adiada — requer CalendarContextAdapter, follow-up de #39) + tokenizer + budget-enforcer
  integration/      — BullMQ consumer, LLM Gateway, Calendar Client, Callbacks
  memory/           — Repositories (contact_profiles, contact_facts)
  permissions/      — Evaluator com 3 camadas
  reasoning/        — 5 engines (Direct, ReAct, Plan&Execute, ReWOO, Reflexion)
  runtime/          — Execution handler, agent router, harness
  session/          — Session store (Redis)
  tools/            — 12 tools em 4 categorias (definidas como skills sob src/skills-builtin/; SKILLS-05)
    calendar/       — 6 tools (CRUD appointments + waitlist)
    messaging/      — 2 tools (send-message, request-human) — STOP signals
    memory/         — 3 tools (read-profile, write-profile, write-fact)
    knowledge/      — 1 tool (search-faq)
  skills-builtin/   — todas as 15 skills (12 tools + 3 sales) carregadas no UnifiedToolRegistry
```

## Padrões Críticos

### Configuração — Zod singleton com cache

```typescript
import { getEnv } from "./config/env";
import { getHarnessConfig } from "./config/harness-config";
// getEnv() valida com Zod e cacheia. Falha → process.exit(1)
```

### Agentes — Factory function + AgentDefinition

```typescript
interface AgentDefinition {
  name: string;
  type: "pipeline" | "surface";
  description: string;
  reasoning: { default: "direct"|"react"|"plan-execute"|"rewoo", escalation?: {...} };
  permissions: { required: string[], optional?: string[], denied: string[] };
}
```

Pipeline agents: pré-processamento (análise, extração). Usam engine `direct`.
Surface agents: interagem via tools. Usam ReAct com escalation.

### Tools — ToolDefinition com execute()

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  category: "calendar" | "messaging" | "memory" | "knowledge";
  agentType: "pipeline" | "surface" | "both";
  parameters: Record<string, unknown>; // JSON Schema
  execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult>;
}
```

### Reasoning Engines — Interface ReasoningEngine

5 métodos: `plan()`, `step()`, `observe()`, `shouldContinue()`, `synthesize()`

Escalation automática via StepEvaluator:

- stepThreshold atingido → escalate para plan-execute
- parallelThreshold → escalate para rewoo
- Falha → wrap com Reflexion

### Permissões — 3 camadas

1. **Agent Static**: `denied` tools + `agentType` mismatch
2. **Execution Context**: tools marcadas unavailable + account denied list
3. **Avaliação**: `evaluatePermission()` combina as 3 → `PermissionResult`

### Registries — Singleton pattern

```typescript
AgentRegistry.getInstance().register(agent);
UnifiedToolRegistry.getInstance().register(skill);
// Populados no bootstrap (stages 3 e 5)
```

`UnifiedToolRegistry` é o ÚNICO store canônico de tools+skills (não há mais
`ToolRegistry`/`SkillRegistry` separados — unificados em SKILLS-05).

## Fluxo de Execução (10 passos)

1. Validar payload (Zod)
2. Deduplicação Redis (`SET harness:dedup:{id} EX 3600 NX`)
3. Criar session Redis
4. Callback status "running"
5. Pipeline: MessageAnalyzer (25% timeout) → MemoryExtractor (25% timeout, non-fatal)
6. AgentRouter.resolve(intent) → surface agent (fallback: request-human)
7. Build context (5 layers com token budget)
8. Filtrar permissões
9. Surface agent loop (engine + tools + escalation) — 50% timeout
10. Callback complete (response, sentiment, strategy, usage)

## Bootstrap (7 estágios sequenciais)

1. infra-check — DB ping + Redis PONG
2. load-config — Validar env vars (Zod)
3. register-agents — Registrar 3 agentes
4. warmup-pipeline — Verificar API keys LLM
5. load-tools-permissions — Carregar skills (15: 12 tools + 3 sales) no `UnifiedToolRegistry`; sem `registerAllTools` legado
6. calendar-health — Health check Calendar Service
7. start-consumer — Iniciar BullMQ worker

Falha em qualquer estágio → `process.exit(1)`

## Dev Environment

```bash
npm run dev      # tsx watch (hot reload)
npm run build    # tsc
npm run start    # node dist/index.js
npm run test     # vitest
npm run lint     # eslint
```

## Variáveis de Ambiente

```
DATABASE_URL=postgres://...              # PostgreSQL (obrigatório)
REDIS_URL=redis://...                    # Redis (obrigatório)
BEVOX_CALLBACK_BASE_URL=http://...      # URL base do Bevox para callbacks
CALENDAR_SERVICE_URL=http://...:3009/... # Calendar Service
OPENAI_API_KEY=...                       # ou GEMINI_API_KEY
DEFAULT_LLM_PROVIDER=openai              # openai | gemini
DEFAULT_LLM_MODEL=gpt-4o-mini
HARNESS_QUEUE_NAME=bevox.execution.dispatch
HARNESS_MAX_EXECUTION_TIME_MS=90000
HARNESS_LOG_LEVEL=info
```

## Migrations

```bash
node scripts/migrate.mjs       # aplica todas em migrations/ por ordem lex; registra em schema_migrations
```

Cria: `contact_profiles`, `contact_facts`, `message_classifications`, `rag_documents`, `rag_chunks`, `message_embeddings`, `workflow_executions`, etc. (11 migrations).

## Infraestrutura (orientação)

O harness foi desenhado para rodar como **2 réplicas worker-only** (sem porta HTTP exposta) num cluster na Hetzner Cloud gerenciado por um repositório de infraestrutura separado (privado). O relevante aqui:

- **Imagem:** `ghcr.io/bernardtavares/bevox-harness:vX.Y.Z` (digest pinado no manifest do hub). Build via GHA `release.yml` em tag SemVer. Dockerfile single-stage (sem split runtime/migrator).
- **DB requer `pgvector`** (M0006 rag_embeddings). Imagem PG: `ghcr.io/bernardtavares/bevox-postgres` (pg16 + pg_uuidv7 + pgvector). `postgres:16-alpine` puro **não** serve.
- **Trap em `001_memory_and_classifications.sql`:** referencia `REFERENCES accounts(id)` mas a tabela `accounts` nunca foi criada por nenhuma migration do harness (assumia-se que o app a criava antes — não acontece em deploy do zero). Workaround para subir do zero:
  ```sql
  CREATE TABLE accounts (id INTEGER PRIMARY KEY);    -- stub antes da 001
  -- node scripts/migrate.mjs
  DROP TABLE accounts CASCADE;                       -- depois — a 011 (org_id tenancy) já dropou os FKs
  ```
- **Callbacks para o backend** vão por DNS interno (`http://bevox-backend:3000`), não pelo endpoint público `api.example.com`. Em prod, `BEVOX_CALLBACK_BASE_URL` aponta pro nome de serviço Docker, não pro tunnel.
- **Bootstrap stage `calendar-health`** faz HEAD em `CALENDAR_SERVICE_URL`. Em prod sem Calendar Service deployado, apontar para `http://bevox-backend:3000` — 404 é OK, só timeouts/network errors abortam.

Manifest, smoke scripts e runbook: repositório de infraestrutura (privado). Topologia cross-repo: `$BEVOX_KNOWLEDGE_PATH/20_architecture/_shared/runtime-topology.md`.

## Integração com Bevox v2

- Bevox orchestration-service despacha via BullMQ (queue: `bevox.execution.dispatch`)
- Payload (pós ADR-019 tenancy): `{ execution_id, execution_token, organization_id (UUID), execution_mode, messages, agent_config, skills, ... }`. **Não usar `account`/`workspace_id`** (léxico legado retirado per ADR-019/ADR-021).
- Harness retorna via HTTP callbacks com header `X-Execution-Token` — **4 endpoints** (`/stream` foi adicionado em Marco-2):
  - `PATCH /executions/{id}/status` — status intermediário
  - `POST /executions/{id}/traces` — traces de raciocínio
  - `POST /executions/{id}/stream` — chunks incrementais (streaming)
  - `POST /executions/{id}/complete` — resultado final (campos obrigatórios pelo backend: `response_text`, `sentiment`, `strategy`, `usage`)

## Documentação

- `docs/architecture/` — 10 documentos técnicos completos
- `openapi/agent-harness-v1.yaml` — OpenAPI 3.1 spec
- `docs/superpowers/specs/` — Design specs
- `docs/superpowers/plans/` — Planos de implementação

## Agentes Disponíveis (`.claude/agents/`)

Agentes especializados instalados localmente neste projeto. Invoque via tool `Agent` apenas quando o problema bater com a descrição — não use preventivamente.

### Core — alto uso

- **AI Engineer** (`engineering-ai-engineer`) — trabalho em reasoning engines (ReAct, Plan&Execute, ReWOO, Reflexion), context builder (5 layers, token budget), LLM Gateway, prompts de pipeline agents e surface agents. Default para qualquer mudança em `src/reasoning/`, `src/context/`, `src/agents/`, `src/integration/llm-gateway/`.
- **Backend Architect** (`engineering-backend-architect`) — desenho de queue/worker, schema Postgres (`contact_profiles`, `contact_facts`, `message_classifications`), fluxos de callback, integração Hermes (plano de 8 fases), escalabilidade horizontal. Use antes de mudanças estruturais.
- **MCP Builder** (`specialized-mcp-builder`) — camada de tools (13 tools em calendar/messaging/memory/knowledge), `ToolDefinition`, registries singleton, padrões de exposição/permissão. Use ao adicionar tool nova ou refatorar `src/tools/`.
- **Code Reviewer** (`engineering-code-reviewer`) — invoque ao fim de cada feature antes de commit. Crítico dado que cobertura Vitest é mínima. Combine com a skill `superpowers:code-reviewer` (disponível globalmente) para revisão em duas camadas.

### Testes e qualidade

- **API Tester** (`testing-api-tester`) — testes para payloads BullMQ, callbacks HTTP Bevox (`/executions/{id}/complete`, `/traces`, `/status`), Calendar Service. Use para construir suíte de integração.
- **Test Results Analyzer** (`testing-test-results-analyzer`) — análise de cobertura Vitest, falhas flaky, priorização do que testar primeiro nos 5 reasoning engines + 13 tools.
- **Performance Benchmarker** (`testing-performance-benchmarker`) — token budgets do context builder, thresholds de auto-escalation (stepThreshold, parallelThreshold), memory leaks em loop de worker long-running, latência por engine.

### Infraestrutura e operação

- **Database Optimizer** (`engineering-database-optimizer`) — queries no hot path (`contact_profiles`, `contact_facts`, `message_classifications`), índices, planos de execução Postgres. Invoque quando uma query específica doer.
- **DevOps Automator** (`engineering-devops-automator`) — pipelines de deploy do worker, configuração Redis/BullMQ, observabilidade Pino.
- **Infrastructure Maintainer** (`support-infrastructure-maintainer`) — ops contínua: escalar workers, monitorar fila, custo Redis.
- **Security Engineer** (`engineering-security-engineer`) — auditoria do permission evaluator de 3 camadas (`src/permissions/`), tool execution sandboxing, validação de payloads externos. Crítico antes de produção.
- **Incident Response Commander** (`engineering-incident-response-commander`) — quando estiver em produção: queue backlog, callbacks falhando em cascata, cascade timeouts.
- **SRE** (`engineering-sre`) — SLOs do worker, error budgets, observabilidade, toil reduction. Pós-go-live.

### Situacional

- **Software Architect** (`engineering-software-architect`) — contratos cross-system com Bevox orchestration-service e Calendar Service, especialmente durante o Hermes alignment.
- **Technical Writer** (`engineering-technical-writer`) — manter `docs/architecture/` e `openapi/agent-harness-v1.yaml` em sincronia quando Hermes alignment trouxer mudanças de contrato.
- **Minimal Change Engineer** (`engineering-minimal-change-engineer`) — disciplina anti-scope-creep ao tocar reasoning engines ou permission evaluator (áreas onde refatoração inadvertida é cara).
- **Agentic Identity & Trust Architect** (`agentic-identity-trust`) — somente se surface agents passarem a agir entre contas ou provar autorização para sistemas externos (multi-tenant agent-to-agent).

### Regra de invocação

- Mexendo em reasoning/context/prompts → **AI Engineer**
- Mexendo em schema Postgres, queue topology, callbacks → **Backend Architect**
- Adicionando/mudando tool → **MCP Builder**
- Antes de commit de feature → **Code Reviewer**
- Não invoque mais de um agente em paralelo a menos que sejam domínios independentes.
