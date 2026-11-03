# Sprint A.1: LLM Recorder/Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans para implementar este plano task-by-task. Steps usam checkbox (`- [ ]`) syntax para tracking.

**Goal:** Implementar um sistema de gravação determinística de chamadas LLM (request + response + timing) para uso em testes, inspirado em `@mastra/_llm-recorder`. O sistema é exposto como **decorator** que envolve o `LLMGateway` atual (compondo com `RetryDecorator` + `CircuitBreakerDecorator` já existentes) e suporta três modos: `record` (passthrough + grava cassette), `replay` (lê cassette, falha se request não bate) e `passthrough` (default em prod — no-op).

**Architecture:** O `LLMRecorder` implementa a interface `LLMGateway` (mesmo contrato público — `complete(options) → LLMResponse`) e é composto **acima** do `RetryDecorator`, na borda externa da pipeline. Cassettes são arquivos JSON em `tests/fixtures/cassettes/<scope>/<name>.cassette.json`, indexados por SHA-256 do request canonicalizado (`messages` + `tools` + `model` + `temperature` + `responseSchema` + `maxTokens`). No modo `record`, qualquer hit não encontrado dispara a chamada real, grava a resposta e devolve. No modo `replay`, miss = erro determinístico (`CassetteMissError`). Sanitização de secrets é aplicada antes da escrita (`OPENAI_API_KEY`, headers `Authorization`, qualquer chave casando regex sensível).

**Tech Stack:** Node 20 (crypto nativo para SHA-256), `fs/promises`, Zod 4 (validar shape de cassette ao carregar), Pino 9, Vitest 4. Sem nova dependência runtime — tudo built-in.

---

## Dependencies

- **Hard:** Nenhuma. Sprint A.1 roda isolado — o decorator só precisa de `LLMGateway` (interface pública estável).
- **Soft:** Sprint F4 (Observability) já entregue — o recorder pode emitir spans `llm.recorder.record` / `llm.recorder.replay` se OTEL estiver ativo, mas degrada limpo se `getActiveSpan()` retornar `undefined`.
- **Blocks (esta sprint libera):**
  - Sprint A.2 (Evals/Scorers) — usa cassettes para golden set determinístico
  - Sprint B (testes E2E de reasoning engines) — depende de replay para CI sem custo
  - Qualquer suite que queira testar `ReAct`/`Plan&Execute`/`ReWOO` ponta-a-ponta sem gastar tokens reais
- **Conflitos potenciais:** Sprint F5 (retry/circuit refinement) também toca `src/integration/llm-gateway.ts` (factory `createLLMGateway`).

## Files Touched

### Create
- `src/integration/llm/recorder.ts` — decorator `LLMRecorder implements LLMGateway`
- `src/integration/llm/replay.ts` — `LLMReplayer implements LLMGateway` (modo estrito)
- `src/integration/llm/cassette-store.ts` — leitura/escrita de cassettes em disco
- `src/integration/llm/cassette-schema.ts` — schema Zod do formato de cassette
- `src/integration/llm/request-hasher.ts` — canonicalização + SHA-256
- `src/integration/llm/cassette-sanitizer.ts` — remove secrets antes de gravar
- `src/integration/llm/errors.ts` — `CassetteMissError`, `CassetteValidationError`
- `tests/fixtures/cassettes/.gitkeep`
- `tests/fixtures/cassettes/example/hello-world.cassette.json` (referência humana)
- `tests/helpers/cassette-fixture.ts` — helper `useCassette(name)` para testes
- `tests/unit/integration/llm/recorder.test.ts`
- `tests/unit/integration/llm/replay.test.ts`
- `tests/unit/integration/llm/request-hasher.test.ts`
- `tests/unit/integration/llm/cassette-sanitizer.test.ts`
- `docs/architecture/llm-recorder.md`

### Modify
- ⚠️ `src/integration/llm-gateway.ts` — compor `LLMRecorder`/`LLMReplayer` no topo quando `LLM_RECORDER_MODE !== 'passthrough'`
- `src/config/env.ts` — adicionar 4 env vars OTEL-style
- `package.json` — script `npm run cassettes:list` (opcional, ajuda dev)
- `.gitignore` — garantir que cassettes em `tmp/` não vão para commit
- `README.md` — secção "Testing > LLM Cassettes"

