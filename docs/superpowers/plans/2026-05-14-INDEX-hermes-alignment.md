# Hermes Alignment — Plan Index & Parallelization Strategy

> 8 planos de implementação derivados da comparação Bevox Agent Harness ↔ Hermes Agent (NousResearch). Cada fase é independente o suficiente para virar PR único, mas algumas compartilham arquivos críticos.

**Data:** 2026-05-14
**Autor:** Análise comparativa Claude Code
**Revisão:** todos os 8 planos passaram por `plan-document-reviewer`; correções aplicadas em 2026-05-14 (ver histórico git em `docs/superpowers/plans/`)

---

## Lista de Planos

| # | Fase | Arquivo | Esforço |
|---|---|---|---|
| 1 | **CI/CD Foundations** | [2026-05-14-phase-1-ci-cd-foundations.md](./2026-05-14-phase-1-ci-cd-foundations.md) | 1-2 dias |
| 2 | **Test Coverage** | [2026-05-14-phase-2-test-coverage.md](./2026-05-14-phase-2-test-coverage.md) | 2-3 semanas |
| 3 | **Security Hardening** | [2026-05-14-phase-3-security-hardening.md](./2026-05-14-phase-3-security-hardening.md) | 1 semana |
| 4 | **Observability** | [2026-05-14-phase-4-observability.md](./2026-05-14-phase-4-observability.md) | 1.5-2 semanas |
| 5 | **LLM Gateway Robustness** | [2026-05-14-phase-5-llm-gateway-robustness.md](./2026-05-14-phase-5-llm-gateway-robustness.md) | 2 semanas |
| 6 | **Versioning & Releases** | [2026-05-14-phase-6-versioning-releases.md](./2026-05-14-phase-6-versioning-releases.md) | 2-3 dias |
| 7 | **Dev Env Reproducibility** | [2026-05-14-phase-7-dev-env-reproducibility.md](./2026-05-14-phase-7-dev-env-reproducibility.md) | 2-3 dias |
| 8 | **Pluggable Skills** | [2026-05-14-phase-8-pluggable-skills.md](./2026-05-14-phase-8-pluggable-skills.md) | 3-4 semanas |

**Total sequencial:** ~10-12 semanas. Com paralelização inteligente: ~5-6 semanas.

---

## Matriz de Conflitos por Arquivo

| Arquivo / Diretório | F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 |
|---|---|---|---|---|---|---|---|---|
| `package.json` | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ | ✏️ |
| `.github/workflows/` | ✏️ | – | – | – | – | ✏️ | – | – |
| `src/runtime/execution-handler.ts` | – | (t) | ✏️⚠️ | ✏️⚠️ | – | – | – | ✏️ |
| `src/integration/llm-gateway.ts` | – | (t) | ✏️ | ✏️⚠️ | ✏️⚠️ | – | – | – |
| `src/integration/calendar-client.ts` | – | (t) | ✏️ | – | – | – | – | – |
| `src/permissions/evaluator.ts` | – | (t) | ✏️ | – | – | – | – | ✏️ |
| `src/tools/**` | – | (t) | ✏️ | ✏️ | – | – | – | ✏️🚨 |
| `src/reasoning/**` | – | (t) | – | ✏️ | – | – | – | – |
| `src/memory/repositories/` | – | (t) | ✏️ | – | – | – | – | – |
| `src/config/env.ts` | – | – | ✏️ | ✏️ | ✏️ | – | – | ✏️ |
| `src/bootstrap/**` | – | – | – | ✏️ | ✏️ | – | – | ✏️ |
| `README.md` | ✏️ | – | – | (✏️) | – | ✏️ | ✏️ | ✏️ |
| `migrations/` | – | – | ✏️ | ✏️ | – | – | – | – |
| `tests/` | – | ✏️ | ✏️ | ✏️ | ✏️ | – | – | ✏️ |
| `docker-compose.yml`, `Dockerfile*` | – | – | – | – | – | – | ✏️ | – |
| `eslint.config.js`, `.prettierrc` | ✏️ | – | – | – | – | – | – | – |
| `.changeset/**` | – | – | – | – | – | ✏️ | – | – |

Legenda: ✏️ = modifica/cria · ⚠️ = alto risco de conflito · 🚨 = refatoração grande · (t) = adiciona testes para arquivo · – = não toca

---

## Análise de Dependências Lógicas

