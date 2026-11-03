# Documentação Completa do Agent Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar documentação técnica completa do bevox-agent-harness com 10 docs de arquitetura + README.

**Architecture:** Cada task produz um documento markdown autocontido. O subagent deve ler os arquivos fonte referenciados para extrair informação real (interfaces, tipos, fluxos) — nunca inventar. Documentação em português.

**Tech Stack:** Markdown, diagramas ASCII, tabelas

**Spec:** `docs/superpowers/specs/2026-04-07-documentacao-completa.md`

**Projeto:** `bevox-agent-harness`

---

## File Structure

| Action | File | Descrição |
|--------|------|-----------|
| Create | `README.md` | Porta de entrada — visão geral, setup, links |
| Create | `docs/architecture/visao-geral.md` | Arquitetura alto nível, stack, decisões |
| Create | `docs/architecture/bootstrap-e-ciclo-de-vida.md` | 7 estágios, shutdown, health checks |
| Create | `docs/architecture/agentes-e-registro.md` | BaseAgent, pipeline/surface, registry |
| Create | `docs/architecture/motores-de-raciocinio.md` | 5 engines, escalation, strategy router |
| Create | `docs/architecture/contexto-e-tokenizacao.md` | 5 layers, prioridade, compressão |
| Create | `docs/architecture/ferramentas-e-permissoes.md` | 13 tools, 3 camadas de permissão |
| Create | `docs/architecture/memoria-e-classificacao.md` | 3 tabelas, repositories, fluxo |
| Create | `docs/architecture/integracoes-externas.md` | BullMQ, LLM Gateway, Calendar, Callbacks |
| Create | `docs/architecture/fluxo-de-execucao.md` | 10 passos do handler, timeouts, dedup |
| Create | `docs/architecture/guia-de-contribuicao.md` | Setup, testes, receitas de extensão |

---

## Instruções Gerais para Subagents

Cada task cria um documento. Para cada task:

1. **Leia os arquivos fonte** listados na seção "Arquivos para ler" — extraia interfaces, tipos, fluxos reais
2. **Escreva o documento** seguindo a estrutura indicada
3. **Referências cruzadas**: quando mencionar conceito coberto por outro doc, linke com `[texto](./outro-doc.md)`
4. **Arquivos-chave**: liste caminhos relativos à raiz do projeto (`src/...`)
5. **Diagramas**: use ASCII art com blocos ```` ```text ```` para fluxos e tabelas markdown para dados tabulares
6. **Idioma**: Português
7. **Commit** após criar o documento

---

### Task 1: README.md

**Files:**
- Create: `README.md`

**Arquivos para ler:**
- `package.json` (scripts, deps)
- `.env.example` (variáveis de ambiente)
- `src/index.ts` (entry point)
- `src/bootstrap/stages.ts` (visão geral dos estágios)

**Estrutura do documento:**
1. **Título**: "Bevox Agent Harness"
2. **O que é** (1 parágrafo): harness de execução de agentes IA para a plataforma Bevox. Consome jobs via BullMQ, executa pipeline de agentes (análise + extração de memória), roteia para agente de superfície com motores de raciocínio (ReAct, Plan&Execute, ReWOO), e retorna resultado via callbacks.
3. **Diagrama simplificado** (ASCII): BullMQ → Handler → Pipeline Agents → Surface Agent → Callbacks
4. **Pré-requisitos**: Node.js 20+, PostgreSQL 16+, Redis 7+
5. **Setup rápido**: clone, npm install, copiar .env.example, rodar migrations, npm run dev
6. **Scripts disponíveis**: tabela com cada script do package.json
7. **Variáveis de ambiente**: tabela com cada var do .env.example (nome, descrição, exemplo)
8. **Documentação**: lista com links para cada doc em `docs/architecture/`

- [ ] **Step 1: Ler arquivos fonte e escrever README.md**
- [ ] **Step 2: Commit**
```bash
git add README.md
git commit -m "docs: README com setup, scripts e links para arquitetura"
```

---

### Task 2: visao-geral.md

**Files:**
- Create: `docs/architecture/visao-geral.md`

**Arquivos para ler:**
- `src/index.ts`
- `src/bootstrap/stages.ts`
- `src/runtime/execution-handler.ts`
- `src/runtime/harness.ts`
- `src/agents/types.ts`
- `src/reasoning/engine.ts`
- `package.json`

**Estrutura do documento:**
1. **Propósito**: o que é o harness, onde se encaixa no ecossistema Bevox
2. **Diagrama de arquitetura completo** (ASCII): mostrar todos os componentes e suas conexões — BullMQ consumer, execution handler, pipeline agents, surface agent, reasoning engines, context builder, tool registry, permissions, LLM gateway, calendar client, callbacks, session store
3. **Stack tecnológico**: tabela (tecnologia, versão, propósito)
4. **Decisões de design**:
   - Por que BullMQ e não HTTP (desacoplamento, retry, backpressure)
   - Por que pipeline + surface (separação de concerns, pipeline extrai contexto, surface age)
   - Por que múltiplos engines (complexidade variável, escalation progressivo)
   - Por que singleton registries (processo único, hot-reload futuro)
5. **Relação com Bevox v2**: quem despacha (orchestration-service), como retorna (callbacks POST), quais dados trafegam
6. **Arquivos-chave**: lista dos entry points principais

- [ ] **Step 1: Ler arquivos fonte e escrever visao-geral.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/visao-geral.md
git commit -m "docs: visão geral da arquitetura do Agent Harness"
```