### High-conflict files
- ⚠️ `src/integration/llm-gateway.ts` — Sprint F5 (retry/circuit) e qualquer mudança futura no factory `createLLMGateway`. Resolver com merge ordenado: Sprint A.1 entra ANTES de qualquer F5 follow-up.

## Estimated Effort
3-5 dias de trabalho focado (1 dev) — ~24-32 horas. Estrutura simples, mas cobertura de testes precisa ser exaustiva porque cassettes são contrato.

---

## Tasks

### Task 1: Definir formato de cassette e schema Zod

**Files:**
- Create: `src/integration/llm/cassette-schema.ts`
- Create: `tests/fixtures/cassettes/example/hello-world.cassette.json`

- [ ] **Step 1: Modelar shape do cassette**

Cada cassette tem versão de schema, metadata, e um map `entries` onde cada chave é o hash do request e o valor é o response completo + timing.

```typescript
// src/integration/llm/cassette-schema.ts
import { z } from "zod";

export const cassetteSchemaVersion = "1" as const;

export const cassetteEntrySchema = z.object({
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request_summary: z.object({
    model: z.string(),
    provider: z.string().optional(),
    temperature: z.number().optional(),
    n_messages: z.number().int().nonneg(),
    n_tools: z.number().int().nonneg().optional(),
    has_response_schema: z.boolean(),
  }),
  response: z.object({
    content: z.string().nullable(),
    tool_calls: z.array(z.object({
      id: z.string(),
      name: z.string(),
      arguments: z.record(z.unknown()),
    })),
    usage: z.object({
      input_tokens: z.number().int().nonneg(),
      output_tokens: z.number().int().nonneg(),
      total_tokens: z.number().int().nonneg(),
    }),
    model: z.string(),
    provider: z.string(),
    latency_ms: z.number().int().nonneg(),
  }),
  recorded_at: z.string().datetime(),
});

export const cassetteFileSchema = z.object({
  schema_version: z.literal(cassetteSchemaVersion),
  name: z.string(),
  created_at: z.string().datetime(),
  entries: z.array(cassetteEntrySchema),
});

export type CassetteFile = z.infer<typeof cassetteFileSchema>;
export type CassetteEntry = z.infer<typeof cassetteEntrySchema>;
```

- [ ] **Step 2: Criar fixture de referência**

`tests/fixtures/cassettes/example/hello-world.cassette.json` com **1 entry real** (pode ser fabricada) para documentar o formato a humanos lendo o repo.

- [ ] **Step 3: Teste de validação do schema**

```typescript
it("validates a well-formed cassette", () => {
  const raw = JSON.parse(fs.readFileSync(".../hello-world.cassette.json", "utf-8"));
  expect(() => cassetteFileSchema.parse(raw)).not.toThrow();
});

it("rejects cassette with wrong schema_version", () => {
  expect(() => cassetteFileSchema.parse({ ...raw, schema_version: "2" })).toThrow();
});
```

- [ ] **Step 4: Commit**

```bash
git add src/integration/llm/cassette-schema.ts tests/fixtures/cassettes/
git commit -m "feat(llm-recorder): add cassette schema and reference fixture"
```

---

### Task 2: Request hasher (canonicalização + SHA-256)

**Files:**
- Create: `src/integration/llm/request-hasher.ts`
- Create: `tests/unit/integration/llm/request-hasher.test.ts`

⚠ Canonicalização é o ponto onde determinismo é ganho ou perdido. Ordem das chaves em JSON, normalização de whitespace em strings de tool, e tratamento de `undefined` vs ausente precisam ser explícitos.

- [ ] **Step 1: Função `canonicalizeRequest(options: LLMRequestOptions, model: string)`**

```typescript
import { createHash } from "node:crypto";
import type { LLMRequestOptions } from "../llm-gateway";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function canonicalizeRequest(options: LLMRequestOptions, model: string): string {
  return stableStringify({
    model,
    messages: options.messages,
    tools: options.tools ?? [],
    response_schema: options.responseSchema ?? null,
    temperature: options.temperature ?? null,
    max_tokens: options.maxTokens ?? null,
  });
}

export function hashRequest(options: LLMRequestOptions, model: string): string {
  return createHash("sha256").update(canonicalizeRequest(options, model)).digest("hex");
}
```

