# Sprint C.2: Streaming Responses (tokens + eventos) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Adicionar **streaming opcional** de tokens do LLM e de eventos intermediários (tool calls, reasoning steps) do harness para o Bevox via um novo endpoint de callback `POST /executions/{id}/stream-chunk`. Reduzir TTFB percebido na UI quando agent leva 5-15s em raciocínio longo. Inspirado em Mastra/Vercel AI SDK streaming.

**⚠ Backward compatibility obrigatória.** O método público `LLMGateway.complete()` **não** muda — todos os reasoning engines continuam funcionando como hoje. Streaming é exposto via método **novo** `LLMGateway.completeStream()` (opcional, AsyncIterable). Feature flag `STREAM_ENABLED=false` por default. Bevox precisa expor o endpoint de stream-chunk antes do flag ligar em prod (coordenar com time backend).

**Architecture:** Adapters (OpenAI, Anthropic, Gemini) ganham método `completeStream()` retornando `AsyncIterable<StreamChunk>`. `LLMGateway` (fachada) expõe novo método; decorators (retry/circuit/rate) só envolvem `complete()` clássico — streaming bypassa retry mas mantém rate guard. `execution-handler` instancia um `StreamPublisher` (singleton por execution) que recebe eventos e bufferiza (100ms ou 50 tokens) antes de chamar callback Bevox. Reasoning engines opt-in: `ReAct`/`PlanExecute` emitem eventos via callback opcional `streamCallback`.

**Tech Stack:** Native `fetch` com SSE parsing in-house, `AsyncIterable`, callback HTTP com `keep-alive`.

---

## Dependencies

- **Hard:** Nenhuma. Backward compat por design.
- **Soft:**
  - Phase 5 (LLM Gateway robustness) — adapters já modulares; estende contratos sem refazer
  - Phase 4 (observability) — eventos de streaming emitem spans curtos
- **Blocks:** Nada. C.1 (workflow) é independente; se ambos mergeados, workflow.step ganha streaming "de graça" se step usa LLM via gateway.
- **Conflitos:**
  - `src/integration/llm-gateway.ts` — adiciona método público `completeStream()` (low se Phase 5 mergeada)
  - `src/integration/llm/adapters/*` — cada adapter ganha método (low)
  - `src/runtime/execution-handler.ts` — também tocado por Sprint C.1 (ramo workflow). Coordenar: C.1 primeiro.

## Files Touched

### Create
- `src/integration/llm/streaming/types.ts` — `StreamChunk`, `CompleteStreamOptions`, `StreamPublisher` interface
- `src/integration/llm/streaming/buffer.ts` — `StreamBuffer` (agrega tokens por tempo/quantidade)
- `src/integration/llm/streaming/openai-stream.ts` — parser SSE OpenAI
- `src/integration/llm/streaming/anthropic-stream.ts` — parser SSE Anthropic
- `src/integration/llm/streaming/gemini-stream.ts` — parser Gemini streaming
- `src/integration/bevox-stream-callback.ts` — cliente HTTP para `POST /executions/{id}/stream-chunk`
- `src/runtime/stream-publisher.ts` — singleton por execution, agrega e flusha
- `tests/unit/integration/llm/streaming/*.test.ts`
- `tests/integration/streaming-e2e.test.ts`

### Modify
- `src/integration/llm-gateway.ts` — adicionar `completeStream?(opts): AsyncIterable<StreamChunk>` (método opcional)
- `src/integration/llm/adapters/openai.adapter.ts` — implementar `completeStream`
- `src/integration/llm/adapters/anthropic.adapter.ts` — idem
- `src/integration/llm/adapters/gemini.adapter.ts` — idem
- `src/integration/llm/rate-guard-decorator.ts` — propagar `completeStream` (consome 1 token do bucket no início)
- `src/integration/llm/circuit-breaker-decorator.ts` — **não envolver** stream (motivação na Task 4); apenas re-exportar do wrapped
- `src/integration/llm/retry-decorator.ts` — idem (stream não retém estado para retry parcial)
- `src/reasoning/react.ts` — emit opcional via `streamCallback` (entre step/observe)
- `src/reasoning/plan-execute.ts` — emit opcional após cada step
- `src/reasoning/engine.ts` — adicionar `StreamCallback` type (opt-in)
- `src/runtime/execution-handler.ts` — instanciar `StreamPublisher` se `payload.stream === true`
- `src/config/env.ts` — `STREAM_ENABLED`, `STREAM_FLUSH_MS`, `STREAM_FLUSH_TOKENS`, `STREAM_CALLBACK_TIMEOUT_MS`