---

### Task 3: bootstrap-e-ciclo-de-vida.md

**Files:**
- Create: `docs/architecture/bootstrap-e-ciclo-de-vida.md`

**Arquivos para ler:**
- `src/bootstrap/stages.ts`
- `src/bootstrap/runner.ts`
- `src/bootstrap/shutdown.ts`
- `src/config/env.ts`
- `src/config/harness-config.ts`

**Estrutura do documento:**
1. **Visão geral**: o bootstrap é uma pipeline sequencial de 7 estágios. Se qualquer estágio falha, o processo encerra com exit code 1.
2. **Tabela dos 7 estágios**: número, nome, o que faz, o que valida, o que acontece se falha
3. **Fluxo de inicialização** (diagrama): infra-check → load-config → register-agents → warmup-pipeline → load-tools-permissions → calendar-health → start-consumer
4. **Configuração**: como env.ts e harness-config.ts carregam e validam (Zod schemas), padrão singleton com cache
5. **Shutdown graceful**: quais signals escuta, o que faz em cada fase (drain BullMQ worker, fechar Redis, fechar DB pool)
6. **Tratamento de erros**: bootstrap fatal → exit(1), runtime errors → logged + job retry

- [ ] **Step 1: Ler arquivos fonte e escrever bootstrap-e-ciclo-de-vida.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/bootstrap-e-ciclo-de-vida.md
git commit -m "docs: bootstrap e ciclo de vida do Agent Harness"
```

---

### Task 4: agentes-e-registro.md

**Files:**
- Create: `docs/architecture/agentes-e-registro.md`

**Arquivos para ler:**
- `src/agents/types.ts`
- `src/agents/base-agent.ts`
- `src/agents/registry.ts`
- `src/agents/execution-context.ts`
- `src/agents/pipeline/message-analyzer.agent.ts`
- `src/agents/pipeline/memory-extractor.agent.ts`
- `src/agents/surface/scheduler.agent.ts`
- `src/runtime/agent-router.ts`

**Estrutura do documento:**
1. **Tipos de agente**: pipeline (pré-processamento) vs surface (interação com usuário)
2. **Interface AgentDefinition**: reproduzir a interface completa com descrição de cada campo
3. **BaseAgent**: classe abstrata, método execute(), o que recebe e retorna
4. **AgentExecutionContext**: campos disponíveis para agentes (executionId, accountId, db, logger, llmClient, etc.)
5. **Os 3 agentes existentes**: para cada um — nome, tipo, propósito, reasoning config, permissões, o que produz
6. **AgentRegistry**: singleton, métodos (register, resolve, listByType, has), quando é populado (stage 3 do bootstrap)
7. **AgentRouter**: como resolve intent → agent name, regras default, fallback para request-human
8. **Guia: como criar um novo agente**: passo a passo (criar arquivo, definir AgentDefinition, implementar execute, registrar no bootstrap stage 3)

- [ ] **Step 1: Ler arquivos fonte e escrever agentes-e-registro.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/agentes-e-registro.md
git commit -m "docs: agentes e sistema de registro"
```

---