- [ ] **Step 2: Testes de estabilidade**

```typescript
it("produces same hash regardless of key order in messages", () => {
  const a = hashRequest({ messages: [{ role: "user", content: "hi" }] } as any, "gpt-4o-mini");
  // Hand-craft a re-ordered equivalent
  const reorderedMsg = JSON.parse('{"content":"hi","role":"user"}');
  const b = hashRequest({ messages: [reorderedMsg] } as any, "gpt-4o-mini");
  expect(a).toBe(b);
});

it("differs when temperature changes", () => {
  const a = hashRequest({ messages: [], temperature: 0 } as any, "gpt-4o-mini");
  const b = hashRequest({ messages: [], temperature: 0.7 } as any, "gpt-4o-mini");
  expect(a).not.toBe(b);
});

it("treats undefined and absent equally", () => {
  const a = hashRequest({ messages: [], temperature: undefined } as any, "gpt-4o-mini");
  const b = hashRequest({ messages: [] } as any, "gpt-4o-mini");
  expect(a).toBe(b);
});
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(llm-recorder): add deterministic request hasher"
```

---

### Task 3: Cassette sanitizer (secret scrubbing)

**Files:**
- Create: `src/integration/llm/cassette-sanitizer.ts`
- Create: `tests/unit/integration/llm/cassette-sanitizer.test.ts`

⚠ Cassettes vão para git. Qualquer leak de API key, JWT, ou PII de mensagem real é incidente. Sanitizer roda **antes da escrita** e tem allowlist de campos a varrer.

- [ ] **Step 1: Regras de redacção**

```typescript
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[a-zA-Z0-9]{20,}/g, "sk-REDACTED"],
  [/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer REDACTED"],
  [/AIza[0-9A-Za-z\-_]{35}/g, "AIza-REDACTED"],
  [/eyJ[A-Za-z0-9._\-]+\.eyJ[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]*/g, "JWT-REDACTED"],
];

export function sanitizeString(s: string): string {
  let out = s;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function sanitizeEntry<T>(entry: T): T {
  return JSON.parse(JSON.stringify(entry, (_k, v) =>
    typeof v === "string" ? sanitizeString(v) : v
  ));
}
```

- [ ] **Step 2: Teste com payloads que parecem reais**

```typescript
it("redacts OpenAI API key in response content", () => {
  const e = { response: { content: "Use sk-abc123def456ghi789jkl012 to auth" } };
  expect(sanitizeEntry(e).response.content).toContain("sk-REDACTED");
});

it("redacts JWT in tool_calls arguments", () => {
  const e = { response: { tool_calls: [{ arguments: { token: "eyJhbG.eyJzdWI.sig" } }] } };
  expect(sanitizeEntry(e).response.tool_calls[0].arguments.token).toBe("JWT-REDACTED");
});
```

- [ ] **Step 3: Adicionar nota explícita no doc**

⚠ Sanitizer é defesa em profundidade, NÃO substitui revisão humana. Toda cassette nova deve passar por code review.

- [ ] **Step 4: Commit**

---

### Task 4: Cassette store (filesystem I/O)

**Files:**
- Create: `src/integration/llm/cassette-store.ts`
- Create: `src/integration/llm/errors.ts`

- [ ] **Step 1: Errors**

```typescript
export class CassetteMissError extends Error {
  constructor(public readonly cassetteName: string, public readonly requestHash: string) {
    super(`Cassette miss: ${cassetteName} has no entry for hash ${requestHash.slice(0, 12)}…`);
    this.name = "CassetteMissError";
  }
}

export class CassetteValidationError extends Error {
  constructor(public readonly path: string, public readonly zodIssues: unknown) {
    super(`Invalid cassette at ${path}`);
    this.name = "CassetteValidationError";
  }
}
```

- [ ] **Step 2: Store**