### NÃO modificar
- Contrato de `LLMGateway.complete()` (preservado integralmente)
- `LLMResponse`, `LLMRequestOptions` (preservados)
- Reasoning engines em modo não-stream (comportamento idêntico)
- Schema do payload BullMQ (apenas adiciona campo **opcional** `stream`)

### High-conflict files
- ⚠️ `src/integration/llm-gateway.ts` — Phase 5
- ⚠️ `src/runtime/execution-handler.ts` — Sprint C.1
- ⚠️ Adapters — Phase 5 (sequência obrigatória: F5 → C.2)

## Estimated Effort
1.5-2 semanas (~40-50 horas).

---

## Tasks

### Task 1: Tipos núcleo

**Files:**
- Create: `src/integration/llm/streaming/types.ts`

- [ ] **Step 1: Definir `StreamChunk` e shapes**

```typescript
// src/integration/llm/streaming/types.ts
export type StreamChunkType =
  | "token"             // delta de texto do LLM
  | "tool_call_start"   // LLM começou a emitir tool_call (nome conhecido)
  | "tool_call_delta"   // delta de arguments JSON (parcial)
  | "tool_call_complete"// arguments parsed OK
  | "tool_result"       // resultado da execução da tool
  | "reasoning_step"    // engine avançou um step (ReAct/Plan-Execute)
  | "engine_strategy"   // engine escolhido (após escalation)
  | "error"             // erro recuperável (não fatal)
  | "done";             // fim do stream

export interface StreamChunk {
  type: StreamChunkType;
  /** Sequence number monotônico por execution — Bevox usa para reordenar/deduplicar. */
  seq: number;
  timestamp: number;
  payload: unknown;     // shape depende de type (documentado abaixo)
}

// Shapes de payload por type:
// token:               { delta: string }
// tool_call_start:     { toolCallId: string, name: string }
// tool_call_delta:     { toolCallId: string, argsDelta: string }   // JSON parcial
// tool_call_complete:  { toolCallId: string, name: string, args: unknown }
// tool_result:         { toolCallId: string, success: boolean, output: unknown, durationMs: number }
// reasoning_step:      { strategy: string, stepIndex: number, summary: string }
// engine_strategy:     { from: string, to: string, reason: string }
// error:               { message: string, recoverable: boolean }
// done:                { totalTokens?: number, totalDurationMs: number }

export interface CompleteStreamOptions extends LLMRequestOptions {
  /** Sinal de abort (timeout, client disconnect). */
  signal?: AbortSignal;
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(stream): core type definitions"
```

---

### Task 2: SSE parser e adapter OpenAI streaming

**Files:**
- Create: `src/integration/llm/streaming/openai-stream.ts`
- Modify: `src/integration/llm/adapters/openai.adapter.ts`

- [ ] **Step 1: SSE parser genérico**

```typescript
// src/integration/llm/streaming/openai-stream.ts
export async function* parseSSE(response: Response): AsyncIterable<{ event?: string; data: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = raw.split("\n");
      const event: { event?: string; data: string } = { data: "" };
      for (const line of lines) {
        if (line.startsWith("event:")) event.event = line.slice(6).trim();
        else if (line.startsWith("data:")) event.data += line.slice(5).trim();
      }
      if (event.data) yield event;
    }
  }
}
```

- [ ] **Step 2: `OpenAIAdapter.completeStream`**

