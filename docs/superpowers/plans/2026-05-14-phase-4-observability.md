# Phase 4: Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Adicionar tracing (OpenTelemetry), métricas (usage tracker de tokens/custo/latência) e classificação estruturada de erros LLM, inspirado em `account_usage.py`, `error_classifier.py` e `insights.py` do Hermes.

**Architecture:** OpenTelemetry SDK com OTLP exporter (configurável). Spans automáticos em handler, pipeline, surface loop, tool calls, LLM calls. Usage tracker grava em tabela `execution_usage` com tokens, cost (calculado por model pricing), latência. Error classifier categoriza falhas LLM em 6 categorias (`rate_limit`, `context_overflow`, `invalid_response`, `network`, `auth`, `server_error`) + `unknown` para escolher retry/fallback adequado.

**Contrato público para Phase 5:** os exports estáveis são `LLMErrorCategory` (union type), `classifyLLMError(err) → LLMErrorCategory`, `isRetryable(category) → boolean`. Phase 5 (retry logic) importa exatamente esses 3 símbolos.

**Tech Stack:** `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/instrumentation-pg`, `@opentelemetry/instrumentation-ioredis`, `@opentelemetry/instrumentation-http`.

---

## Dependencies

- **Hard:** Nenhuma.
- **Soft:** Fase 2 (testes para validar instrumentação).
- **Blocks:** Nada.
- **Conflitos potenciais:** Fase 3 (`execution-handler.ts`), Fase 5 (`llm-gateway.ts`).

## Files Touched

### Create
- `src/observability/tracer.ts`
- `src/observability/usage-tracker.ts`
- `src/observability/error-classifier.ts`
- `src/observability/cost-calculator.ts`
- `src/observability/spans.ts` (helpers)
- `migrations/00X_execution_usage.sql` (⚠ usar próximo número disponível após mergear F3 — F3 reserva `002_permission_audit.sql`. Verificar antes de criar.)
- `tests/unit/observability/error-classifier.test.ts`
- `tests/unit/observability/usage-tracker.test.ts`
- `tests/unit/observability/cost-calculator.test.ts`

### Modify (⚠️ conflitos)
- ⚠️ `src/runtime/execution-handler.ts` — instrumentar com spans
- ⚠️ `src/integration/llm-gateway.ts` — spans + classificar erros + capturar usage
- `src/reasoning/*.ts` (5 arquivos: `direct.ts`, `react.ts`, `plan-execute.ts`, `rewoo.ts`, `reflexion.ts`) — span por step
- `src/tools/registry.ts` — adicionar wrapper de span no `execute()` (não existe `tools/_base.ts` — registry centraliza chamadas)
- `src/bootstrap/runner.ts` ou `src/bootstrap/stages.ts` — inicializar tracer no estágio inicial (não há estágios numerados; ver `stages.ts` para sequência real)
- `src/config/env.ts` — vars OTEL
- `package.json`

### High-conflict files
- ⚠️ `src/runtime/execution-handler.ts` — Fase 3
- ⚠️ `src/integration/llm-gateway.ts` — Fases 3, 5

## Estimated Effort
1.5-2 semanas (~50 horas).

---

## Tasks

### Task 1: Setup OpenTelemetry SDK

**Files:**
- Create: `src/observability/tracer.ts`
- Modify: `src/config/env.ts`, `src/bootstrap/*.ts` (primeiro estágio), `package.json`

- [ ] **Step 1: Instalar deps**

```bash
npm install @opentelemetry/sdk-node @opentelemetry/api \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
npm install --save-dev @opentelemetry/sdk-trace-base  # InMemorySpanExporter para testes
```

⚠ Auto-instrumentação cobre: `pg` (8.x), `ioredis` (5.x), `http`, `undici` (fetch nativo Node 20+ usado em `llm-gateway.ts`). BullMQ NÃO é coberta — instrumentar manualmente se necessário.

- [ ] **Step 2: Config em env**

```typescript
OTEL_ENABLED: z.coerce.boolean().default(false),
OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
OTEL_SERVICE_NAME: z.string().default("bevox-agent-harness"),
OTEL_SERVICE_VERSION: z.string().default("0.0.0"),
```

