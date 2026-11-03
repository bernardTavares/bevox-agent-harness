# Bootstrap e Ciclo de Vida do Agent Harness

> Ver também: [visão geral](./visao-geral.md) | [integrações externas](./integracoes-externas.md)

## Visão Geral

O bootstrap do Agent Harness é um **pipeline sequencial de 7 estágios**. A função `runBootstrap()` executa cada estágio em ordem; qualquer falha não tratada em um estágio provoca `process.exit(1)` imediato — não há retry nem recuperação parcial durante a inicialização.

```
runBootstrap()
  ├─ cria Pool (PostgreSQL) e Redis
  ├─ executa estágios 1→7 em sequência
  │    └─ falha em qualquer estágio → logger.error + process.exit(1)
  └─ retorna BootstrapContext { db, redis }
```

Após o bootstrap bem-sucedido, `registerShutdownHandlers()` é chamado para interceptar `SIGTERM`/`SIGINT` e encerrar o processo de forma graciosa.

---

## Os 7 Estágios do Bootstrap

| # | Nome | O que faz | O que valida | Consequência de falha |
|---|------|-----------|-------------|----------------------|
| 1 | `infra-check` | Executa `SELECT 1` no PostgreSQL e `PING` no Redis | Conectividade real com as duas dependências de infraestrutura | `exit(1)` — sem infra, o harness não pode operar |
| 2 | `load-config` | Chama `getEnv()` e `getHarnessConfig()` | Schema Zod de variáveis de ambiente (`envSchema`); erros de validação são logados antes do exit | `exit(1)` — configuração inválida impede todo o funcionamento |
| 3 | `register-agents` | Instancia e registra `MessageAnalyzerAgent`, `MemoryExtractorAgent` e `SchedulerAgent` no `AgentRegistry`; constrói o `AgentRouter` | Valida que cada tool listada em `permissions.required` pertence à lista `KNOWN_TOOL_NAMES` (exceto `*`) | `exit(1)` — agente referenciando tool desconhecida indica configuração incorreta |
| 4 | `warmup-pipeline` | Verifica se a API key do provedor LLM configurado está presente | Coerência entre `DEFAULT_LLM_PROVIDER` e a chave correspondente (`OPENAI_API_KEY` / `GEMINI_API_KEY`) | Emite `console.warn` — **não** aborta o boot (aviso, não erro fatal) |
| 5 | `load-tools-permissions` | Chama `registerAllTools(toolRegistry)` e verifica que cada tool exigida pelos agentes está de fato registrada no `ToolRegistry` | Resolução concreta de nomes de tools (ao contrário do estágio 3, que valida apenas nomes conhecidos) | `exit(1)` — tool exigida ausente no registry é erro fatal (`Stage 5 FATAL`) |
| 6 | `calendar-health` | Faz `GET {CALENDAR_SERVICE_URL}/health` com timeout de 5 s | Disponibilidade do serviço de calendário externo no momento do boot | `exit(1)` — serviço de calendário indisponível impede agendamentos |
| 7 | `start-consumer` | Inicia o worker BullMQ passando `db`, `redis`, `AgentRegistry`, `ToolRegistry` e `AgentRouter` | Inicialização do consumer de fila | `exit(1)` — sem consumer a fila de execuções não é processada |

---

## Diagrama de Fluxo (ASCII)

```
 process.start()
      │
      ▼
 runBootstrap()
      │
      ├──► [1] infra-check
      │         ├─ db.query('SELECT 1')     ──► FALHA → exit(1)
      │         └─ redis.ping() === 'PONG'  ──► FALHA → exit(1)
      │
      ├──► [2] load-config
      │         ├─ getEnv()          (Zod parse)  ──► FALHA → exit(1)
      │         └─ getHarnessConfig()             ──► FALHA → exit(1)
      │
      ├──► [3] register-agents
      │         ├─ AgentRegistry.register(MessageAnalyzerAgent)
      │         ├─ AgentRegistry.register(MemoryExtractorAgent)
      │         ├─ AgentRegistry.register(SchedulerAgent)
      │         ├─ valida KNOWN_TOOL_NAMES        ──► FALHA → exit(1)
      │         └─ createAgentRouter()
      │
      ├──► [4] warmup-pipeline
      │         └─ chave API presente?  ──► AUSENTE → warn (não aborta)
      │
      ├──► [5] load-tools-permissions
      │         ├─ registerAllTools(toolRegistry)
      │         └─ valida tools no ToolRegistry   ──► FALHA → exit(1)
      │
      ├──► [6] calendar-health
      │         └─ GET /health (timeout 5 s)      ──► FALHA → exit(1)
      │
      └──► [7] start-consumer
                └─ startConsumer(ctx)             ──► FALHA → exit(1)

      │
      ▼
 harness PRONTO
 registerShutdownHandlers({ db, redis })
      │
      ▼
 aguarda SIGTERM / SIGINT
```

---

## Configuração: `env.ts` e `harness-config.ts`