```typescript
export class CassetteStore {
  private cache = new Map<string, CassetteFile>();

  constructor(private rootDir: string) {}

  async load(name: string): Promise<CassetteFile | null> {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const filePath = path.join(this.rootDir, `${name}.cassette.json`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = cassetteFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new CassetteValidationError(filePath, parsed.error.issues);
      this.cache.set(name, parsed.data);
      return parsed.data;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async append(name: string, entry: CassetteEntry): Promise<void> {
    const existing = (await this.load(name)) ?? {
      schema_version: "1" as const,
      name,
      created_at: new Date().toISOString(),
      entries: [],
    };
    // Replace entry with same hash if exists (re-record scenario)
    const filtered = existing.entries.filter((e) => e.request_hash !== entry.request_hash);
    filtered.push(sanitizeEntry(entry));
    const updated: CassetteFile = { ...existing, entries: filtered };
    this.cache.set(name, updated);
    const filePath = path.join(this.rootDir, `${name}.cassette.json`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  }

  find(cassette: CassetteFile, requestHash: string): CassetteEntry | undefined {
    return cassette.entries.find((e) => e.request_hash === requestHash);
  }
}
```

- [ ] **Step 3: Testes com tmpdir**

```typescript
it("appends entries idempotently", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cassette-"));
  const store = new CassetteStore(dir);
  await store.append("test/sample", entry1);
  await store.append("test/sample", entry1); // same hash, dedup
  const file = await store.load("test/sample");
  expect(file?.entries).toHaveLength(1);
});
```

- [ ] **Step 4: Commit**

---

### Task 5: `LLMRecorder` decorator (modo `record`)

**Files:**
- Create: `src/integration/llm/recorder.ts`
- Create: `tests/unit/integration/llm/recorder.test.ts`

- [ ] **Step 1: Implementar decorator**

```typescript
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway";
import { CassetteStore } from "./cassette-store";
import { hashRequest } from "./request-hasher";

export class LLMRecorder implements LLMGateway {
  constructor(
    private readonly wrapped: LLMGateway,
    private readonly store: CassetteStore,
    private readonly cassetteName: string,
    private readonly model: string,
    private readonly logger?: { info(obj: object, msg: string): void },
  ) {}

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const hash = hashRequest(options, this.model);
    const cassette = await this.store.load(this.cassetteName);

    // Re-record on miss; passthrough on hit (idempotent)
    if (cassette) {
      const found = this.store.find(cassette, hash);
      if (found) {
        this.logger?.info({ hash: hash.slice(0, 12) }, "cassette hit (record-mode passthrough)");
        return found.response;
      }
    }

    const response = await this.wrapped.complete(options);
    await this.store.append(this.cassetteName, {
      request_hash: hash,
      request_summary: {
        model: this.model,
        temperature: options.temperature,
        n_messages: options.messages.length,
        n_tools: options.tools?.length,
        has_response_schema: options.responseSchema !== undefined,
      },
      response,
      recorded_at: new Date().toISOString(),
    });
    this.logger?.info({ hash: hash.slice(0, 12) }, "cassette miss → recorded");
    return response;
  }
}
```

- [ ] **Step 2: Testes — mock do `wrapped` gateway**

```typescript
it("records a miss and returns underlying response", async () => {
  const wrapped = { complete: vi.fn().mockResolvedValue(fakeResponse) };
  const recorder = new LLMRecorder(wrapped, store, "test", "gpt-4o-mini");
  const res = await recorder.complete(opts);
  expect(res).toEqual(fakeResponse);
  expect(wrapped.complete).toHaveBeenCalledOnce();
  const cassette = await store.load("test");
  expect(cassette?.entries).toHaveLength(1);
});

it("does not call wrapped on hit", async () => {
  // Pre-populate cassette
  await store.append("test", existingEntry);
  const wrapped = { complete: vi.fn() };
  const recorder = new LLMRecorder(wrapped, store, "test", "gpt-4o-mini");
  await recorder.complete(matchingOpts);
  expect(wrapped.complete).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Commit**

---

### Task 6: `LLMReplayer` decorator (modo `replay`)

**Files:**
- Create: `src/integration/llm/replay.ts`
- Create: `tests/unit/integration/llm/replay.test.ts`

⚠ Modo replay é **estrito**: miss = `CassetteMissError`. Não há fallback, propositadamente, para garantir testes determinísticos.

- [ ] **Step 1: Implementar**

```typescript
export class LLMReplayer implements LLMGateway {
  constructor(
    private readonly store: CassetteStore,
    private readonly cassetteName: string,
    private readonly model: string,
  ) {}

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const hash = hashRequest(options, this.model);
    const cassette = await this.store.load(this.cassetteName);
    if (!cassette) {
      throw new CassetteMissError(this.cassetteName, hash);
    }
    const entry = this.store.find(cassette, hash);
    if (!entry) {
      throw new CassetteMissError(this.cassetteName, hash);
    }
    return entry.response;
  }
}
```

- [ ] **Step 2: Testes**

```typescript
it("throws CassetteMissError when cassette absent", async () => {
  const replayer = new LLMReplayer(emptyStore, "missing", "gpt-4o-mini");
  await expect(replayer.complete(opts)).rejects.toBeInstanceOf(CassetteMissError);
});

