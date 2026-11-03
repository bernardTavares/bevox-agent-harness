# Phase 5: LLM Gateway Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Adicionar robustez ao LLM Gateway existente (`src/integration/llm-gateway.ts`) sem quebrar a interface pública. Adicionar: novo adapter Anthropic (OpenAI e Gemini já existem), credential pool com rotação, circuit breaker, retry exponencial, rate guard por provider. Substituir o cliente LLM ainda não cabeado em `src/agents/execution-context.ts:56` (TODO "sub-project 4") por instância do gateway real.

**⚠ Backward compatibility obrigatória.** A interface pública (`LLMGateway`, `LLMRequestOptions`, `LLMResponse`, `LLMMessage` com role `'system' | 'user' | 'assistant' | 'tool'`, `LLMTool`, `LLMToolCall`, `LLMProviderError`) **NÃO** muda — todos os reasoning engines, agents e tools dependem dela. Tool-calling (`tools` em request, `tool_calls` em response) é preservado em V1 — não diferido.

**Architecture:** O `createLLMGateway()` existente é refatorado para retornar um `LLMGateway` decorado: `RetryDecorator(CircuitBreakerDecorator(RateGuardDecorator(adapter)))`. Adapters atuais (OpenAI, Gemini) extraídos para arquivos separados; novo Anthropic adicionado. `CredentialPool` injetado nos adapters via factory. Decorators usam `LLMErrorCategory`/`isRetryable` de Phase 4 (HARD dep).

**Tech Stack:** SDKs HTTP nativos (mantém padrão atual de `fetch`), `opossum` (circuit breaker), retry implementado in-house consumindo `error-classifier` de Phase 4.

---

## Dependencies

- **Hard:** Fase 4 — importa `LLMErrorCategory`, `classifyLLMError`, `isRetryable` de `src/observability/error-classifier`. Sem F4, retry/circuit não compila.
- **Hard:** Fase 2 — testes de regressão de todos os engines (ReAct, Plan-Execute, ReWOO) **devem passar** após refator, pois consomem `tool_calls`/`content: string | null`.
- **Soft:** Fase 3 (redactors cobrem credenciais nos novos adapters).
- **Blocks:** Nada externo.
- **Conflitos:** Fase 3 modifica `llm-gateway.ts` (redactors). Sequência obrigatória: 3 → 4 → 5.

## Files Touched

### Create
- `src/integration/llm/adapters/openai.adapter.ts` (extraído do `llm-gateway.ts` atual)
- `src/integration/llm/adapters/anthropic.adapter.ts` (novo)
- `src/integration/llm/adapters/gemini.adapter.ts` (extraído)
- `src/integration/llm/credential-pool.ts`
- `src/integration/llm/circuit-breaker.ts`
- `src/integration/llm/retry-decorator.ts`
- `src/integration/llm/rate-guard-decorator.ts`
- `tests/unit/integration/llm/*.test.ts`
- `tests/integration/llm-gateway.integration.test.ts`

### Modify (⚠️ conflitos)
- ⚠️ `src/integration/llm-gateway.ts` — vira **fachada**: re-exporta tipos públicos (preservados) + nova `createLLMGateway()` que compõe decorators. Adapters movidos para `./llm/adapters/`.
- ⚠️ `src/agents/execution-context.ts` — linha 56 (`llmClient: LlmClient`) ainda usa interface separada `LlmClient` (mais simples que `LLMGateway`). Decidir: (a) trocar campo para `llmClient: LLMGateway` e migrar callers, OU (b) criar adapter `LlmClient → LLMGateway` (mais conservador). **Recomendado: opção (b) em V1**.
- `src/config/env.ts` — vars de credentials, rate guards, circuit breaker
- `src/runtime/harness.ts` ou `src/bootstrap/04-warmup-pipeline.ts` — onde gateway é instanciado/injetado
- `package.json`

### NÃO modificar (preservar interface)
- `src/reasoning/*` — consomem `LLMGateway` via injection; interface preservada
- `src/agents/pipeline/*` — idem
- `src/integration/llm-gateway.ts` exports públicos (`LLMMessage`, `LLMTool`, `LLMToolCall`, `LLMResponse`, `LLMRequestOptions`, `LLMGateway`, `LLMProviderError`)