### Task 5: motores-de-raciocinio.md

**Files:**
- Create: `docs/architecture/motores-de-raciocinio.md`

**Arquivos para ler:**
- `src/reasoning/engine.ts`
- `src/reasoning/direct.ts`
- `src/reasoning/react.ts`
- `src/reasoning/plan-execute.ts`
- `src/reasoning/rewoo.ts`
- `src/reasoning/reflexion.ts`
- `src/reasoning/strategy-router.ts`
- `src/reasoning/step-evaluator.ts`

**Estrutura do documento:**
1. **Visão geral**: 5 motores de raciocínio com complexidade crescente, selecionados dinamicamente
2. **Interface ReasoningEngine**: reproduzir completa (plan, step, observe, shouldContinue, synthesize)
3. **Tipos compartilhados**: Plan, PlanStep, StepResult, Observation, AgentResponse — reproduzir com descrição
4. **Tabela comparativa**: engine, quando usar, prós, contras, complexidade
5. **Cada engine em detalhe**:
   - **Direct**: single-shot, sem tools, quando usar
   - **ReAct**: loop think→act→observe, diagrama de fluxo, limite de steps
   - **Plan&Execute**: fase de planejamento + execução sequencial, quando re-planeja
   - **ReWOO**: planejamento + execução paralela com dependências, grafo de deps
   - **Reflexion**: wrapper sobre outro engine, retry com reflexão, quando ativa
6. **Strategy Router**: como resolve engine a partir de agent.reasoning.default
7. **Step Evaluator**: avalia após cada step — continue, wrap-reflexion, escalate. Thresholds e critérios.
8. **Fluxo de escalation**: diagrama mostrando Direct → ReAct → Plan&Execute → ReWOO, com Reflexion como wrapper

- [ ] **Step 1: Ler arquivos fonte e escrever motores-de-raciocinio.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/motores-de-raciocinio.md
git commit -m "docs: motores de raciocínio e escalation"
```

---

### Task 6: contexto-e-tokenizacao.md

**Files:**
- Create: `docs/architecture/contexto-e-tokenizacao.md`

**Arquivos para ler:**
- `src/context/context-builder.ts`
- `src/context/types.ts`
- `src/context/tokenizer.ts`
- `src/context/layers/index.ts`
- `src/context/layers/base-config.layer.ts`
- `src/context/layers/rules.layer.ts`
- `src/context/layers/calendar.layer.ts`
- `src/context/layers/memory.layer.ts`
- `src/context/layers/history.layer.ts`

**Estrutura do documento:**
1. **Visão geral**: context builder monta o system prompt combinando 5 layers com token budget
2. **Tabela das 5 layers**: nome, prioridade (menor = mais importante), compressível?, fonte de dados, o que produz
3. **Cada layer em detalhe**:
   - **BaseConfig (10)**: identidade do sistema, data/hora, info da conta — NÃO compressível
   - **Rules (20)**: regras comportamentais do account — NÃO compressível
   - **Calendar (30)**: disponibilidade dos próximos N dias — compressível
   - **Memory (40)**: perfil do contato + facts — compressível
   - **History (50)**: histórico recente de conversação — compressível
4. **Processo de build**: diagrama do fluxo (fetch paralelo → estimar tokens → comprimir se necessário → montar prompt)
5. **Token budget**: como o tokenizer estima (~4 chars/token), como decide o que truncar (prioridade inversa), compressão proporcional
6. **Testes existentes**: mencionar os 8 arquivos de teste em `src/context/`

- [ ] **Step 1: Ler arquivos fonte e escrever contexto-e-tokenizacao.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/contexto-e-tokenizacao.md
git commit -m "docs: context builder e tokenização"
```

---

### Task 7: ferramentas-e-permissoes.md

**Files:**
- Create: `docs/architecture/ferramentas-e-permissoes.md`