it("throws CassetteMissError when entry hash not found", async () => {
  const replayer = new LLMReplayer(populatedStore, "test", "gpt-4o-mini");
  await expect(replayer.complete(differentOpts)).rejects.toThrow(/no entry for hash/);
});

it("returns recorded response on hit", async () => {
  const replayer = new LLMReplayer(populatedStore, "test", "gpt-4o-mini");
  const res = await replayer.complete(matchingOpts);
  expect(res).toEqual(recordedResponse);
});
```

- [ ] **Step 3: Commit**

---

### Task 7: Env vars + integração no factory

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/integration/llm-gateway.ts`

⚠ Realidade: `createLLMGateway()` (linhas 100-141) compõe `RetryDecorator(CircuitBreaker(adapter))`. O recorder vai **na borda externa**, envolvendo o `RetryDecorator`. Isto é proposital: testes precisam ver o comportamento composto, incluindo retries.

- [ ] **Step 1: Env vars em `src/config/env.ts`**

```typescript
LLM_RECORDER_MODE: z.enum(["record", "replay", "passthrough"]).default("passthrough"),
LLM_RECORDER_CASSETTE_DIR: z.string().default("tests/fixtures/cassettes"),
LLM_RECORDER_CASSETTE_NAME: z.string().optional(),
LLM_RECORDER_REQUIRE_NAME: z.coerce.boolean().default(true),
```

`LLM_RECORDER_REQUIRE_NAME=true` em CI: se `LLM_RECORDER_MODE !== passthrough` mas não há `LLM_RECORDER_CASSETTE_NAME`, lança erro no bootstrap. Evita "gravei tudo num cassette default por engano".

- [ ] **Step 2: Modificar `createLLMGateway`**

```typescript
export function createLLMGateway(agentConfig: { default_model?: string }): LLMGateway {
  // ... lógica existente até retornar gateway composto
  const composed = new RetryDecorator(
    new CircuitBreakerDecorator(adapter, ...),
    ...
  );

  if (env.LLM_RECORDER_MODE === "passthrough") return composed;

  const cassetteName = env.LLM_RECORDER_CASSETTE_NAME;
  if (!cassetteName && env.LLM_RECORDER_REQUIRE_NAME) {
    throw new Error("LLM_RECORDER_MODE != passthrough requires LLM_RECORDER_CASSETTE_NAME");
  }
  const store = new CassetteStore(env.LLM_RECORDER_CASSETTE_DIR);

  if (env.LLM_RECORDER_MODE === "record") {
    return new LLMRecorder(composed, store, cassetteName!, model, logger);
  }
  // replay
  return new LLMReplayer(store, cassetteName!, model);
}
```

⚠ No modo `replay`, `composed` (adapter real) é descartado — `LLMReplayer` nem precisa de upstream. Isto é correto: replay não fala com nenhum provider.

- [ ] **Step 3: Smoke test manual**

```bash
LLM_RECORDER_MODE=record LLM_RECORDER_CASSETTE_NAME=manual/smoke npm run dev
# Disparar 1 job de teste → verificar tests/fixtures/cassettes/manual/smoke.cassette.json criado
LLM_RECORDER_MODE=replay LLM_RECORDER_CASSETTE_NAME=manual/smoke npm run dev
# Mesmo input → não deve chamar OpenAI; latência interna deve ser <5ms
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(llm-recorder): wire recorder/replayer into LLMGateway factory"
```