### High-conflict files
- ⚠️ `src/integration/llm-gateway.ts` (ou `gateway.ts`) — Fases 3, 4

## Estimated Effort
2 semanas (~50-60 horas).

---

## Tasks

### Task 0: Auditoria de interface e descoberta de callers

**Files:** nenhum modificado — apenas inspeção.

- [ ] **Step 1: Listar callers de `LLMGateway.complete()` e shapes consumidos**

```bash
grep -rn "complete(" src/reasoning src/agents src/runtime | grep -v test
grep -rn "tool_calls\|input_tokens\|content === null" src/
```
Documentar quais campos são lidos para garantir preservação total no refator.

- [ ] **Step 2: Verificar interface real**

Confirmar em `src/integration/llm-gateway.ts`:
- `LLMMessage.role: 'system' | 'user' | 'assistant' | 'tool'` (inclui `tool`)
- `LLMResponse.content: string | null` (pode ser null em tool_call)
- `LLMResponse.usage: { input_tokens, output_tokens, total_tokens }`
- `LLMResponse.latency_ms` (presente)
- `LLMRequestOptions` único param do `.complete()`
- `LLMTool`, `LLMToolCall`, `LLMProviderError` exportados

- [ ] **Step 3: Confirmar `LlmClient` separada em `src/agents/execution-context.ts`**

```bash
sed -n '5,30p' src/agents/execution-context.ts
```
Tem campos diferentes (`system`, `user` strings, sem tool calling). É a "interface DirectEngine" prevista pelo TODO. Plano: criar adapter `LLMGateway → LlmClient` (envolve um LLMGateway e expõe a interface mais simples LlmClient) em Task 9.

### Task 1: Criar contratos internos para adapters (mantém público intacto)

**Files:**
- Create: `src/integration/llm/internal.ts`

- [ ] **Step 1: `internal.ts` — contratos internos**

```typescript
// Reuso TOTAL das interfaces públicas de llm-gateway.ts.
// Esta é apenas a interface que adapters implementam internamente.
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway";

export type Provider = "openai" | "anthropic" | "gemini";

export interface LLMAdapter extends LLMGateway {
  readonly provider: Provider;
  readonly model: string;
  supportsModel(model: string): boolean;
}

export interface LLMDecorator extends LLMGateway {
  readonly wrapped: LLMGateway;
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(llm): internal adapter/decorator contracts (public API preserved)"
```

---

### Task 2: Extrair OpenAI e Gemini adapters do `llm-gateway.ts` atual

**Files:**
- Create: `src/integration/llm/adapters/openai.adapter.ts` (mover classe `OpenAIAdapter` existente)
- Create: `src/integration/llm/adapters/gemini.adapter.ts` (mover classe `GeminiAdapter` existente)
- Modify: `src/integration/llm-gateway.ts` (remove implementações, importa de `./llm/adapters/`)

- [ ] **Step 1: Mover `OpenAIAdapter` e `GeminiAdapter` sem alterar lógica**

Cut/paste das classes existentes em `llm-gateway.ts` (linhas ~120 e ~242). **Adicionar palavra-chave `export`** — hoje são `class` sem `export`. Manter constructor `(model: string)` (constructor será trocado em Task 8 para receber `pool`). Adicionar campos `readonly provider`, `readonly model` e método `supportsModel`.

- [ ] **Step 2: Adicionar testes contra adapters extraídos (mock `fetch`)**

```typescript
import { describe, it, expect, vi } from "vitest";
import { OpenAIAdapter } from "../../../../src/integration/llm/adapters/openai.adapter";

describe("OpenAIAdapter", () => {
  it("complete maps tool_calls correctly", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{}" }}] }}],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: "gpt-4o",
      }),
    } as Response);
    const adapter = new OpenAIAdapter("gpt-4o");
    const res = await adapter.complete({ messages: [{ role: "user", content: "x" }] });
    expect(res.tool_calls).toHaveLength(1);
    expect(res.content).toBeNull();
  });
});
```

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(llm): extract OpenAI and Gemini adapters to ./llm/adapters/"
```

---

### Task 3: Anthropic Adapter (novo provider)

**Files:**
- Create: `src/integration/llm/adapters/anthropic.adapter.ts`

- [ ] **Step 1: Implementar com `fetch` (mantém padrão do projeto)**

API: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`.