**Arquivos para ler:**
- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/tools/index.ts`
- `src/tools/calendar/` (todos os 6 arquivos)
- `src/tools/messaging/` (2 arquivos)
- `src/tools/memory/` (3 arquivos)
- `src/tools/knowledge/search-faq.tool.ts`
- `src/permissions/types.ts`
- `src/permissions/evaluator.ts`
- `src/permissions/permission-context.ts`

**Estrutura do documento:**
1. **Visão geral**: 13 tools em 4 categorias, controladas por 3 camadas de permissão
2. **Interface ToolDefinition**: reproduzir completa (name, description, category, agentType, parameters, execute)
3. **Interface ToolResult**: reproduzir (success, data, error, detail, errorCode)
4. **Tabela das 13 tools**: nome, categoria, agentType (pipeline/surface/both), descrição, parâmetros principais
5. **ToolRegistry**: singleton, métodos (register, resolve, markUnavailable, isAvailable, all)
6. **3 camadas de permissão**:
   - Camada 1 — Agent Static: denied tools no AgentDefinition + agentType mismatch
   - Camada 2 — Execution Context: tools marcadas unavailable, account denied list
   - Camada 3 — Avaliação: evaluatePermission() combina as 3, PermissionResult com reason
7. **PermissionContext**: campos (agent, payload, unavailableTools, accountId, accountDeniedTools)
8. **Fluxo de filtragem**: diagrama — todas as tools → filter by agent static → filter by context → tools permitidas
9. **Guia: como criar uma nova tool**: passo a passo (criar arquivo, implementar ToolDefinition, registrar em index.ts, adicionar permissões)

- [ ] **Step 1: Ler arquivos fonte e escrever ferramentas-e-permissoes.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/ferramentas-e-permissoes.md
git commit -m "docs: ferramentas e sistema de permissões"
```

---

### Task 8: memoria-e-classificacao.md

**Files:**
- Create: `docs/architecture/memoria-e-classificacao.md`

**Arquivos para ler:**
- `migrations/001_memory_and_classifications.sql`
- `src/memory/types.ts`
- `src/memory/contact-profile.repository.ts`
- `src/memory/contact-facts.repository.ts`
- `src/agents/pipeline/memory-extractor.agent.ts`
- `src/agents/pipeline/message-analyzer.agent.ts`
- `src/context/layers/memory.layer.ts`

**Estrutura do documento:**
1. **Visão geral**: sistema de memória persistente por contato, populado por pipeline agents, consumido pelo context builder
2. **Schema das 3 tabelas** (reproduzir colunas e tipos):
   - **contact_profiles**: dados pessoais, contato, preferências, metadados
   - **contact_facts**: fatos extraídos com confidence, supersession, source
   - **message_classifications**: intent, sentiment, topics, urgency por mensagem
3. **Repositories**:
   - ContactProfileRepository: métodos e queries
   - ContactFactsRepository: métodos e queries
4. **Fluxo de escrita**: como MemoryExtractorAgent extrai facts e atualiza profile
5. **Fluxo de leitura**: como memory.layer.ts monta o contexto de memória para o prompt
6. **Classificação de mensagens**: como MessageAnalyzerAgent classifica e persiste
7. **Supersession de facts**: como superseded_by funciona para manter histórico

- [ ] **Step 1: Ler arquivos fonte e escrever memoria-e-classificacao.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/memoria-e-classificacao.md
git commit -m "docs: sistema de memória e classificação"
```

---

### Task 9: integracoes-externas.md

**Files:**
- Create: `docs/architecture/integracoes-externas.md`

**Arquivos para ler:**
- `src/integration/bullmq-consumer.ts`
- `src/integration/llm-gateway.ts`
- `src/integration/calendar-client.ts`
- `src/integration/bevox-callback.ts`
- `src/session/session-store.ts`
- `src/session/types.ts`
- `openapi/agent-harness-v1.yaml`

**Estrutura do documento:**
1. **Visão geral**: 4 integrações externas + session store Redis
2. **BullMQ Consumer**: queue name configurável, como processa jobs, retry automático do BullMQ, payload schema
3. **LLM Gateway**: providers suportados (OpenAI, Gemini), como roteia por provider/model, LlmClientBridge pattern, tracking de usage
4. **Calendar Client**: HTTP client para Calendar Service, métodos disponíveis (getAvailability, createAppointment, etc.), base URL configurável, timeouts
5. **Bevox Callbacks**: 4 endpoints (PATCH status, POST traces, POST stream, POST complete), auth via X-Execution-Token, o que cada um envia, quando é chamado
6. **Session Store**: Redis-backed, key pattern `session:{execution_id}`, métodos (create, update, get, delete), ciclo de vida da session
7. **Diagrama de integrações**: ASCII mostrando harness no centro com setas para cada sistema externo

- [ ] **Step 1: Ler arquivos fonte e escrever integracoes-externas.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/integracoes-externas.md
git commit -m "docs: integrações externas do Agent Harness"
```