```typescript
async *completeStream(opts: CompleteStreamOptions): AsyncIterable<StreamChunk> {
  const apiKey = this.pool.acquire("openai");
  let seq = 0;
  const started = Date.now();
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...buildBody(opts), stream: true }),
      signal: opts.signal,
    });
    if (!response.ok) {
      this.pool.reportFailure("openai", apiKey);
      throw new LLMProviderError(`openai stream HTTP ${response.status}`, response.status);
    }
    for await (const evt of parseSSE(response)) {
      if (evt.data === "[DONE]") break;
      const json = JSON.parse(evt.data);
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) {
        yield { type: "token", seq: seq++, timestamp: Date.now(), payload: { delta: delta.content } };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name && !this.startedToolCalls.has(tc.id)) {
            this.startedToolCalls.add(tc.id);
            yield { type: "tool_call_start", seq: seq++, timestamp: Date.now(), payload: { toolCallId: tc.id, name: tc.function.name } };
          }
          if (tc.function?.arguments) {
            yield { type: "tool_call_delta", seq: seq++, timestamp: Date.now(), payload: { toolCallId: tc.id, argsDelta: tc.function.arguments } };
          }
        }
      }
    }
    this.pool.reportSuccess("openai", apiKey);
    yield { type: "done", seq: seq++, timestamp: Date.now(), payload: { totalDurationMs: Date.now() - started } };
  } catch (err) {
    yield { type: "error", seq: seq++, timestamp: Date.now(), payload: { message: String(err), recoverable: false } };
    throw err;
  }
}
```

⚠ **Buffering de tool_call args**: o stream emite `tool_call_delta` cru. Quem decide quando args estão completos é o consumidor (TaskPublisher na Task 6), que tenta `JSON.parse` incrementalmente e emite `tool_call_complete` quando parsing bem-sucedido.

- [ ] **Step 3: Testes — mock fetch retornando SSE com 3 token deltas + 1 tool_call**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(stream): openai adapter completeStream with SSE parser"
```

---

### Task 3: Anthropic e Gemini streaming

**Files:**
- Create: `src/integration/llm/streaming/anthropic-stream.ts`
- Create: `src/integration/llm/streaming/gemini-stream.ts`
- Modify: `src/integration/llm/adapters/anthropic.adapter.ts`
- Modify: `src/integration/llm/adapters/gemini.adapter.ts`

- [ ] **Step 1: Anthropic streaming**

API: `POST /v1/messages` com `"stream": true`. SSE events: `message_start`, `content_block_start`, `content_block_delta` (com `delta.type: 'text_delta' | 'input_json_delta'`), `content_block_stop`, `message_delta`, `message_stop`.

Mapeamento:
- `content_block_delta` + `delta.type === 'text_delta'` → `token`
- `content_block_start` com `content_block.type === 'tool_use'` → `tool_call_start`
- `content_block_delta` + `delta.type === 'input_json_delta'` → `tool_call_delta`
- `content_block_stop` em tool_use → não emite `tool_call_complete` (publisher faz parse)
- `message_stop` → `done`

- [ ] **Step 2: Gemini streaming**

`generateContentStream` (REST: `POST /v1beta/models/{model}:streamGenerateContent`). Não é SSE puro — retorna JSONL com `?alt=sse` ou array streaming. Usar `?alt=sse` para uniformidade.

- [ ] **Step 3: Testes — fixtures SSE reais de cada provider**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(stream): anthropic and gemini completeStream"
```

---

### Task 4: Fachada `LLMGateway.completeStream` e decorators

**Files:**
- Modify: `src/integration/llm-gateway.ts`
- Modify: `src/integration/llm/rate-guard-decorator.ts`
- Modify: `src/integration/llm/retry-decorator.ts`
- Modify: `src/integration/llm/circuit-breaker-decorator.ts`

- [ ] **Step 1: Estender interface `LLMGateway`**

```typescript
export interface LLMGateway {
  complete(options: LLMRequestOptions): Promise<LLMResponse>;
  /** Opcional — adapters/decorators que não suportam streaming retornam undefined. */
  completeStream?(options: CompleteStreamOptions): AsyncIterable<StreamChunk>;
}
```

⚠ Método **opcional** (`?`). Reasoning engines existentes não chamam — backward compat.

- [ ] **Step 2: Rate guard envolve streaming também**