Mapeamentos:
- Anthropic recebe `system` separado dos `messages` (extrair primeiro elemento `role: 'system'`)
- Anthropic `tools` → `{ name, description, input_schema }` (input_schema = nosso `parameters`)
- Response: `content` é array de blocks (`type: 'text' | 'tool_use'`). Mapear text blocks → `content` string concatenada; tool_use blocks → `tool_calls`
- Usage: `input_tokens` / `output_tokens` mapeiam direto
- `content` deve ser `string | null` (null se houver apenas tool_calls)

```typescript
import type { LLMGateway, LLMRequestOptions, LLMResponse, LLMToolCall } from "../../llm-gateway";
import { LLMProviderError } from "../../llm-gateway";
import { getEnv } from "../../../config/env";

export class AnthropicAdapter implements LLMGateway {
  readonly provider = "anthropic";
  constructor(public readonly model: string) {
    const env = getEnv();
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  }
  supportsModel(model: string) {
    return model.startsWith("claude-");
  }
  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    // ... mapping completo (text blocks, tool_use blocks, system extraction)
    // Retornar shape EXATA de LLMResponse — sem renomear nada
  }
}
```

- [ ] **Step 2: Testes (mock fetch, casos: text-only, tool_use, system message)**

- [ ] **Step 3: Atualizar `createLLMGateway` em `llm-gateway.ts` para suportar `case 'anthropic'`**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(llm): add Anthropic adapter"
```

---

### Task 4: Credential Pool

**Files:**
- Create: `src/integration/llm/credential-pool.ts`
- Create: `tests/unit/integration/llm/credential-pool.test.ts`

- [ ] **Step 1: Implementar pool round-robin por provider com cooldown**

```typescript
interface CredentialEntry {
  key: string;
  failureCount: number;
  cooldownUntil: number;
  lastUsed: number;
}

export class CredentialPool {
  private pools = new Map<Provider, CredentialEntry[]>();

  register(provider: Provider, keys: string[]) {
    this.pools.set(provider, keys.map((key) => ({ key, failureCount: 0, cooldownUntil: 0, lastUsed: 0 })));
  }

  acquire(provider: Provider): string {
    const pool = this.pools.get(provider) ?? [];
    const now = Date.now();
    const available = pool.filter((c) => c.cooldownUntil <= now);
    if (available.length === 0) {
      throw new Error(`No available credentials for ${provider}`);
    }
    const chosen = available.reduce((a, b) => a.lastUsed <= b.lastUsed ? a : b);
    chosen.lastUsed = now;
    return chosen.key;
  }

  reportFailure(provider: Provider, key: string, cooldownMs = 30_000) {
    const entry = this.pools.get(provider)?.find((c) => c.key === key);
    if (!entry) return;
    entry.failureCount += 1;
    entry.cooldownUntil = Date.now() + cooldownMs * entry.failureCount;
  }

  reportSuccess(provider: Provider, key: string) {
    const entry = this.pools.get(provider)?.find((c) => c.key === key);
    if (entry) entry.failureCount = 0;
  }
}
```

- [ ] **Step 2: Config em env (suportar múltiplas keys por provider)**

```typescript
OPENAI_API_KEYS: z.string().transform((s) => s.split(",").filter(Boolean)).default(""),
ANTHROPIC_API_KEYS: z.string().transform((s) => s.split(",").filter(Boolean)).default(""),
GEMINI_API_KEYS: z.string().transform((s) => s.split(",").filter(Boolean)).default(""),
```

(Manter `OPENAI_API_KEY` singular como fallback.)

- [ ] **Step 3: Testes**

- [ ] **Step 4: Commit**

---

### Task 5: Circuit Breaker Decorator

**Files:**
- Create: `src/integration/llm/circuit-breaker-decorator.ts`

- [ ] **Step 1: Instalar**

```bash
npm install opossum
npm install --save-dev @types/opossum
```

- [ ] **Step 2: Classe decorator que implementa `LLMGateway`**

```typescript
import CircuitBreaker from "opossum";
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway";

export interface CircuitBreakerOptions {
  timeoutMs: number;
  errorThresholdPct: number;
  resetMs: number;
}

export class CircuitBreakerDecorator implements LLMGateway {
  private breaker: CircuitBreaker<[LLMRequestOptions], LLMResponse>;