```
                   ┌─────────────────┐
                   │  F1: CI/CD      │ ◄── nenhuma dep
                   └────────┬────────┘
                            │ libera execução automática
              ┌─────────────┼─────────────┬─────────────┐
              ▼             ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ F2:Tests │  │ F3: Sec  │  │ F7:DevEnv│  │ F6: Rel  │
        └────┬─────┘  └─────┬────┘  └──────────┘  └──────────┘
             │              │
             │      ┌───────┴────────┐
             │      ▼                ▼
             │  ┌──────────┐   ┌──────────┐
             └─►│ F4: Obs  │──►│ F5: LLM  │
                └────┬─────┘   └────┬─────┘
                     │              │
                     └──────┬───────┘
                            ▼
                      ┌──────────┐
                      │ F8:Skills│
                      └──────────┘
```

### Dependências Hard (não pode pular)

- **F2 → F8:** Refatoração de tools precisa de testes de regressão (cobertura ≥70%).
- **F4 → F5:** `error-classifier` (F4) é importado direto em retry de F5. Não compila sem F4.
- **F2 → F5:** Testes de regressão dos engines precisam estar verdes antes do refator de gateway (preserva interface pública).
- **F3 → F5:** Redactors da F3 precisam cobrir credenciais novas dos adapters Anthropic.

### Dependências Soft (recomendado mas não obrigatório)

- **F1 antes de qualquer:** CI valida automaticamente as outras fases.
- **F3 antes de F4 em `execution-handler.ts`:** evita rebase grande.
- **F4 antes de F5 em `llm-gateway.ts`:** mesma razão.

---

## Estratégia de Paralelização (Waves)

### 🌊 Wave 1 — Foundation (paralelo, ~1 semana)

Independentes entre si, baixíssimo conflito. **Pode rodar em 4 sessões simultâneas.**

| Sessão | Fase | Razão da independência |
|---|---|---|
| A | **F1: CI/CD** | Toca só `.github/`, configs raiz, scripts de `package.json` |
| B | **F7: Dev Env** | Toca só infra (Docker, scripts/), seções novas em README |
| C | **F6: Versioning** | Toca só `.changeset/`, workflow novo, CHANGELOG |
| D | **F2: Tests (parte 1)** | Adiciona `tests/`, configura Vitest. Não modifica `src/` |

**Conflitos esperados:**
- `package.json` (todas as 4 alteram scripts/deps) — resolver em merge ordem A→B→C→D (commits pequenos, rebase trivial)
- `README.md` (F1, F6, F7) — coordenar via PR template, mergear em sequência

**Pré-requisito antes do Wave 2:** mergear todos os 4 PRs do Wave 1.

---

### 🌊 Wave 2 — Hardening (paralelo controlado, ~1.5 semanas)

| Sessão | Fase | Razão |
|---|---|---|
| A | **F3: Security** | Toca handler, integrations, repositories, permissions, tools |
| B | **F2: Tests (parte 2 — completar cobertura)** | Adiciona testes novos sem tocar `src/` |

**⚠️ Não paralelizar F3 com F4 ou F5** — F3 instrumenta `execution-handler.ts` e `llm-gateway.ts`, F4/F5 também. Conflito grave.

**Conflitos esperados:**
- Mínimos — F2 (parte 2) só adiciona testes; F3 modifica `src/`.
- Coordenar merge: F2 testes finais entram **antes** de F3, validando que regras de Zod/redact não quebram cobertura.

---

### 🌊 Wave 3 — Observability + LLM Robustness (sequencial obrigatório, ~3-4 semanas)

| Ordem | Fase | Razão |
|---|---|---|
| 1 | **F4: Observability** | Define `error-classifier`/`isRetryable` — exports estáveis consumidos por F5 |
| 2 | **F5: LLM Gateway** | Importa `error-classifier` de F4; refator preserva interface pública |

**Não paralelizar.** F5 importa diretamente de `src/observability/error-classifier`. Ambas tocam `llm-gateway.ts`.

**Sem alternativa de freeze** — F5 depende de código novo de F4 (não só do arquivo compartilhado).

---

### 🌊 Wave 4 — Skills Refactor (isolada, ~3-4 semanas)

| Sessão | Fase |
|---|---|
| única | **F8: Pluggable Skills** |

**⚠️ Refatoração ampla — não paralelizar com nada.** Toca todos os `src/tools/`, bootstrap, registries. Mais segura com codebase estável após F1-F7.

**Pré-requisito:** F2 (cobertura ≥ 70%) **obrigatória** — sem testes de regressão, a migração é arriscada demais.

---

## Recomendação Final de Execução

```
Semana 1:     Wave 1 (F1 + F7 + F6 + F2-parte1)  [4 sessões paralelas]
Semana 2-3:   Wave 2 (F3 + F2-parte2)            [2 sessões paralelas]
Semana 4-7:   Wave 3 (F4 → F5)                   [sequencial]
Semana 8-11:  Wave 4 (F8)                        [1 sessão isolada]
```

**Total otimista:** ~11 semanas — vs ~14 semanas sequencial puro. Economia de **3 semanas** com paralelismo seguro.