---

### Task 10: fluxo-de-execucao.md

**Files:**
- Create: `docs/architecture/fluxo-de-execucao.md`

**Arquivos para ler:**
- `src/runtime/execution-handler.ts`
- `src/runtime/harness.ts`
- `src/runtime/agent-router.ts`
- `src/agents/execution-context.ts`
- `src/integration/bevox-callback.ts`
- `src/session/session-store.ts`

**Estrutura do documento:**
1. **Visão geral**: o execution handler orquestra 10 passos desde receber o job até enviar o resultado
2. **Diagrama de sequência completo** (ASCII): mostrar todos os 10 passos com setas
3. **Os 10 passos em detalhe**:
   - 1. Validar payload (Zod schema — reproduzir campos do ExecutionPayload)
   - 2. Deduplicação Redis (SET NX, key pattern, TTL 3600s)
   - 3. Criar session (Redis, estado inicial)
   - 4. Callback de status "running"
   - 5. Executar pipeline agents (MessageAnalyzer → MemoryExtractor, timeouts 25% cada)
   - 6. Rotear para surface agent (AgentRouter.resolve(intent), fallback)
   - 7. Build context (ContextBuilder com 5 layers)
   - 8. Filtrar permissões (3 camadas → tools permitidas)
   - 9. Executar surface agent loop (engine selection, step loop, escalation)
   - 10. Enviar callback complete (response, sentiment, strategy, usage)
4. **Timeouts**: como divide o budget total (25% pipeline1, 25% pipeline2, 50% surface)
5. **Error handling**: o que acontece em cada tipo de falha (validação, timeout, LLM error, tool error)
6. **Session lifecycle**: created → running → completed/failed

- [ ] **Step 1: Ler arquivos fonte e escrever fluxo-de-execucao.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/fluxo-de-execucao.md
git commit -m "docs: fluxo completo de execução"
```

---

### Task 11: guia-de-contribuicao.md

**Files:**
- Create: `docs/architecture/guia-de-contribuicao.md`

**Arquivos para ler:**
- `package.json`
- `.env.example`
- `migrations/001_memory_and_classifications.sql`
- `src/bootstrap/stages.ts` (onde registrar novos agentes/tools)
- `src/agents/surface/scheduler.agent.ts` (exemplo de agente)
- `src/tools/calendar/create-appointment.tool.ts` (exemplo de tool)
- `src/reasoning/react.ts` (exemplo de engine)
- `tsconfig.json`

**Estrutura do documento:**
1. **Setup do ambiente**:
   - Pré-requisitos (Node 20+, PostgreSQL 16+, Redis 7+)
   - Clone e install
   - Copiar .env.example → .env e preencher
   - Rodar migrations
   - npm run dev
2. **Scripts disponíveis**: tabela com cada script
3. **Como testar**: npm test, onde ficam os testes, convenções
4. **Receita: criar novo agente**:
   - Criar arquivo em `src/agents/pipeline/` ou `src/agents/surface/`
   - Implementar factory function que retorna AgentDefinition
   - Registrar no stage `register-agents` em `src/bootstrap/stages.ts`
   - Adicionar routing rules no `src/runtime/agent-router.ts` se surface
5. **Receita: criar nova tool**:
   - Criar arquivo em `src/tools/<categoria>/`
   - Implementar ToolDefinition com execute()
   - Registrar em `src/tools/index.ts`
   - Adicionar permissões nos agentes relevantes
6. **Receita: criar novo engine de raciocínio**:
   - Implementar interface ReasoningEngine
   - Adicionar no strategy-router.ts
   - Configurar em AgentDefinition.reasoning
7. **Convenções de código**:
   - Zod para validação de schemas
   - Pino para logging estruturado (child loggers por execution)
   - Singleton registries
   - Factory functions para agentes e tools
   - Tipos em arquivos `types.ts` separados

- [ ] **Step 1: Ler arquivos fonte e escrever guia-de-contribuicao.md**
- [ ] **Step 2: Commit**
```bash
git add docs/architecture/guia-de-contribuicao.md
git commit -m "docs: guia de contribuição com receitas de extensão"
```