  constructor(
    private readonly wrapped: LLMGateway,
    private readonly provider: string,
    opts: CircuitBreakerOptions,
  ) {
    this.breaker = new CircuitBreaker<[LLMRequestOptions], LLMResponse>(
      (options) => this.wrapped.complete(options),
      {
        timeout: opts.timeoutMs,
        errorThresholdPercentage: opts.errorThresholdPct,
        resetTimeout: opts.resetMs,
        rollingCountTimeout: 60_000,
        rollingCountBuckets: 10,
        name: `llm-${this.provider}`,
        // Não conta auth/validation errors como falha do breaker — eles indicam
        // problema de credencial específica (resolvido pelo CredentialPool), não
        // saúde do provider. Conta apenas erros realmente retentáveis.
        errorFilter: (err: unknown) => !isRetryable(classifyLLMError(err)),
      },
    );
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    return this.breaker.fire(options);
  }
}
```

- [ ] **Step 3: Config**

```typescript
LLM_CIRCUIT_TIMEOUT_MS: z.coerce.number().default(30_000),
LLM_CIRCUIT_ERROR_THRESHOLD_PCT: z.coerce.number().default(50),
LLM_CIRCUIT_RESET_MS: z.coerce.number().default(30_000),
```

- [ ] **Step 4: Testes (forçar abertura, half-open, fechamento)**

- [ ] **Step 5: Commit**

---

### Task 6: Retry Decorator (backoff exponencial + jitter)

**Files:**
- Create: `src/integration/llm/retry-decorator.ts`

- [ ] **Step 1: Classe decorator + função `withRetry` (reusada nos testes)**

```typescript
import { classifyLLMError, isRetryable } from "../../observability/error-classifier";
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(classifyLLMError(err)) || attempt === opts.maxAttempts) throw err;
      const delay = Math.min(
        opts.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random()),
        opts.maxDelayMs,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export class RetryDecorator implements LLMGateway {
  constructor(
    private readonly wrapped: LLMGateway,
    private readonly opts: RetryOptions,
  ) {}

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    return withRetry(() => this.wrapped.complete(options), this.opts);
  }
}
```

- [ ] **Step 2: Testes**

```typescript
it("retries on network error and succeeds", async () => {
  let count = 0;
  const result = await withRetry(async () => {
    count++;
    if (count < 3) throw new Error("ECONNREFUSED");
    return "ok";
  }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10 });
  expect(result).toBe("ok");
  expect(count).toBe(3);
});

it("does not retry on auth error", async () => {
  let count = 0;
  await expect(withRetry(async () => {
    count++;
    throw { status: 401, message: "Invalid key" };
  }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10 })).rejects.toBeDefined();
  expect(count).toBe(1);
});
```

- [ ] **Step 3: Commit**

---

### Task 7: Rate Guard Decorator (per-provider, sliding window)

**Files:**
- Create: `src/integration/llm/rate-guard-decorator.ts`

- [ ] **Step 1: Classe decorator reusando `RateLimiter` da Fase 3**

```typescript
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway";
import type { RateLimiter } from "../../security/rate-limiter";