- [ ] **Step 3: `src/observability/tracer.ts`**

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { trace } from "@opentelemetry/api";
import { getEnv } from "../config/env";

let sdk: NodeSDK | null = null;

export function initTracer() {
  const env = getEnv();
  if (!env.OTEL_ENABLED) return;

  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: env.OTEL_SERVICE_NAME,
      [SemanticResourceAttributes.SERVICE_VERSION]: env.OTEL_SERVICE_VERSION,
    }),
    traceExporter: new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT }),
    instrumentations: [getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
    })],
  });
  sdk.start();
}

export async function shutdownTracer() {
  await sdk?.shutdown();
}

export function getTracer(name = "bevox-agent-harness") {
  return trace.getTracer(name);
}
```

- [ ] **Step 4: Adicionar novo estágio `init-observability` em `src/bootstrap/stages.ts`**

⚠ Bootstrap stages são **nomeados**, não numerados. Atuais: `infra-check`, `load-config`, `register-agents`, etc. Tracer init precisa rodar **após** `load-config` (para ler env) e antes de qualquer outro estágio que possa emitir spans. Inserir `init-observability` entre `load-config` e `register-agents`.

```typescript
// src/bootstrap/stages.ts
export function buildStages(): Stage[] {
  return [
    infraCheckStage(),
    loadConfigStage(),
    initObservabilityStage(),  // ← novo
    registerAgentsStage(),
    // ...
  ];
}
```

- [ ] **Step 5: Graceful shutdown no SIGTERM (em `src/bootstrap/shutdown.ts`)**

- [ ] **Step 6: Commit**

```bash
git commit -m "obs: initialize OpenTelemetry SDK with OTLP exporter"
```

---

### Task 2: Helpers de span (`src/observability/spans.ts`)

**Files:**
- Create: `src/observability/spans.ts`

- [ ] **Step 1: Implementar wrapper**

```typescript
import { SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { getTracer } from "./tracer";

export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
  tracer: Tracer = getTracer(),
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) span.setAttribute(k, v);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

- [ ] **Step 2: Commit**

---

### Task 3: Instrumentar `ExecutionHandler`

**Files:**
- Modify: `src/runtime/execution-handler.ts`

- [ ] **Step 1: Envolver `handleExecution()` em span raiz — APÓS parse do payload**

⚠ Realidade: `src/runtime/execution-handler.ts:227` exporta `async function handleExecution(rawPayload: unknown, ctx: ExecutionContext)` (não classe, não `Job`). BullMQ desempacota antes em `bullmq-consumer.ts`. `execution_id`/`account_id` só ficam disponíveis após Zod parse (linhas ~232-239).

```typescript
export async function handleExecution(rawPayload: unknown, ctx: ExecutionContext) {
  // 1. Parse primeiro (precisa do execution_id para attrs do span)
  const payload = executionPayloadSchema.parse(rawPayload);
  const execution_id = payload.execution_id;
  const accountId = payload.account?.id ?? payload.account_id;

  return withSpan("execution.handle", {
    "execution.id": execution_id,
    "account.id": accountId,
  }, async () => {
    // ... corpo existente do handler a partir do passo 2 (dedup, session, pipeline, ...)
  });
}
```

- [ ] **Step 2: Spans aninhados**

- `execution.dedup`
- `execution.session.create`
- `execution.pipeline` (com sub-spans `pipeline.message_analyzer`, `pipeline.memory_extractor`)
- `execution.router.resolve`
- `execution.context.build`
- `execution.permissions.filter`
- `execution.surface.loop` (envolve a chamada a `runSurfaceAgentLoop`, função separada em `execution-handler.ts:120-184` — wrap no callsite ~linha 401, não dentro da função)
- `execution.callback.complete`

⚠ Attributes que dependem do resultado (`reasoning.escalated`, `reasoning.steps`) são setados via `span.setAttribute(...)` **após** a execução, não em attrs iniciais.

- [ ] **Step 3: Atributos importantes em cada span**