---

### Task 8: Helper de teste `useCassette`

**Files:**
- Create: `tests/helpers/cassette-fixture.ts`

- [ ] **Step 1: Implementar helper de Vitest**

```typescript
import { afterAll, beforeAll } from "vitest";
import { LLMReplayer } from "../../src/integration/llm/replay";
import { LLMRecorder } from "../../src/integration/llm/recorder";
import { CassetteStore } from "../../src/integration/llm/cassette-store";

export function useCassette(name: string, model = "gpt-4o-mini") {
  const mode = process.env.LLM_RECORDER_MODE ?? "replay";
  const store = new CassetteStore(
    process.env.LLM_RECORDER_CASSETTE_DIR ?? "tests/fixtures/cassettes",
  );

  return {
    gateway: () => {
      if (mode === "replay") return new LLMReplayer(store, name, model);
      if (mode === "record") {
        // Caller must inject real upstream
        throw new Error("record mode requires explicit upstream — use LLMRecorder directly");
      }
      throw new Error(`Unsupported mode for useCassette: ${mode}`);
    },
  };
}
```

- [ ] **Step 2: Exemplo de uso em teste**

```typescript
import { useCassette } from "../helpers/cassette-fixture";

describe("ReAct engine with cassette", () => {
  const cassette = useCassette("reasoning/react-happy-path");

  it("completes a 3-step plan", async () => {
    const engine = new ReActEngine(cassette.gateway());
    const result = await engine.run(somePlan);
    expect(result.steps).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Commit**

---

### Task 9: Documentação

**Files:**
- Create: `docs/architecture/llm-recorder.md`
- Modify: `README.md`

- [ ] **Step 1: Doc com as seguintes seções**

1. Quando usar (testes determinísticos, golden sets, demos sem custo)
2. Três modos e quando cada um se aplica
3. Como gravar uma cassette nova (env vars + comando)
4. Como adicionar cassette a teste existente (`useCassette`)
5. **Política de revisão**: toda PR que adiciona/altera cassette precisa de review humano + checagem manual de secrets
6. Como invalidar/regravar (`rm cassette.json` + rodar em `record`)
7. Versionamento (`schema_version`) e estratégia de migração futura

- [ ] **Step 2: README — secção "Testing > LLM Cassettes"** com link para doc completa

- [ ] **Step 3: Commit**

---

### Task 10: Validação final e PR

- [ ] **Step 1: Suíte completa local**

```bash
npm run lint
npm run typecheck
npm test
```

Expected: tudo verde. Cobertura de `src/integration/llm/recorder.ts`, `replay.ts`, `request-hasher.ts`, `cassette-sanitizer.ts` ≥ 90%.

- [ ] **Step 2: Smoke E2E**

Rodar `npm run dev` em modo `passthrough` (default) e confirmar **zero impacto** no comportamento existente — handler de execução não vê diferença.

- [ ] **Step 3: PR**

```bash
git push origin HEAD:sprint-a-1-llm-recorder
gh pr create --title "Sprint A.1: LLM Recorder/Replay" \
  --body "$(cat docs/superpowers/plans/2026-05-14-sprint-a-1-llm-recorder.md | head -40)"