export class RateGuardDecorator implements LLMGateway {
  constructor(
    private readonly wrapped: LLMGateway,
    private readonly limiter: RateLimiter,
    private readonly provider: string,
    private readonly limitPerMin: number,
  ) {}

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const r = await this.limiter.check({
      key: `llm:${this.provider}`,
      limit: this.limitPerMin,
      windowMs: 60_000,
    });
    if (!r.allowed) throw new Error(`LLM rate limit exceeded for ${this.provider}`);
    return this.wrapped.complete(options);
  }
}
```

- [ ] **Step 2: Config**

```typescript
LLM_RATE_LIMIT_OPENAI_PER_MIN: z.coerce.number().default(500),
LLM_RATE_LIMIT_ANTHROPIC_PER_MIN: z.coerce.number().default(500),
LLM_RATE_LIMIT_GEMINI_PER_MIN: z.coerce.number().default(500),
```

- [ ] **Step 3: Commit**

---

(Removido: Task 9 antiga "Gateway orquestrador" — substituída por composição de decorators na Task 10.)

---

### Task 8: Threading do CredentialPool nos adapters

⚠ O `CredentialPool` da Task 4 só funciona se os adapters pegarem chave dele a cada `complete()`. Adapters atuais leem `env.OPENAI_API_KEY` no constructor — não rotacionam.

**Files:**
- Modify: `src/integration/llm/adapters/openai.adapter.ts`
- Modify: `src/integration/llm/adapters/gemini.adapter.ts`
- Modify: `src/integration/llm/adapters/anthropic.adapter.ts`

- [ ] **Step 1: Trocar constructor para receber `CredentialPool` + remover validação de env**

⚠ **Importante:** este step deleta o `if (!env.OPENAI_API_KEY) throw` (linha ~125 atual) e equivalente em Gemini (linha ~247) e Anthropic (Task 3, linha ~188). Auth passa a ser responsabilidade de `CredentialPool.register()` no bootstrap + ping (Task 11). Sem essa remoção, o constructor falha quando só `_API_KEYS` (plural) está setado.

```typescript
export class OpenAIAdapter implements LLMGateway {
  readonly provider = "openai";
  constructor(
    public readonly model: string,
    private readonly pool: CredentialPool,
  ) {
    // NÃO validar env.OPENAI_API_KEY aqui — CredentialPool já garante credenciais válidas
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const apiKey = this.pool.acquire("openai");
    try {
      // ... lógica existente, mas usando apiKey local em vez de this.apiKey
      const result = /* fetch chamada com apiKey */;
      this.pool.reportSuccess("openai", apiKey);
      return result;
    } catch (err) {
      this.pool.reportFailure("openai", apiKey);
      throw err;
    }
  }
}
```

- [ ] **Step 2: Fallback retrocompatível**

Se `env.OPENAI_API_KEYS` (plural) vazio e `env.OPENAI_API_KEY` (singular) presente, `CredentialPool` é inicializado com lista de 1 elemento. Garante comportamento atual.

- [ ] **Step 3: Testes — pool rotaciona após falha**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(llm): thread CredentialPool into adapters for rotation"
```

---

### Task 9: Auditar `LlmClientBridge` existente e atualizar TODO comment

⚠ **Update após audit:** `LlmClientBridge` **já existe** em `src/runtime/execution-handler.ts:280` e é construído a partir de `createLLMGateway()`. O TODO em `src/agents/execution-context.ts:56` ("sub-project 4") está **stale** — o wiring já foi feito.

**Files:**
- Modify: `src/runtime/execution-handler.ts` (revisar `LlmClientBridge`, garantir que reusa o gateway decorado da Task 10)
- Modify: `src/agents/execution-context.ts` (remover/atualizar TODO da linha 56)
- (Opcional) Create: `src/integration/llm/llm-client-adapter.ts` se decidir extrair o bridge

- [ ] **Step 1: Auditar `LlmClientBridge` existente**

```bash
grep -n "LlmClientBridge\|class LlmClient" src/runtime/execution-handler.ts
```
Ler implementação: verificar (a) que recebe um `LLMGateway` no constructor, (b) que mapeia `LlmCompletionRequest` → `LLMRequestOptions` corretamente, (c) que mapeia `LLMResponse.usage.input_tokens/output_tokens` → `LlmCompletionResponse.promptTokens/completionTokens`.

⚠ Nota sobre `responseSchema`: se o bridge atual mapeia `req.responseFormat?.type === "json_object"` para `{ type: "object" }` (schema vazio), pipeline agents (MessageAnalyzer, MemoryExtractor) perdem enforcement de schema rico — comportamento aceitável em V1 mas documentar.

- [ ] **Step 2: Confirmar que o `gateway` passado ao bridge é o decorado (Task 10)**

Após Task 10, `createLLMGateway()` retorna `RetryDecorator(CircuitBreakerDecorator(RateGuardDecorator(adapter)))`. O bridge na linha 280 deve consumir esse retorno sem mudança — apenas validar que ainda funciona.

- [ ] **Step 3: Atualizar comentário stale em `src/agents/execution-context.ts:56`**

Remover: `/** LLM client for DirectEngine calls. Injected by harness runtime (sub-project 4). */`
Substituir por: `/** LLM client for DirectEngine calls (wraps the decorated LLMGateway via LlmClientBridge). */`

- [ ] **Step 4: Smoke test E2E**