`execution.surface.loop`:
- `agent.name`
- `reasoning.engine`
- `reasoning.steps`
- `reasoning.escalated` (bool)

- [ ] **Step 4: Teste de instrumentação**

```typescript
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

it("creates expected span tree", async () => {
  const exporter = new InMemorySpanExporter();
  // ... setup com exporter in-memory
  await handler.handle(job);
  const spans = exporter.getFinishedSpans();
  expect(spans.map((s) => s.name)).toContain("execution.handle");
  expect(spans.map((s) => s.name)).toContain("execution.surface.loop");
});
```

- [ ] **Step 5: Commit**

```bash
git commit -m "obs: instrument ExecutionHandler with OTEL spans"
```

---

### Task 4: Instrumentar reasoning engines e tools

**Files:**
- Modify: `src/reasoning/{direct,react,plan-execute,rewoo,reflexion}.ts`
- Modify: `src/tools/registry.ts` (entry point centralizado de tool calls)

- [ ] **Step 1: Em cada engine, envolver `step()` — assinatura REAL do `ReasoningEngine`**

⚠ Realidade (`src/reasoning/engine.ts:99-106`):

```typescript
step(
  plan: Plan,
  stepIndex: number,
  tools: ToolDefinition[],
  context: AgentExecutionContext,
  executeTool: ToolExecutor,
  traceCallback?: TraceCallback,
): Promise<StepResult>
```

Todos os 5 engines implementam exatamente essa assinatura.

```typescript
async step(plan, stepIndex, tools, context, executeTool, traceCallback) {
  return withSpan("reasoning.step", {
    "engine.type": this.type,
    "step.index": stepIndex,
    "plan.length": plan.steps?.length,
  }, async () => {
    // ... lógica existente do engine
  });
}
```

- [ ] **Step 2: Envolver o closure `executeTool` em `execution-handler.ts:392-399`**

⚠ Realidade: `src/tools/registry.ts` **não tem** método `execute()` — só `register/resolve/resolveOrThrow/getAllTools/listByCategory`. O ponto **único** onde tools são invocadas é o closure `executeTool: ToolExecutor` construído dentro de `handleExecution` (linhas ~392-399). Engines recebem esse closure e o chamam — nunca invocam `tool.execute()` diretamente.

```typescript
// Em handleExecution, ao construir o executeTool closure (linhas ~392-399):
const executeTool: ToolExecutor = async (toolName, params, toolContext) => {
  const tool = toolRegistry.resolve(toolName);
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  return withSpan("tool.execute", {
    "tool.name": tool.name,
    "tool.category": tool.category,
  }, async () => tool.execute(params, toolContext));
};
```

Opcionalmente: extrair como `createInstrumentedToolExecutor(registry)` em arquivo novo se quiser reuso.

- [ ] **Step 3: Commit por arquivo**

---

### Task 5: Usage Tracker (tokens, cost, latency)

**Files:**
- Create: `src/observability/usage-tracker.ts`
- Create: `src/observability/cost-calculator.ts`
- Create: `migrations/003_execution_usage.sql` (assume F3 mergeada com `002_permission_audit.sql`; ajustar número se necessário)

- [ ] **Step 1: Migration**

⚠ `account_id INTEGER REFERENCES accounts(id)` — bate com migration 001 e payload real (`account.id: z.number().int()`). `execution_id UUID` — bate com `z.string().uuid()` do payload.

```sql
-- UP
CREATE TABLE execution_usage (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd_cents INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  call_purpose TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_execution_usage_execution ON execution_usage(execution_id);
CREATE INDEX idx_execution_usage_account_day ON execution_usage(account_id, created_at);

-- DOWN
DROP TABLE execution_usage;
```

- [ ] **Step 2: `cost-calculator.ts`**