```typescript
async *completeStream(opts: CompleteStreamOptions): AsyncIterable<StreamChunk> {
  const r = await this.limiter.check({ key: `llm:${this.provider}`, limit: this.limitPerMin, windowMs: 60_000 });
  if (!r.allowed) throw new Error(`LLM rate limit exceeded for ${this.provider}`);
  if (!this.wrapped.completeStream) throw new Error("Wrapped gateway does not support streaming");
  yield* this.wrapped.completeStream(opts);
}
```

- [ ] **Step 3: Retry e circuit breaker — pass-through (decisão explícita)**

```typescript
// retry-decorator.ts
completeStream(opts: CompleteStreamOptions) {
  // Streaming não é retentável (estado parcial já entregue ao consumidor).
  // Falha no meio do stream → erro propaga para o publisher, que emite chunk { type: 'error' }.
  if (!this.wrapped.completeStream) throw new Error("...");
  return this.wrapped.completeStream(opts);
}

// circuit-breaker-decorator.ts
completeStream(opts: CompleteStreamOptions) {
  // Opossum não tem semântica para AsyncIterable; bypassa.
  // Stream conta como 1 chamada para rate guard mas NÃO afeta breaker counters.
  // Justificativa: stream é interativo — abrir breaker no meio é pior UX que falhar uma vez.
  if (!this.wrapped.completeStream) throw new Error("...");
  return this.wrapped.completeStream(opts);
}
```

⚠ Documentar em ADR: "streaming bypassa retry e circuit breaker por design". Sem isso, futuros maintainers podem tentar envolver e quebrar.

- [ ] **Step 4: Testes — decorator chain ainda funciona em `complete()` regular**

```bash
npm test -- llm/integration
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(stream): completeStream surface on gateway + decorator pass-through"
```

---

### Task 5: Stream buffer (agregação por tempo/tokens)

**Files:**
- Create: `src/integration/llm/streaming/buffer.ts`
- Create: `tests/unit/integration/llm/streaming/buffer.test.ts`

- [ ] **Step 1: Classe `StreamBuffer`**

Função: receber tokens crus 1-a-1 do LLM e flushar em chunks de N tokens OU M milissegundos (o que vier primeiro). Reduz volume de callbacks HTTP.

```typescript
export interface StreamBufferOptions {
  flushMs: number;
  flushTokens: number;
  onFlush: (aggregated: { text: string; tokenCount: number }) => Promise<void>;
}

export class StreamBuffer {
  private accum = "";
  private tokens = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly opts: StreamBufferOptions) {}

  push(delta: string): void {
    this.accum += delta;
    this.tokens += 1; // aproximação — 1 delta ≈ 1 token
    if (this.tokens >= this.opts.flushTokens) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.opts.flushMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.tokens === 0) return;
    const payload = { text: this.accum, tokenCount: this.tokens };
    this.accum = ""; this.tokens = 0;
    await this.opts.onFlush(payload);
  }
}
```

⚠ **Tool call deltas NÃO passam pelo buffer** — emitidos imediatamente (UX: usuário quer ver "buscando agenda..." sem delay).

- [ ] **Step 2: Testes**
  - Flush por threshold de tokens
  - Flush por timer
  - Flush manual no `done`
  - `push` após flush reinicia timer

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(stream): stream buffer with time/token thresholds"
```

---

### Task 6: StreamPublisher (orquestra adapter + buffer + callback)

**Files:**
- Create: `src/runtime/stream-publisher.ts`
- Create: `src/integration/bevox-stream-callback.ts`

- [ ] **Step 1: HTTP client para callback Bevox**

```typescript
// src/integration/bevox-stream-callback.ts
export async function sendStreamChunk(
  baseUrl: string,
  executionId: string,
  token: string,
  chunk: StreamChunk,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/executions/${executionId}/stream-chunk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Execution-Token": token,
        "Connection": "keep-alive",
      },
      body: JSON.stringify(chunk),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`stream-chunk HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 2: `StreamPublisher` — facade por execution**

```typescript
// src/runtime/stream-publisher.ts
export class StreamPublisher {
  private seq = 0;
  private buffer: StreamBuffer;
  private toolArgBuffers = new Map<string, string>(); // toolCallId → JSON parcial

