# Documentação Completa do Agent Harness

**Data:** 2026-04-07
**Status:** Aprovado

## Problema

O projeto bevox-agent-harness não possui documentação técnica. Desenvolvedores da equipe Bevox que precisam contribuir ou manter o harness não têm referência sobre arquitetura, fluxos, decisões de design ou como estender o sistema.

## Solução

Criar documentação de referência completa em português, seguindo a mesma estrutura modular usada no Bevox v2 (`docs/architecture/`). 10 documentos + README, cada um autocontido e focado em um subsistema.

## Público-Alvo

Desenvolvedores da equipe Bevox que vão contribuir e manter o harness.

## Estrutura de Arquivos

```
README.md                                     — Porta de entrada, setup, links
docs/architecture/
├── visao-geral.md                            — Arquitetura alto nível, stack, decisões
├── bootstrap-e-ciclo-de-vida.md              — 7 estágios, shutdown, health checks
├── agentes-e-registro.md                     — BaseAgent, pipeline/surface, registry
├── motores-de-raciocinio.md                  — 5 engines, escalation, strategy router
├── contexto-e-tokenizacao.md                 — 5 layers, prioridade, compressão
├── ferramentas-e-permissoes.md               — 13 tools, 3 camadas de permissão
├── memoria-e-classificacao.md                — 3 tabelas, repositories, fluxo
├── integracoes-externas.md                   — BullMQ, LLM Gateway, Calendar, Callbacks
├── fluxo-de-execucao.md                      — 10 passos do handler, timeouts, dedup
└── guia-de-contribuicao.md                   — Setup, testes, receitas de extensão
```

## Conteúdo por Documento

### README.md
- O que é o Agent Harness (1 parágrafo)
- Diagrama de fluxo simplificado (ASCII)
- Pré-requisitos (Node, Redis, PostgreSQL)
- Como rodar (`npm run dev`, variáveis de ambiente essenciais)
- Como testar (`npm test`)
- Links para cada doc de arquitetura

### visao-geral.md
- Propósito do harness no ecossistema Bevox
- Diagrama de arquitetura completo (BullMQ → Handler → Pipeline → Surface → Callbacks)
- Stack tecnológico (Node/TS, BullMQ, Redis, PostgreSQL, Pino, Zod)
- Decisões de design: por que BullMQ (não HTTP), por que pipeline+surface, por que múltiplos engines
- Relação com Bevox v2 (quem despacha, como retorna)

### bootstrap-e-ciclo-de-vida.md
- Tabela dos 7 estágios com o que cada um valida
- Ordem de inicialização e o que acontece se um falha
- Shutdown graceful (SIGINT/SIGTERM, drain de jobs)
- Arquivos-chave: `stages.ts`, `runner.ts`, `shutdown.ts`

### agentes-e-registro.md
- Interface `AgentDefinition` completa com campos
- Pipeline vs Surface: quando usar cada tipo
- Os 3 agentes existentes (MessageAnalyzer, MemoryExtractor, Scheduler) com suas configurações
- `AgentRegistry`: singleton, métodos, ciclo de vida
- Guia: "como criar um novo agente" passo a passo

### motores-de-raciocinio.md
- Interface `ReasoningEngine` com métodos (plan, step, observe, shouldContinue, synthesize)
- Tabela comparativa dos 5 engines (Direct, ReAct, Plan&Execute, ReWOO, Reflexion)
- Fluxo de cada engine com diagrama
- Escalation: step evaluator, thresholds, quando escala
- Strategy Router: como resolve qual engine usar

### contexto-e-tokenizacao.md
- As 5 layers com prioridade e se são compressíveis
- Processo de build: parallel fetch → estimate → compress → assemble
- Token budget: como calcula, como trunca
- Cada layer detalhada: o que busca, de onde, formato de saída

### ferramentas-e-permissoes.md
- Tabela das 13 tools (nome, categoria, agentType, descrição)
- Interface `ToolDefinition` e `ToolResult`
- `ToolRegistry`: métodos, markUnavailable
- 3 camadas de permissão com exemplos de cada
- Guia: "como criar uma nova tool"

### memoria-e-classificacao.md
- Schema das 3 tabelas (contact_profiles, contact_facts, message_classifications)
- Repositories: métodos de leitura e escrita
- Fluxo: como o MemoryExtractor popula, como o SchedulerAgent lê
- Supersession de facts (superseded_by)

### integracoes-externas.md
- BullMQ consumer: queue, payload schema, retry
- LLM Gateway: providers (OpenAI, Gemini), bridge pattern, usage tracking
- Calendar Client: endpoints consumidos, timeout
- Bevox Callbacks: 4 endpoints (status, traces, stream, complete), auth via X-Execution-Token

### fluxo-de-execucao.md
- Os 10 passos do execution-handler em detalhe
- Diagrama de sequência completo
- Deduplicação Redis (SET NX, TTL)
- Session store: create → update → complete
- Timeouts: divisão do budget (25%/25%/50%)
- Error handling: o que acontece em cada tipo de falha

### guia-de-contribuicao.md
- Setup do ambiente (clone, npm install, .env, migrations)
- Como rodar em dev, como testar
- Receitas: criar novo agente, criar nova tool, criar novo engine de raciocínio
- Convenções de código (Zod para validação, Pino para logs, singleton registries)

## Template de Cada Documento

Todos os documentos seguem:
1. Título + descrição de 1 linha
2. Visão geral (2-3 parágrafos)
3. Seções técnicas com diagramas ASCII e tabelas
4. Referências cruzadas para outros docs relevantes
5. Lista de arquivos-chave com caminho exato (`src/...`)

## Idioma

Português (consistente com documentação do Bevox v2).

## Fora de Escopo

- Documentação de API pública (já coberta pelo OpenAPI spec em `openapi/agent-harness-v1.yaml`)
- Tutoriais para usuários finais (não aplicável — projeto interno)
- Changelog (coberto pelo git log)