**Total agressivo (se Wave 3 também paralelizar com freeze):** ~9 semanas.

---

## Protocolo para Sessões Paralelas

Para evitar pisar no calo entre sessões Claude Code:

1. **Worktrees git separados por fase.** Cada sessão em `git worktree add ../bevox-agent-harness-phase-N <branch>`.
2. **Branches: `phase-N-<short-name>`** seguindo padrão.
3. **PRs com label `phase-N`** para tracking.
4. **Antes de iniciar sessão:** ler este INDEX + plano específico + verificar PRs abertos das outras fases da mesma wave.
5. **Mergear em ordem** dentro da wave (A → B → C → D) — última sessão sempre faz rebase final.
6. **`package.json` é um campo minado** — preferir 1 commit pequeno por fase só com deps adicionadas, mergear rápido.

---

## Marcos / Definition of Done por Wave

### Wave 1 ✅
- CI verde em todos os PRs (sem alertas críticos)
- `docker compose up` sobe infra
- `npx changeset` gera arquivo válido
- `vitest.config.ts` + estrutura `tests/` no lugar
- Pelo menos 1 release `v0.1.x` publicado

### Wave 2 ✅
- Cobertura ≥ 70% (lines, functions, statements), ≥ 65% (branches)
- `SECURITY.md` publicado, threat model claro
- `permission_audit` table populada em prod-like
- Rate limit ativo em 5 tools mutantes
- Pino redactors validados (logs auditados)

### Wave 3 ✅
- Spans visíveis em Jaeger para fluxo completo
- `execution_usage` table grava tokens/cost/latency
- Mock LLM removido de `execution-context.ts:56`
- Adapters OpenAI/Anthropic/Gemini funcionais
- Circuit breaker testado em prod-like

### Wave 4 ✅
- 13 tools migradas para `skills/`
- Bootstrap carrega skills built-in + via `SKILLS_PATH`
- Todos os testes pré-existentes ainda passam
- Documentação de skills publicada

---

## Correções Pós-Review (2026-05-14)

Resumo das correções aplicadas após review automatizado:

- **F1:** stub env vars no job de teste, `eslint.config.mjs` em vez de `.js`, OSV scanner path corrigido, teste de commit-msg inválido
- **F2:** adicionados `@testcontainers/postgresql` e `@testcontainers/redis`; fakes corrigidos para shape real (`input_tokens`, `tool_calls`, `latency_ms`, `content: string | null`); helper de integração roda migrations; StrategyRouter como roteador (não engine)
- **F3:** migration renomeada para `002_permission_audit.sql`; redactor de PII NÃO mascara `messages.*.content` (quebra debug); enum de modelos vira regex+allowlist; rate limiter destructuring com nomes; verificação de signature async; smoke test E2E de audit; ordem migration→deploy documentada
- **F4:** prose corrigida para 6 categorias; export contract para F5; warning em modelo desconhecido; migration número TBD (não-colidente com F3)
- **F5:** interface pública preservada (`LLMRequestOptions`, `tool_calls`, `input_tokens`, `latency_ms`, role `tool`); referência correta `src/agents/execution-context.ts:56` (não `runtime/`); tool-calling mantido em V1; F4 marcada como hard dep; adapters extraídos do `llm-gateway.ts` atual (não reescrito); adapter `LlmClient → LLMGateway` para `AgentExecutionContext`; gateway via decorators
- **F6:** `"private": true` em `package.json` (mecanismo real anti-publish); `changeset tag` em vez de `publish`; `createGithubReleases: true` no action (sem step manual com `--notes-file`); duplicação de CI removida; baseline `CHANGELOG.md` sem `[Unreleased]`
- **F7:** scripts em Node `.mjs` (cross-platform); migrations via `schema_migrations` table idempotente (sem `initdb.d`); `env_file: required: false`; `CHOKIDAR_USEPOLLING=true`; smoke test via BullMQ API real; `.dockerignore` cobre `.env*`
- **F8:** skills sob `src/skills-builtin/` (compiladas por tsc); `ToolResult` atual preservado (sem `stop`/`output` inventados); CommonJS `require()` via `createRequire`; security gate `ALLOW_EXTERNAL_SKILLS` em prod; path traversal validation; permissions `requires`/`sideEffects` ficam como metadata (não enforced em V1); Task 6 com checklist explícito por tool + estratégia de coexistência

## Notas Finais

- **Cada plano é auto-contido:** uma sessão Claude Code pode executar uma fase sem ler as outras (exceto este INDEX para entender conflitos).
- **Adaptação JIT:** após Wave 1 e 2, revisar planos 3-8 — premissas podem ter mudado.
- **Esta análise não substitui code review humano** em PRs reais. Os planos são guias detalhados, não substitutos da revisão.