  constructor(
    private readonly executionId: string,
    private readonly token: string,
    private readonly callbackBaseUrl: string,
    bufferOpts: { flushMs: number; flushTokens: number; callbackTimeoutMs: number },
  ) {
    this.buffer = new StreamBuffer({
      flushMs: bufferOpts.flushMs,
      flushTokens: bufferOpts.flushTokens,
      onFlush: async ({ text }) => this.emit({ type: "token", payload: { delta: text } }),
    });
  }

  /** Consumir o stream do adapter, agregar e publicar. */
  async pump(stream: AsyncIterable<StreamChunk>): Promise<void> {
    for await (const chunk of stream) {
      if (chunk.type === "token") {
        this.buffer.push((chunk.payload as { delta: string }).delta);
      } else if (chunk.type === "tool_call_delta") {
        const { toolCallId, argsDelta } = chunk.payload as { toolCallId: string; argsDelta: string };
        const accum = (this.toolArgBuffers.get(toolCallId) ?? "") + argsDelta;
        this.toolArgBuffers.set(toolCallId, accum);
        await this.emit(chunk); // emit cru para UI mostrar progresso
        // Tenta parse — se OK, emite tool_call_complete
        try {
          const parsed = JSON.parse(accum);
          this.toolArgBuffers.delete(toolCallId);
          await this.emit({ type: "tool_call_complete", payload: { toolCallId, name: "", args: parsed } });
        } catch { /* JSON ainda parcial — ignora */ }
      } else if (chunk.type === "done") {
        await this.buffer.flush();
        await this.emit(chunk);
      } else {
        await this.emit(chunk);
      }
    }
  }

  /** Emit ad-hoc — usado por reasoning engines para reasoning_step / engine_strategy. */
  async emit(partial: Omit<StreamChunk, "seq" | "timestamp">): Promise<void> {
    const chunk: StreamChunk = { ...partial, seq: this.seq++, timestamp: Date.now() };
    try {
      await sendStreamChunk(this.callbackBaseUrl, this.executionId, this.token, chunk, /* timeout */ 5_000);
    } catch (err) {
      // Backpressure: log warn e CONTINUA — não bloqueia inferência
      logger.warn({ err, chunkType: chunk.type, seq: chunk.seq }, "stream-chunk callback failed");
    }
  }
}
```

⚠ **Backpressure design**: falha de callback **não** propaga. Streaming é best-effort — perda de chunk não invalida a execução, pois o `complete` final ainda é enviado.

- [ ] **Step 3: Testes — mock fetch, verifica seq monotônico, parsing tool args incremental**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(stream): stream publisher with backpressure-safe callbacks"
```

---

### Task 7: Hook em reasoning engines (opt-in)

**Files:**
- Modify: `src/reasoning/engine.ts`
- Modify: `src/reasoning/react.ts`
- Modify: `src/reasoning/plan-execute.ts`

- [ ] **Step 1: Adicionar `StreamCallback` type**

```typescript
// src/reasoning/engine.ts
export type StreamCallback = (event: {
  type: "reasoning_step" | "engine_strategy";
  payload: unknown;
}) => Promise<void>;
```

- [ ] **Step 2: ReAct emite entre step e observe**

```typescript
// src/reasoning/react.ts
async step(plan, idx, tools, ctx, executeTool, traceCallback, streamCallback?): Promise<StepResult> {
  // ... lógica atual ...
  await streamCallback?.({
    type: "reasoning_step",
    payload: { strategy: "react", stepIndex: idx, summary: thinkingTrace?.slice(0, 200) ?? "" },
  });
  return result;
}
```

⚠ **`streamCallback` é opcional na assinatura** — engines sem stream nunca chamam, contrato preservado.

⚠ Mudança de assinatura em `ReasoningEngine.step` é **aditiva** (param opcional no fim). Verificar que todos os engines compilam (TypeScript permite override que ignora parâmetros opcionais).

- [ ] **Step 3: PlanExecute emite após cada step do plano**

- [ ] **Step 4: Strategy router emite `engine_strategy` em escalation**

```typescript
// src/reasoning/strategy-router.ts (dentro do branch de escalation)
await streamCallback?.({
  type: "engine_strategy",
  payload: { from: currentStrategy, to: escalatedStrategy, reason: "step-threshold" },
});
```