### Carregamento e Validação (Zod)

`src/config/env.ts` define `envSchema` via Zod e expõe `getEnv()`:

1. Na primeira chamada, executa `envSchema.safeParse(process.env)`.
2. Se a validação falhar, imprime os erros formatados e chama `process.exit(1)`.
3. O resultado válido é armazenado na variável `cached` (singleton em memória).
4. Chamadas subsequentes retornam o cache sem re-parsear.

`src/config/harness-config.ts` é uma função pura que chama `getEnv()` e retorna um objeto estruturado — não tem cache próprio, depende do cache de `getEnv()`.

### Schema de Variáveis de Ambiente

| Variável | Tipo / Default | Obrigatória |
|----------|---------------|-------------|
| `DATABASE_URL` | `string` (URL) | Sim |
| `REDIS_URL` | `string` | Sim |
| `BEVOX_CALLBACK_BASE_URL` | `string` (URL) | Sim |
| `CALENDAR_SERVICE_URL` | `string` (URL) | Sim |
| `BEVOX_DB_URL` | `string` (URL) | Não |
| `OPENAI_API_KEY` | `string` | Não |
| `GEMINI_API_KEY` | `string` | Não |
| `DEFAULT_LLM_PROVIDER` | `"openai" \| "gemini"` — default `"openai"` | Não |
| `DEFAULT_LLM_MODEL` | `string` — default `"gpt-4o-mini"` | Não |
| `HARNESS_LOG_LEVEL` | `trace\|debug\|info\|warn\|error\|fatal` — default `"info"` | Não |
| `HARNESS_MAX_EXECUTION_TIME_MS` | `number` (coerce) — default `90000` | Não |
| `HARNESS_QUEUE_NAME` | `string` — default `"bevox.execution.dispatch"` | Não |

### Estrutura retornada por `getHarnessConfig()`

```
{
  db:       { connectionString }
  redis:    { url }
  bevox:   { callbackBaseUrl }
  calendar: { baseUrl }
  llm:      { provider, model, openaiApiKey, geminiApiKey }
  harness:  { logLevel, maxExecutionTimeMs, queueName }
}
```

---

## Shutdown Gracioso

`registerShutdownHandlers({ db, redis })` em `src/bootstrap/shutdown.ts` registra listeners para dois sinais do SO:

- `SIGTERM` — enviado por orquestradores (Docker, Kubernetes) para encerramento controlado
- `SIGINT` — gerado por `Ctrl+C` no terminal

### Sequência de Encerramento

```
sinal recebido (SIGTERM / SIGINT)
      │
      ▼
 [1] stopConsumer()
      └─ drena o worker BullMQ — jobs em andamento são finalizados antes do fechamento
      │
      ▼
 [2] redis.quit()
      └─ fecha a conexão Redis de forma limpa (envia QUIT ao servidor)
      │
      ▼
 [3] db.end()
      └─ aguarda todas as queries pendentes e fecha o pool de conexões PostgreSQL
      │
      ▼
 process.exit(0)   ──── sucesso

 (qualquer erro nas etapas acima)
      └──► logger.error + process.exit(1)
```

---

## Tratamento de Erros

### Erros durante o Bootstrap (fatais)

O loop em `runBootstrap()` envolve cada estágio em `try/catch`:

```typescript
try {
  await stage.execute()
} catch (err) {
  logger.error({ stage: stage.name, err }, "Bootstrap stage failed — aborting")
  process.exit(1)
}
```

Nenhum estágio possui lógica de retry. O processo termina imediatamente com código 1, permitindo que o orquestrador (ex.: Docker Compose, Kubernetes) decida se reinicia o container.

### Erros em Runtime (não fatais)

Após o bootstrap, erros em execuções individuais de agentes são tratados dentro do worker BullMQ:

- O job é marcado como falho e permanece na fila para reprocessamento conforme a política de retry configurada no BullMQ.
- O erro é registrado via `pino` com contexto do job.
- O worker **não** encerra; continua consumindo a fila normalmente.

A única exceção é o estágio 4 (`warmup-pipeline`): a ausência de chave API é reportada como `console.warn` sem abortar o boot, pois o sistema pode ser executado em modo de teste ou com provider alternativo.

---

## Arquivos-Chave

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/bootstrap/stages.ts` | Define `BootstrapStage`, `BootstrapContext` e a função `buildStages()` com os 7 estágios |
| `src/bootstrap/runner.ts` | Orquestra o pipeline: cria conexões, itera os estágios, faz `exit(1)` em falha |
| `src/bootstrap/shutdown.ts` | Registra handlers para `SIGTERM`/`SIGINT`; drena BullMQ, Redis e PostgreSQL em ordem |
| `src/config/env.ts` | Schema Zod `envSchema`, singleton `cached`, função `getEnv()` |
| `src/config/harness-config.ts` | Função `getHarnessConfig()` — mapeia `HarnessEnv` para um objeto de configuração estruturado |