```typescript
const PRICING_PER_1M_TOKENS_USD_CENTS = {
  // OpenAI
  "gpt-4o-mini": { prompt: 15, completion: 60 },
  "gpt-4o":      { prompt: 250, completion: 1000 },
  // Gemini
  "gemini-1.5-pro":   { prompt: 125, completion: 500 },
  "gemini-1.5-flash": { prompt: 7.5, completion: 30 },
  // Anthropic (only se F5 adicionar AnthropicAdapter; codebase atual não tem)
  // "claude-3-5-sonnet": { prompt: 300, completion: 1500 },
  // ... atualizar conforme tabela oficial
} as const;

const warnedModels = new Set<string>();

export function calculateCostCents(
  model: string,
  promptTokens: number,
  completionTokens: number,
  logger?: { warn(obj: object, msg: string): void },
): number {
  const pricing = PRICING_PER_1M_TOKENS_USD_CENTS[model as keyof typeof PRICING_PER_1M_TOKENS_USD_CENTS];
  if (!pricing) {
    if (logger && !warnedModels.has(model)) {
      warnedModels.add(model);
      logger.warn({ model }, "cost_calculator: unknown model, cost reported as 0");
    }
    return 0;
  }
  return Math.ceil(
    (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1_000_000,
  );
}
```

- [ ] **Step 3: `usage-tracker.ts`**

```typescript
export class UsageTracker {
  constructor(private pool: Pool) {}

  async record(entry: UsageEntry): Promise<void> {
    const cost = calculateCostCents(entry.model, entry.promptTokens, entry.completionTokens);
    await this.pool.query(
      `INSERT INTO execution_usage (execution_id, account_id, provider, model,
       prompt_tokens, completion_tokens, total_tokens, cost_usd_cents, latency_ms, call_purpose)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry.executionId, entry.accountId, entry.provider, entry.model,
       entry.promptTokens, entry.completionTokens,
       entry.promptTokens + entry.completionTokens, cost, entry.latencyMs, entry.purpose],
    );
  }
}
```

- [ ] **Step 4: Integrar no LLMGateway via `LLMRequestOptions.meta` (context propagation)**

⚠ Realidade: `LLMGateway.complete(options)` recebe apenas `LLMRequestOptions` — não tem `executionId`/`accountId`. Para usage tracker registrar essas FKs, **estender `LLMRequestOptions`** com campo opcional `meta`:

```typescript
// src/integration/llm-gateway.ts — adicionar campo
export interface LLMRequestOptions {
  // ... campos existentes
  meta?: {
    executionId?: string;
    accountId?: number;
    purpose?: string;  // 'message-analyzer', 'memory-extractor', 'surface-step', etc.
  };
}
```

Cada caller (engines, pipeline agents) preenche `meta`. Em decorator de observability (novo, antes da Fase 5):

```typescript
const response = await wrapped.complete(options);
if (options.meta) {
  await tracker.record({
    executionId: options.meta.executionId,
    accountId: options.meta.accountId,
    provider: response.provider,
    model: response.model,
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
    latencyMs: response.latency_ms,
    purpose: options.meta.purpose,
  });
}
```

Fase 5 vai compor: `Retry → CircuitBreaker → RateGuard → Usage → adapter`.

- [ ] **Step 5: Testes**

- [ ] **Step 6: Commit**

```bash
git commit -m "obs: add usage tracker for token/cost/latency telemetry"
```

---

### Task 6: Error Classifier

**Files:**
- Create: `src/observability/error-classifier.ts`
- Create: `tests/unit/observability/error-classifier.test.ts`

- [ ] **Step 1: Implementar**

```typescript
export type LLMErrorCategory =
  | "rate_limit"
  | "context_overflow"
  | "invalid_response"
  | "network"
  | "auth"
  | "server_error"
  | "unknown";

export function classifyLLMError(err: unknown): LLMErrorCategory {
  const message = (err as Error)?.message?.toLowerCase() ?? "";
  const status = (err as { status?: number })?.status;

  if (status === 429 || /rate.?limit|too many/.test(message)) return "rate_limit";
  if (status === 401 || status === 403 || /unauthorized|api.?key/.test(message)) return "auth";
  if (/context.?(length|window)|token.?limit|maximum context/.test(message)) return "context_overflow";
  if (/invalid.?json|parse|malformed/.test(message)) return "invalid_response";
  if (/econnrefused|enotfound|etimedout|network|fetch failed/.test(message)) return "network";
  if (status && status >= 500) return "server_error";
  return "unknown";
}