- [ ] **Step 5: Testes — engines com `streamCallback` definido recebem eventos; sem callback comportamento idêntico ao baseline**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(stream): opt-in stream events from react and plan-execute"
```

---

### Task 8: Integração com execution-handler

**Files:**
- Modify: `src/runtime/execution-handler.ts`
- Modify: `src/config/env.ts`

- [ ] **Step 1: Env vars**

```typescript
STREAM_ENABLED: z.coerce.boolean().default(false),
STREAM_FLUSH_MS: z.coerce.number().min(50).max(2000).default(100),
STREAM_FLUSH_TOKENS: z.coerce.number().min(1).max(500).default(50),
STREAM_CALLBACK_TIMEOUT_MS: z.coerce.number().default(5000),
```

- [ ] **Step 2: Payload schema — campo opcional `stream`**

```typescript
const executionPayloadSchema = z.object({
  // ... campos existentes ...
  stream: z.boolean().optional().default(false),
});
```

⚠ Se `payload.stream === true` mas `env.STREAM_ENABLED === false`, ignorar com warn no log. Feature flag global vence o opt-in por execução.

- [ ] **Step 3: Instanciar publisher condicionalmente**

```typescript
// src/runtime/execution-handler.ts
const streamEnabled = env.STREAM_ENABLED && payload.stream === true;
const publisher = streamEnabled
  ? new StreamPublisher(payload.execution_id, payload.execution_token, callbackBaseUrl, {
      flushMs: env.STREAM_FLUSH_MS,
      flushTokens: env.STREAM_FLUSH_TOKENS,
      callbackTimeoutMs: env.STREAM_CALLBACK_TIMEOUT_MS,
    })
  : undefined;

const streamCallback: StreamCallback | undefined = publisher
  ? (evt) => publisher.emit(evt)
  : undefined;

// Passar streamCallback nas chamadas de reasoning engine
const response = await engine.step(plan, idx, tools, ctx, executeTool, traceCallback, streamCallback);
```

- [ ] **Step 4: Pump direto do gateway quando engine é `direct`**

Engine direct é uma única chamada LLM — usa `gateway.completeStream` em vez de `complete`:

```typescript
if (engine.strategy === "direct" && streamEnabled && gateway.completeStream) {
  await publisher!.pump(gateway.completeStream(llmReq));
  // Direct engine usa o texto final do stream como answer
}
```

⚠ Para `react`/`plan-execute`/`rewoo`, gateway interno ainda usa `complete()` (não-stream) — eventos vêm de `streamCallback` no nível do engine. Isso é por design para v1: estourar tokens de cada step LLM via stream complica accumulator. Pode ser feito em sprint de seguimento.

- [ ] **Step 5: Testes E2E (mock callback Bevox)**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(stream): execution-handler integration with feature flag"
```

---

### Task 9: Documentação e contrato com Bevox

**Files:**
- Create: `docs/streaming/README.md`
- Modify: `openapi/agent-harness-v1.yaml` (adicionar referência ao novo callback Bevox)

- [ ] **Step 1: Documentar contrato esperado do Bevox**

`docs/streaming/README.md`:
- Endpoint: `POST {BEVOX_CALLBACK_BASE_URL}/executions/{id}/stream-chunk`
- Headers: `Content-Type: application/json`, `X-Execution-Token: <token>`
- Body: `StreamChunk` JSON
- Response esperada: `204 No Content`
- Idempotência: Bevox deduplica por `seq` (monotônico por execution)
- SLA: <50ms p95; harness aborta com timeout 5s e continua
- Ordering: chunks chegam **out-of-order** sob rede ruim; consumidor deve reordenar por `seq`

- [ ] **Step 2: Diagrama de sequência**

```
Bevox → BullMQ → Harness
                  │
                  ├── stream-chunk { token "Olá" }     → Bevox
                  ├── stream-chunk { token ", como" }  → Bevox
                  ├── stream-chunk { tool_call_start } → Bevox
                  ├── stream-chunk { tool_result }     → Bevox
                  ├── stream-chunk { token " sua..." } → Bevox
                  ├── stream-chunk { done }            → Bevox
                  └── complete (final)                 → Bevox
```