```bash
npm run docker:up
npm run smoke:enqueue   # de Phase 7
# verificar logs do harness: DirectEngine deve receber respostas reais
```

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(llm): reuse existing LlmClientBridge with decorated gateway; remove stale TODO"
```

---

### Task 10: Compor decorators em `createLLMGateway`

**Files:**
- Modify: `src/integration/llm-gateway.ts` (apenas a factory)

- [ ] **Step 1: Atualizar factory para compor decorators**

```typescript
export function createLLMGateway(agentConfig: { default_model?: string }): LLMGateway {
  const env = getEnv();
  const { provider, model } = resolveProvider(agentConfig.default_model);
  const pool = getCredentialPool();          // singleton
  const rateLimiter = getRateLimiter();      // singleton (Phase 3)

  let adapter: LLMGateway;
  switch (provider) {
    case "openai":    adapter = new OpenAIAdapter(model, pool); break;
    case "anthropic": adapter = new AnthropicAdapter(model, pool); break;
    case "gemini":    adapter = new GeminiAdapter(model, pool); break;
    default:          adapter = new OpenAIAdapter(env.DEFAULT_LLM_MODEL, pool);
  }

  const rateLimit = getProviderRateLimit(provider, env);  // helper lê env.LLM_RATE_LIMIT_<PROVIDER>_PER_MIN
  return new RetryDecorator(
    new CircuitBreakerDecorator(
      new RateGuardDecorator(adapter, rateLimiter, provider, rateLimit),
      provider,
      { timeoutMs: env.LLM_CIRCUIT_TIMEOUT_MS, errorThresholdPct: env.LLM_CIRCUIT_ERROR_THRESHOLD_PCT, resetMs: env.LLM_CIRCUIT_RESET_MS },
    ),
    { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5_000 },
  );
}
```

- [ ] **Step 2: Garantir tests de regressão dos engines passam**

```bash
npm test -- reasoning
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(llm): compose retry + circuit-breaker + rate-guard decorators in factory"
```

---

### Task 11: Bootstrap credential ping

**Files:**
- Modify: `src/bootstrap/04-warmup-pipeline.ts` (ou estágio equivalente)

- [ ] **Step 1: Após registrar gateway, fazer ping leve por provider**

```typescript
// Para cada provider com credencial configurada, mandar uma request mínima
// (ex: 1 token, modelo barato). Falha de auth aborta bootstrap; rate_limit é warning.
for (const provider of configuredProviders) {
  try {
    const gateway = createLLMGateway({ default_model: pingModelFor(provider) });
    await gateway.complete({ messages: [{ role: "user", content: "ping" }], maxTokens: 1 });
    logger.info({ provider }, "llm credential ping ok");
  } catch (err) {
    const category = classifyLLMError(err);
    if (category === "auth") throw new Error(`LLM auth failed for ${provider}: ${err}`);
    logger.warn({ provider, category }, "llm credential ping non-fatal");
  }
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(llm): credential ping in bootstrap warmup stage"
```

---

## Definition of Done

- ✅ 3 adapters (OpenAI, Anthropic, Gemini) com testes unitários
- ✅ Credential pool com rotação e cooldown
- ✅ Circuit breaker por provider (testes de abertura/half-open/close)
- ✅ Retry exponencial + jitter, respeitando classificação de erro
- ✅ Rate guard por provider
- ✅ Mock removido de `execution-context.ts:56`
- ✅ Bootstrap valida credenciais (ping) antes de iniciar consumer
- ✅ Cobertura ≥ 80% em `src/integration/llm/*`

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Quebra silenciosa de interface usada por agents | Task 0 audita todos os callers; testes de regressão (Fase 2) executam antes/depois |
| Tool calling quebra em algum adapter | Task 2/3 incluem testes específicos de tool_calls; Anthropic mapping é o mais arriscado |
| Rotação de credenciais expõe key errada em log | Aplicar redactor da Fase 3 (keys já estão no path de redação) |
| Conflito grave em `llm-gateway.ts` | Sequência obrigatória 3→4→5; só uma fase mexe por vez |
| Circuit breaker abre falsamente em deploy | Default `errorThresholdPercentage: 50` em janela de 60s — não dispara com falha esporádica |
| `LlmClient` ≠ `LLMGateway` causa confusão | Manter ambas; adapter explícito em Task 9 documenta a ponte |