export function isRetryable(category: LLMErrorCategory): boolean {
  return ["rate_limit", "network", "server_error"].includes(category);
}
```

- [ ] **Step 2: Testes exaustivos**

```typescript
describe("classifyLLMError", () => {
  const cases: Array<[unknown, LLMErrorCategory]> = [
    [{ status: 429, message: "Rate limit exceeded" }, "rate_limit"],
    [{ status: 401, message: "Invalid API key" }, "auth"],
    [{ message: "context length 8192 exceeded" }, "context_overflow"],
    [new Error("ECONNREFUSED"), "network"],
    [{ status: 503, message: "Service unavailable" }, "server_error"],
    [{ message: "Cannot parse JSON" }, "invalid_response"],
    [new Error("???"), "unknown"],
  ];
  for (const [err, expected] of cases) {
    it(`classifies as ${expected}`, () => {
      expect(classifyLLMError(err)).toBe(expected);
    });
  }
});
```

- [ ] **Step 3: Integrar no LLMGateway — usar `LLMProviderError.statusCode` + active span**

⚠ Realidade: `LLMProviderError` já existe (`llm-gateway.ts:59-68`) com campo `statusCode`. Classifier deve priorizar `err.statusCode` sobre duck-typed `err.status`.

```typescript
export function classifyLLMError(err: unknown): LLMErrorCategory {
  const message = (err as Error)?.message?.toLowerCase() ?? "";
  // Prefer typed LLMProviderError
  const status = (err as { statusCode?: number; status?: number })?.statusCode
              ?? (err as { status?: number })?.status;
  // ... resto da lógica
}
```

E ao consumir no adapter, **usar active span** em vez de variável local (que não está em escopo no catch):

```typescript
import { trace } from "@opentelemetry/api";
// dentro de complete() do adapter, em catch:
const category = classifyLLMError(err);
trace.getActiveSpan()?.setAttribute("error.category", category);
throw err;
```

(Pré-requisito: a chamada a `complete()` está dentro de algum `withSpan` upstream — Task 3 já cobre `execution.handle` + sub-spans.)

- [ ] **Step 4: Commit**

```bash
git commit -m "obs: add LLM error classifier with category taxonomy"
```

---

### Task 7: Documentar e validar fluxo

**Files:**
- Modify: `README.md`, `docs/architecture/observability.md` (criar)

- [ ] **Step 1: Doc com:**

- Como rodar localmente com OTLP collector
- Variáveis de ambiente OTEL
- Lista de spans emitidos e seus atributos
- Query exemplo para `execution_usage`

- [ ] **Step 2: Smoke test contra collector local (Jaeger ou Tempo)**

```bash
docker run -d -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one
OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces npm run dev
```

Disparar um job e verificar trace em http://localhost:16686.

- [ ] **Step 3: Commit + PR**

---

## Definition of Done

- ✅ Spans visíveis em Jaeger/Tempo cobrindo: handle → pipeline → surface → tools → llm
- ✅ Cada LLM call grava em `execution_usage` com tokens/cost/latency
- ✅ Cada erro LLM tem `error.category` no span
- ✅ Auto-instrumentação ativa para HTTP, pg, ioredis
- ✅ OTEL pode ser desabilitado via env var (rollback seguro)
- ✅ Documentação publicada

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Overhead de tracing afeta latência | OTEL_ENABLED=false default em prod até validação; sampling configurável |
| Conflito grave em `execution-handler.ts` (Fase 3) | Mergear Fase 3 antes; resolver conflitos em rebase |
| Conflito em `llm-gateway.ts` (Fase 5) | Coordenar sequência: Fase 4 instrumenta → Fase 5 refatora preservando spans |
| Cost calculator desatualizado | Atualizar tabela com PR mensal; alertar se modelo desconhecido |
| Custo de armazenamento `execution_usage` | Retention 90 dias + agregação mensal em backlog |