- [ ] **Step 3: Coordenar com time backend Bevox**

Criar issue/spike no projeto bevox-backend listando o contrato. **Não habilitar `STREAM_ENABLED=true` em prod até endpoint existir.**

- [ ] **Step 4: Commit**

```bash
git commit -m "docs(stream): callback contract and bevox coordination"
```

---

### Task 10: Smoke E2E e validação final

- [ ] **Step 1: Servidor mock de stream-chunk em test**

```typescript
// tests/integration/streaming-e2e.test.ts
const received: StreamChunk[] = [];
const mockServer = http.createServer((req, res) => {
  if (req.url?.includes("/stream-chunk")) {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => { received.push(JSON.parse(body)); res.writeHead(204).end(); });
  }
});
await new Promise<void>((r) => mockServer.listen(0, r));
const port = (mockServer.address() as AddressInfo).port;

// Enfileirar execução com stream: true
// Verificar:
// - received.length > 5 (tokens + done)
// - received[0].type === "engine_strategy" ou "token"
// - received[received.length-1].type === "done"
// - seq monotônico
```

- [ ] **Step 2: Verificar localmente**

```bash
npm run lint
npm run typecheck
npm test -- streaming
npm run build
```

- [ ] **Step 3: Smoke manual**

Com `STREAM_ENABLED=true` e endpoint mock local:
1. Enfileira execução de surface agent (ex: scheduler)
2. Observar logs: `stream.chunk.sent` com seq incremental
3. Verificar payload do mock — tokens chegando antes do `complete`

- [ ] **Step 4: PR**

```bash
git push origin HEAD:sprint-c-2-streaming
gh pr create --title "Sprint C.2: Streaming Responses" --body "$(cat docs/superpowers/plans/2026-05-14-sprint-c-2-streaming.md | head -40)"
```

---

## Definition of Done

- ✅ 3 adapters (OpenAI, Anthropic, Gemini) implementam `completeStream()`
- ✅ SSE parser testado com fixtures reais
- ✅ `StreamBuffer` agrega por tempo/tokens com flush manual em `done`
- ✅ `StreamPublisher` envia chunks com seq monotônico e backpressure-safe
- ✅ ReAct e PlanExecute emitem `reasoning_step` opcionalmente
- ✅ Feature flag `STREAM_ENABLED=false` por default — comportamento atual idêntico quando off
- ✅ E2E test verifica chunks chegando ao mock callback antes do complete
- ✅ Contrato documentado em `docs/streaming/README.md` + coordenação com Bevox backend
- ✅ Cobertura ≥ 75% em `src/integration/llm/streaming/*` e `src/runtime/stream-publisher.ts`
- ✅ `complete()` clássico inalterado — `npm test -- llm` verde

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Bevox não suporta `/stream-chunk` ainda | Feature flag `STREAM_ENABLED=false` por default; coordenar antes de prod; Task 9 cria spike no backend |
| Latência de callback reverte o ganho de TTFB | Buffer agrega 100ms/50 tokens — reduz N callbacks; `keep-alive` reusa conexão; timeout curto (5s) não bloqueia inferência |
| Tool_call args chegam parcialmente — JSON parse falha em chunk intermediário | `StreamPublisher` acumula por `toolCallId` e tenta parse incrementalmente; só emite `tool_call_complete` quando válido |
| Retry/circuit breaker conflitam com stream | Decisão explícita: ambos pass-through no stream (documentado em ADR); stream é "fire-and-forget" — falha emite `error` chunk e propaga |
| Chunks chegam fora de ordem ao Bevox | `seq` monotônico no payload; Bevox reordena no consumer (documentar em contrato) |
| Provider stream API muda formato (OpenAI já alterou em 2024) | Parsers isolados em `streaming/{provider}-stream.ts`; fixtures versionadas em `tests/fixtures/sse/`; quebra fica contida |
| AbortSignal não suportado em alguns ambientes | Polyfill via `node-abort-controller` se Node < 18 (atual é 20+ → OK) |
| Memory leak se `pump` é abandonado sem `done` | `pump` em try/finally garante `buffer.flush` + cleanup `toolArgBuffers`; AbortSignal honrado |
| `streamCallback` opcional confunde maintainers (engine emite ou não?) | Type explícito + comentário no engine.ts; testes cobrem ambos caminhos (com/sem callback) |
| Stream bypassa rate guard pesado de tokens | RateGuard cobra 1 hit por chamada (não por token); aceitar como limitação V1; tracking de tokens reais fica para sprint de billing |
| Conflito merge com Sprint C.1 em execution-handler | Sequência recomendada: C.1 → C.2. C.2 adiciona apenas `if (streamEnabled)` em pontos isolados; rebase limpo |