```

- [ ] **Step 4: Aguardar CI + review**

---

## Definition of Done

- ✅ `LLM_RECORDER_MODE=passthrough` (default) → zero diff de comportamento vs main
- ✅ `LLM_RECORDER_MODE=record` grava cassettes válidas (Zod schema passa) com secrets redacted
- ✅ `LLM_RECORDER_MODE=replay` serve responses em <5ms, falha determinística em miss
- ✅ Hash do request é estável: mesma intenção lógica → mesmo hash, independente de ordem de chaves
- ✅ Sanitizer remove `sk-…`, `AIza…`, `Bearer …`, JWTs antes da escrita
- ✅ Cobertura de testes ≥ 90% nos novos arquivos
- ✅ Documentação publicada em `docs/architecture/llm-recorder.md`
- ✅ Helper `useCassette()` funcional em pelo menos 1 teste real (smoke do ReAct engine)

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Drift de cassettes quando provider muda formato de response | `schema_version` permite migration explícita; regravar todas em batch se Zod parse falhar |
| Secret leak em cassette commitada | Sanitizer + review obrigatório + scanner periódico (`git secrets` ou similar em CI) |
| Hash colide entre requests semanticamente diferentes | SHA-256 com canonicalização determinística → probabilidade de colisão desprezível na escala do projeto |
| Cassettes ficam enormes (10MB+) e poluem repo | Política: 1 cassette por suite de teste, max ~50 entries; CI alerta se arquivo > 500KB |
| Modo `record` por engano em CI gasta tokens | `LLM_RECORDER_REQUIRE_NAME=true` força nome explícito; CI roda sempre `LLM_RECORDER_MODE=replay` (env do workflow) |
| Sanitizer remove conteúdo legítimo que casa regex de secret | Regex são suficientemente específicas (prefixos `sk-`, `AIza`, etc.); testes de não-regressão garantem que strings benignas passam |
| Tempo de carregamento de cassettes grandes degrada testes | Cache em memória (`CassetteStore.cache`) + lazy load por suite |
| Conflito com Sprint F5 em `llm-gateway.ts` | Mergear A.1 primeiro (recorder está na borda externa, F5 mexe no interior — refactor de retry/circuit não afeta recorder) |

---

## Correções Pós-Review (2026-05-14)

Aplicadas após review automatizado. Consultar [INDEX](./2026-05-14-INDEX-bevox-2.0-sprints.md#correções-pós-review-2026-05-14) para decisões globais (G.1 a G.13).

### Critical
- **Task 0 (nova)** — Adicionar nota global: commits neste sprint usam `git commit --no-verify` (Husky quebrado no Windows, ver G.6). Rodar `npm run lint && npm test` manualmente antes de cada commit.
- **Task 1, schema** — `n_tools` e `temperature` no `request_summary` devem ser `default(0)` / `default(undefined)` consistente. Normalizar em `recorder.ts` com `options.tools?.length ?? 0` para evitar `undefined` em fixtures.
- **Task 5, recorder.ts** — `LLMRecorder` deve `implements LLMDecorator` (de `src/integration/llm/internal.ts`) com `readonly wrapped: LLMGateway` exposto. Consistente com `RetryDecorator` e `CircuitBreakerDecorator` existentes. `LLMReplayer` continua implementando só `LLMGateway` (não tem upstream).
- **Task 7, Step 2** — Snippet usa `model` sem declarar escopo. Esclarecer: `const { provider, model } = resolveProvider(agentConfig.default_model)` já existe em `createLLMGateway` (linha ~102). Replayer é instanciado depois dessa linha.
- **Task 7, Step 3** — Smoke command correto: `npm run docker:up && npm run smoke:enqueue` (não "disparar 1 job de teste").
- **Cassettes `latency_ms`** — Replay retorna `latency_ms` da gravação original. Testes que medem latência real devem usar clock injetável. Documentar em DoD e em `docs/architecture/llm-recorder.md`.

### Important
- **CassetteStore singleton** — Em modo replay, instanciar `CassetteStore` module-level em vez de criar por execução. Adicionar `let storeSingleton: CassetteStore | undefined` em `recorder.ts`.
- **Sanitizer comentário** — Reformular Architecture parágrafo 2: API keys nunca alcançam `LLMResponse`; sanitizer é defesa em profundidade contra PII em `content`/tool args, não anti-key-leak.
- **Zod v4 datetime** — Confirmar API: `z.iso.datetime({ offset: true })` em Zod 4 (não `z.string().datetime()` deprecated).
- **`.gitignore` Modify removed** — Cassettes vivem em `tests/fixtures/cassettes/`, já coberto. Remover `.gitignore` da seção Modify.
- **Helper de teste** — Documentar fluxo de gravação no README: `LLM_RECORDER_MODE=record LLM_RECORDER_CASSETTE_NAME=foo npm run test:unit -- caminho/teste.test.ts`.

### Nitpick
- PR command (Task 10 Step 3) — Trocar `gh pr create --body "$(cat ... | head -40)"` por `gh pr create --body-file` (Windows-compat).
- Goal — Adicionar link para `@mastra/_llm-recorder` como referência.
- Adicionar `.gitattributes` com `*.cassette.json text eol=lf` para evitar CRLF flap em diffs.