---

## Correções Pós-Review (2026-05-14)

Aplicadas após review automatizado. Consultar [INDEX](./2026-05-14-INDEX-bevox-2.0-sprints.md#correções-pós-review-2026-05-14) para decisões globais.

### Critical
- **Task 0 (nova)** — Husky no-verify (G.6) + Hook modular (G.5) prerequisito.
- **Task 4, rate-guard inexistente** — `rate-guard-decorator.ts` não existe no repo. Promover F5 (LLM gateway robustness) para **hard dependency** se necessário OU cortar Task 4 Step 2 e fazer rate guard em sprint separado. Confirmar status de F5 antes de codar.
- **Task 4, nome de arquivo** — `circuit-breaker.ts` (não `circuit-breaker-decorator.ts`). Corrigir paths em Files Touched e Task 4.
- **DoD, backward compat snapshot** — Adicionar Task explícita: gravar fixture de request/response atual de `complete()` ANTES de mudanças nos adapters, rodar diff snapshot test após cada commit. Sem isso, "complete() inalterado" não é verificável.
- **Task 9, gate Bevox backend** — Critério mensurável: `STREAM_ENABLED=true` só após (i) endpoint `/stream-chunk` Bevox responder 204 em smoke test, (ii) ADR assinada por backend owner. Adicionar checklist concreto.
- **Task 6, StreamPublisher.seq race (G.13)** — Cada `emit()` captura `const mySeq = this.seq++` ANTES de qualquer `await`. Adicionar teste de stress concorrente. Race entre tool_call_delta e reasoning_step pode trocar ordem.
- **Task 6, tool_call_complete name** — Adicionar `toolNameByCallId: Map<string,string>` populado no `tool_call_start`, consultado no `tool_call_complete`. Sem isso, Bevox UI recebe ferramenta sem nome.
- **Task 7, `ReasoningEngine.step` (G.12)** — NÃO modificar assinatura da interface. Passar via `AgentExecutionContext.streamCallback?` (opcional). 5 engines não precisam mudar implementação.

### Important
- **ADR concreto** — Criar `docs/adr/00X-streaming-bypasses-retry-circuit.md` (não só "documentar em ADR" vago).
- **Stream errors no breaker** — Emitir manualmente `breaker.recordFailure()` no catch do `completeStream` quando erro HTTP 5xx/429. Sem isso, provider degradado não trip breaker para chamadas síncronas.
- **StreamBuffer try/finally** — Garantir flush em erro abrupto em `pump()` Task 6. Adicionar teste cobrindo.
- **Feature flag matriz** — Documentar em DoD: global=false → ignora payload; global=true + payload=false → no stream; global=true + payload=true → stream. AND, não OR.
- **JSON parcial parse error counter** — Após N (default 200) deltas sem sucesso parsing tool_call args, emit `error` chunk e abort. Hoje silencia.
- **Backpressure warn log rate-limited** — Usar sample/dedupe (1 log a cada 100 falhas) ou Bevox down gera 50 warns/s.
- **AbortSignal propagation** — `sendStreamChunk` deve receber `signal` externo (não criar próprio). Cancelamento global propaga.

### Nitpick
- Direct engine final text — Publisher expõe `getFullText()` para reconstrução.
- Gemini `?alt=sse` — Confirmar com smoke test antes de implementar parser (API Google mudou recentemente).
- Remover polyfill `node-abort-controller` (Node 20+ tem nativo).
- PR command Windows-compat (`--body-file`).
- Adicionar `tests/fixtures/sse/` a Files Touched > Create.
