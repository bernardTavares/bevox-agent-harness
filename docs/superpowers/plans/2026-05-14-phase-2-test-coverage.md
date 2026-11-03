# Phase 2: Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Subir cobertura de testes de ~12% para ≥70%, com estrutura `tests/{unit,integration,e2e,fakes}/` inspirada no Hermes, e configurar Vitest com coverage threshold + paralelismo.

**Architecture:** Pirâmide de testes clássica — unitários (mockam I/O), integração (Postgres + Redis reais via testcontainers), e2e (BullMQ in-memory + LLM fake + Calendar fake). Fakes reutilizáveis em `tests/fakes/`. Vitest com `pool: 'threads'` para paralelismo equivalente ao `pytest-xdist`.

**Tech Stack:** Vitest 4, @vitest/coverage-v8, testcontainers-node, msw (mock HTTP), ioredis-mock (fallback rápido).

---

## Dependencies

- **Hard:** Nenhuma (testes podem ser escritos sem CI rodar). Idealmente Fase 1 já mergeada para validação automática.
- **Soft:** Fase 1 (CI roda os testes automaticamente).
- **Blocks:** Nada diretamente, mas testes de Fase 4/5 dependem dos fakes criados aqui.

## Files Touched

### Create
- `vitest.config.ts`
- `tests/fakes/redis.fake.ts`
- `tests/fakes/postgres.fake.ts`
- `tests/fakes/llm-gateway.fake.ts`
- `tests/fakes/calendar-client.fake.ts`
- `tests/fakes/bullmq.fake.ts`
- `tests/fakes/index.ts`
- `tests/unit/runtime/execution-handler.test.ts`
- `tests/unit/runtime/agent-router.test.ts`
- `tests/unit/reasoning/direct.test.ts` (testa `src/reasoning/direct.ts`)
- `tests/unit/reasoning/react.test.ts` (testa `src/reasoning/react.ts`)
- `tests/unit/reasoning/plan-execute.test.ts`
- `tests/unit/reasoning/rewoo.test.ts`
- `tests/unit/reasoning/reflexion.test.ts`
- `tests/unit/reasoning/strategy-router.test.ts`
- `tests/unit/reasoning/step-evaluator.test.ts`
- `tests/unit/permissions/evaluator.test.ts`
- `tests/unit/permissions/permission-context.test.ts`
- `tests/unit/tools/messaging/send-message.test.ts` (testa `*.tool.ts`)
- `tests/unit/tools/messaging/request-human.test.ts`
- `tests/unit/tools/calendar/read-calendar.test.ts`
- `tests/unit/tools/calendar/list-appointments.test.ts`
- `tests/unit/tools/calendar/create-appointment.test.ts`
- `tests/unit/tools/calendar/cancel-appointment.test.ts`
- `tests/unit/tools/calendar/reschedule-appointment.test.ts`
- `tests/unit/tools/calendar/waitlist-add.test.ts`
- `tests/unit/tools/memory/read-profile.test.ts`
- `tests/unit/tools/memory/write-profile.test.ts`
- `tests/unit/tools/memory/write-fact.test.ts`
- `tests/unit/tools/knowledge/search-faq.test.ts`
- `tests/unit/memory/contact-profile.repository.test.ts` (testa `src/memory/contact-profile.repository.ts` — sem subdir)
- `tests/unit/memory/contact-facts.repository.test.ts`
- `tests/unit/agents/pipeline/message-analyzer.test.ts` (testa `src/agents/pipeline/message-analyzer.agent.ts`)
- `tests/unit/agents/pipeline/memory-extractor.test.ts`
- `tests/unit/agents/surface/scheduler.test.ts`
- `tests/unit/session/session-store.test.ts`
- `tests/integration/handler.integration.test.ts`
- `tests/integration/memory.integration.test.ts`
- `tests/e2e/full-pipeline.e2e.test.ts`
- `tests/setup.ts`
- `tests/README.md`

### Modify
- `package.json` (deps: vitest, @vitest/coverage-v8, testcontainers, msw; scripts: `test:unit`, `test:integration`, `test:e2e`, `test:coverage`)
- `.gitignore` (`coverage/`)

### High-conflict files
- ⚠️ `package.json` — conflita com Fase 1, 4, 5

## Estimated Effort
2-3 semanas (~60-80 horas).

---

## Tasks

### Task 1: Configurar Vitest e estrutura `tests/`

**Files:**
- Create: `vitest.config.ts`, `tests/setup.ts`, `tests/README.md`
- Modify: `package.json`

- [ ] **Step 1: Instalar deps**

```bash
npm install --save-dev vitest@4 @vitest/coverage-v8 @vitest/ui \
  testcontainers @testcontainers/postgresql @testcontainers/redis \
  ioredis-mock msw
```

⚠ **Verificar antes:** rodar `grep -rn "export.*LLMGateway\|export.*CalendarClient" src/` para confirmar nomes/shapes das interfaces antes de escrever fakes. As fakes precisam `implements LLMGateway` etc. — divergência quebra build.

- [ ] **Step 2: Criar `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/index.ts",
        "src/types/**",
        "src/**/*.d.ts",
      ],
      // Thresholds iniciais (codebase parte de ~12% de cobertura).
      // Ratchet-up para 70/70/65/70 em PR de seguimento após primeiro green.
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 55,
        statements: 60,
      },
    },
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 3: Criar `tests/setup.ts`**

```typescript
import { afterEach, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

process.env.NODE_ENV = "test";
process.env.HARNESS_LOG_LEVEL = "silent";
```

- [ ] **Step 4: Adicionar scripts em `package.json`**

```json
"test": "vitest run",
"test:watch": "vitest",
"test:unit": "vitest run tests/unit",
"test:integration": "vitest run tests/integration",
"test:e2e": "vitest run tests/e2e",
"test:coverage": "vitest run --coverage",
"test:ui": "vitest --ui"
```

- [ ] **Step 5: Criar `tests/README.md`**

```markdown
# Tests

Estrutura inspirada em Hermes Agent.

## Layout

- `tests/unit/` — unitários, mockam I/O. Rápidos (<100ms cada).
- `tests/integration/` — usam Postgres+Redis reais via testcontainers. Mais lentos.
- `tests/e2e/` — fluxo BullMQ → handler → callback completo com fakes.
- `tests/fakes/` — fakes reutilizáveis (LLM, Calendar, Redis, etc).

## Scripts

- `npm test` — tudo
- `npm run test:unit` — só unitários (rápido)
- `npm run test:integration` — precisa Docker
- `npm run test:coverage` — com coverage report
```

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts tests/setup.ts tests/README.md package.json package-lock.json
git commit -m "test: configure vitest with coverage thresholds and tests/ structure"
```

---

### Task 2: Criar fakes reutilizáveis

**Files:**
- Create: `tests/fakes/llm-gateway.fake.ts`
- Create: `tests/fakes/calendar-client.fake.ts`
- Create: `tests/fakes/redis.fake.ts`
- Create: `tests/fakes/bullmq.fake.ts`
- Create: `tests/fakes/repositories.fake.ts` (ContactProfile + ContactFacts fakes em memória)
- Create: `tests/fakes/llm-client.fake.ts` (para `LlmClient` em `src/agents/execution-context.ts` — interface diferente do LLMGateway)
- Create: `tests/fakes/index.ts`

- [ ] **Step 1: `tests/fakes/llm-gateway.fake.ts`**

```typescript
// Casa com a interface REAL em src/integration/llm-gateway.ts
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../../src/integration/llm-gateway";

export interface FakeLLMOptions {
  responses?: Array<LLMResponse | Error>;
  defaultResponse?: LLMResponse;
}

export class FakeLLMGateway implements LLMGateway {
  public calls: LLMRequestOptions[] = [];
  private queue: Array<LLMResponse | Error>;
  private fallback: LLMResponse;

  constructor(opts: FakeLLMOptions = {}) {
    this.queue = opts.responses ?? [];
    this.fallback = opts.defaultResponse ?? {
      content: '{"output":"ok"}',
      tool_calls: [],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      model: "fake",
      provider: "fake",
      latency_ms: 1,
    };
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    this.calls.push(options);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return next ?? this.fallback;
  }

  reset() {
    this.calls = [];
    this.queue = [];
  }
}
```

- [ ] **Step 2: `tests/fakes/calendar-client.fake.ts`**

⚠ `src/integration/calendar-client.ts` exporta **funções standalone** (`checkHealth`, `getAvailability`, `createAppointment`, etc.) — não há interface `CalendarClient` ou tipo `Appointment` exportado. Estratégia: usar `vi.mock()` por teste, OU criar helper de mocking.

```typescript
// Helper para mockar o módulo inteiro em testes
import { vi } from "vitest";

export function mockCalendarClient(overrides: Partial<Record<string, unknown>> = {}) {
  return vi.mock("../../src/integration/calendar-client", () => ({
    checkHealth: vi.fn().mockResolvedValue({ ok: true }),
    getAvailability: vi.fn().mockResolvedValue([]),
    createAppointment: vi.fn().mockResolvedValue({ id: "appt_1", status: "scheduled" }),
    cancelAppointment: vi.fn().mockResolvedValue({ id: "appt_1", status: "cancelled" }),
    rescheduleAppointment: vi.fn().mockResolvedValue({ id: "appt_1", status: "scheduled" }),
    listAppointments: vi.fn().mockResolvedValue([]),
    addToWaitlist: vi.fn().mockResolvedValue({ id: "wait_1" }),
    ...overrides,
  }));
}
```

Em testes individuais, importar e chamar antes do import da SUT, ou usar `vi.doMock()`. **Antes** de Task 2 Step 2, fazer `grep -n "^export" src/integration/calendar-client.ts` para confirmar funções exatas exportadas.

- [ ] **Step 3: `tests/fakes/redis.fake.ts`**

```typescript
import RedisMock from "ioredis-mock";
import type Redis from "ioredis";

export function createFakeRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}
```

- [ ] **Step 4: `tests/fakes/bullmq.fake.ts`**

```typescript
import type { Job } from "bullmq";

export function makeFakeJob<T>(data: T, id = "job_1"): Job<T> {
  return {
    id,
    data,
    name: "execution.dispatch",
    timestamp: Date.now(),
    attemptsMade: 0,
    opts: {},
    updateProgress: async () => {},
    log: async () => 0,
    moveToCompleted: async () => {},
    moveToFailed: async () => {},
  } as unknown as Job<T>;
}
```

- [ ] **Step 5: `tests/fakes/index.ts`**

```typescript
export * from "./llm-gateway.fake";
export * from "./llm-client.fake";
export * from "./calendar-client.fake";
export * from "./redis.fake";
export * from "./bullmq.fake";
export * from "./repositories.fake";
```

- [ ] **Step 6: Commit**

```bash
git add tests/fakes/
git commit -m "test: add reusable fakes (LLM, calendar, redis, bullmq)"
```

---

### Task 3: Testes unitários — Reasoning Engines

Para cada um dos 5 engines, escrever testes seguindo TDD. Apresentado um exemplo, repetir o padrão.

**Files:**
- Create: `tests/unit/reasoning/direct-engine.test.ts`

- [ ] **Step 1: Escrever teste de `DirectEngine.plan()`**

⚠ **Antes — discovery obrigatória:**

1. Ler `src/reasoning/engine.ts` para tipos `ReasoningEngine`, `Plan`, `PlanStep`, `Observation`, `AgentResponse`, `ToolExecutor`, `TraceCallback`.
2. Ler `src/reasoning/direct.ts` para constructor real (`DirectEngine`, `DirectEngineConfig`) e assinaturas dos 5 métodos.
3. Reusar `FakeLLMGateway.defaultResponse` (já tem shape correto) em vez de inline-construir `LLMResponse` malformado.

O exemplo abaixo é **ilustrativo da estrutura** (3 testes-âncora). As assinaturas precisas só são conhecidas após a discovery — **não copiar 1:1 sem confirmar**.

```typescript
import { describe, it, expect } from "vitest";
import { DirectEngine } from "../../../src/reasoning/direct";
import { FakeLLMGateway } from "../../fakes";

describe("DirectEngine", () => {
  it("plan() retorna estrutura conforme ReasoningEngine.Plan (verificar shape em engine.ts)", async () => {
    const engine = new DirectEngine(/* config conforme DirectEngineConfig */);
    const plan = await engine.plan(/* args conforme assinatura real */);
    expect(plan).toBeDefined();
  });

  it("step() consome LLM exatamente 1 vez", async () => {
    const llm = new FakeLLMGateway();  // defaultResponse cobre shape correto
    const engine = new DirectEngine(/* config com llm injetado */);
    // ... act + assert llm.calls.length === 1
  });

  it("shouldContinue() retorna false após 1 step (DirectEngine não itera)", () => {
    // ...
  });
});
```

- [ ] **Step 2: Rodar — esperado falhar se interface não casar; ajustar imports**

```bash
npm run test:unit -- direct-engine
```

- [ ] **Step 3: Corrigir até passar. Commit**

```bash
git add tests/unit/reasoning/direct-engine.test.ts
git commit -m "test: unit tests for DirectEngine"
```

- [ ] **Step 4: Repetir padrão para os outros engines (arquivos: `react.ts`, `plan-execute.ts`, `rewoo.ts`, `reflexion.ts`)**

Para cada engine cobrir:
- `plan()` retorna estrutura esperada
- `step()` chama LLM e processa retorno
- `observe()` atualiza estado/scratchpad
- `shouldContinue()` respeita thresholds
- `synthesize()` produz output final
- Casos de erro: LLM falha, JSON malformado, threshold atingido

**Para `StrategyRouter` (não é um ReasoningEngine — é roteador de escalation):** cobrir:
- Seleção de engine baseado em `agent.reasoning.default`
- Escalation: stepThreshold → plan-execute
- Escalation: parallelThreshold → rewoo
- Wrap automático com Reflexion em caso de falha
- Default fallback quando config ausente

Para `ReWOOEngine`, **adicionar teste específico** de cycle detection:

```typescript
it("plan rejects DAG with cycles", async () => {
  const llm = new FakeLLMGateway({
    defaultResponse: {
      content: JSON.stringify({
        steps: [
          { id: "a", deps: ["b"] },
          { id: "b", deps: ["a"] },
        ],
      }),
      usage: {} as any,
      model: "fake",
    },
  });
  const engine = new ReWOOEngine({ llm });  // import de '../../../src/reasoning/rewoo'
  await expect(engine.plan({ input: "x" } as any)).rejects.toThrow(/cycle/i);
});
```

Para `ReflexionWrapper`, testar:
- maxRetries respeitado
- failure analysis chamada após falha
- success direto não chama analysis

- [ ] **Step 5: Commits incrementais — um por engine**

---

### Task 4: Testes unitários — Permissions Evaluator

**Files:**
- Create: `tests/unit/permissions/evaluator.test.ts`

⚠ **Antes:** ler `src/permissions/evaluator.ts` e `src/permissions/types.ts` para confirmar shapes reais. Sumário:
- Assinatura: `evaluatePermission(tool: ToolDefinition, agent: AgentDefinition, context: PermissionContext)` (3 args posicionais)
- `PermissionResult` discriminated union: `{ granted: true; tool }` ou `{ granted: false; tool; reason: PermissionDenialReason }`
- `PermissionDenialReason` enum: `'AGENT_STATIC_DENIED' | 'AGENT_TYPE_MISMATCH' | 'EXECUTION_CONTEXT_DENIED' | 'TOOL_UNAVAILABLE'`
- `PermissionContext`: `{ agentName, agentType, accountId, conversationKey, unavailableTools, accountDeniedTools, inboxId? }`
- `AgentDefinition.permissions`: `{ denied: string[], required: string[] }` (nested, não flat no agent)
- **Camada 3 (agent-type) usa SETS hardcoded em evaluator.ts:** `PIPELINE_ONLY_TOOLS = {'write-profile','write-fact'}` e `SURFACE_ONLY_TOOLS = {'send-message','request-human'}`. NÃO usa `tool.agentType`.

- [ ] **Step 1: Escrever testes contra interface real**

```typescript
import { describe, it, expect } from "vitest";
import { evaluatePermission } from "../../../src/permissions/evaluator";
import type { ToolDefinition } from "../../../src/tools/types";
import type { AgentDefinition } from "../../../src/agents/types";
import type { PermissionContext } from "../../../src/permissions/types";

const baseAgent: AgentDefinition = {
  name: "test-agent",
  type: "surface",
  description: "",
  reasoning: { default: "react" } as any,
  permissions: { required: [], denied: [], optional: [] },
} as any;

const baseTool = (name: string): ToolDefinition => ({
  name,
  description: "x",
  category: "calendar",
  agentType: "both",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ success: true }),
});

const baseContext: PermissionContext = {
  agentName: "test-agent",
  agentType: "surface",
  accountId: 1,
  conversationKey: "k",
  unavailableTools: [],
  accountDeniedTools: [],
};

describe("evaluatePermission", () => {
  describe("Layer 1: agent static denied", () => {
    it("denies tool in agent.permissions.denied", () => {
      const agent = { ...baseAgent, permissions: { ...baseAgent.permissions, denied: ["create-appointment"] } };
      const result = evaluatePermission(baseTool("create-appointment"), agent, baseContext);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe("AGENT_STATIC_DENIED");
    });
  });

  describe("Layer 1b: hardcoded type-only tools", () => {
    it("denies pipeline-only tool for surface agent (write-profile)", () => {
      const result = evaluatePermission(baseTool("write-profile"), baseAgent /* surface */, baseContext);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe("AGENT_TYPE_MISMATCH");
    });

    it("denies surface-only tool for pipeline agent (send-message)", () => {
      const agent = { ...baseAgent, type: "pipeline" as const };
      const ctx = { ...baseContext, agentType: "pipeline" as const };
      const result = evaluatePermission(baseTool("send-message"), agent, ctx);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe("AGENT_TYPE_MISMATCH");
    });
  });

  describe("Layer 2: execution context", () => {
    it("denies tool in context.unavailableTools", () => {
      const ctx = { ...baseContext, unavailableTools: ["search-faq"] };
      const result = evaluatePermission(baseTool("search-faq"), baseAgent, ctx);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe("TOOL_UNAVAILABLE");
    });

    it("denies tool in context.accountDeniedTools", () => {
      const ctx = { ...baseContext, accountDeniedTools: ["create-appointment"] };
      const result = evaluatePermission(baseTool("create-appointment"), baseAgent, ctx);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe("EXECUTION_CONTEXT_DENIED");
    });
  });

  describe("Allow path", () => {
    it("grants tool not denied anywhere", () => {
      const result = evaluatePermission(baseTool("read-calendar"), baseAgent, baseContext);
      expect(result.granted).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Rodar, corrigir, commit**

```bash
git add tests/unit/permissions/evaluator.test.ts
git commit -m "test: unit tests for permission evaluator (3 layers)"
```

---

### Task 5: Testes unitários — Tools (13 arquivos)

Para cada tool em `src/tools/`, criar teste cobrindo: schema de parâmetros válido, execute happy path, validação de erro.

**Files:** `tests/unit/tools/<category>/<tool>.test.ts`

- [ ] **Step 1: Criar template — `send-message.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { sendMessageTool } from "../../../../src/tools/messaging/send-message.tool";
import * as bevoxCallback from "../../../../src/integration/bevox-callback";

describe("sendMessageTool", () => {
  it("returns success and calls bevoxCallback.sendComplete", async () => {
    const sendComplete = vi.spyOn(bevoxCallback, "sendComplete").mockResolvedValue(undefined as any);
    const result = await sendMessageTool.execute(
      { message: "Olá!" },
      { executionId: "e1", accountId: 1, executionToken: "tok" } as any,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ sent: true });
    expect(sendComplete).toHaveBeenCalled();
  });

  it("returns INVALID_PARAMS when message missing", async () => {
    const result = await sendMessageTool.execute({} as any, { executionId: "e1" } as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });
});
```

⚠ Notas reais sobre `ToolResult`: shape é `{ success, data?, error?, errorCode?, detail? }`. **Não há campos `stop` ou `output`.** Stop signals são detectados por **nome** da tool no loop de raciocínio.

- [ ] **Step 2: Repetir para cada tool, commits incrementais por categoria**

Tools a cobrir (arquivos reais, todos `*.tool.ts`):
- `messaging/`: `send-message.tool.ts`, `request-human.tool.ts`
- `calendar/`: `read-calendar.tool.ts`, `list-appointments.tool.ts`, `create-appointment.tool.ts`, `cancel-appointment.tool.ts`, `reschedule-appointment.tool.ts`, `waitlist-add.tool.ts`
- `memory/`: `read-profile.tool.ts`, `write-profile.tool.ts`, `write-fact.tool.ts`
- `knowledge/`: `search-faq.tool.ts`

Para tools que tocam serviços externos (calendar), injetar `FakeCalendarClient`. Para tools de memória, injetar repos fake (ou usar postgres real em integração — preferir fake aqui).

---

### Task 6: Testes unitários — Memory Repositories

**Files:**
- Create: `tests/unit/memory/contact-profile.repository.test.ts`
- Create: `tests/unit/memory/contact-facts.repository.test.ts`

- [ ] **Step 1: Escrever testes mockando `pg.Client`**

```typescript
import { describe, it, expect, vi } from "vitest";
// Arquivo real: src/memory/contact-profile.repository.ts (sem subdir 'repositories/')
import { ContactProfileRepository } from "../../../src/memory/contact-profile.repository";

describe("ContactProfileRepository", () => {
  it("update builds parameterized UPDATE without SQL injection", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const client = { query } as any;
    const repo = new ContactProfileRepository(client);
    await repo.update("contact_1", { name: "'; DROP TABLE--", phone: "+55..." });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/^UPDATE contact_profiles SET/);
    expect(sql).not.toContain("DROP");
    expect(params).toContain("'; DROP TABLE--");
  });

  // ... outros casos: findById, create, transaction handling
});
```

- [ ] **Step 2: Commit por repo**

---

### Task 7: Testes unitários — Runtime (Handler + Router)

**Files:**
- Create: `tests/unit/runtime/agent-router.test.ts`
- Create: `tests/unit/runtime/execution-handler.test.ts`

- [ ] **Step 1: AgentRouter — testes simples**

```typescript
describe("AgentRouter", () => {
  it("resolves agent by intent", () => {
    const router = new AgentRouter({
      scheduling: "scheduler",
    });
    expect(router.resolve("scheduling")).toBe("scheduler");
  });

  it("falls back to request-human on unknown intent", () => {
    const router = new AgentRouter({});
    expect(router.resolve("unknown")).toBe("request-human");
  });
});
```

- [ ] **Step 2: ExecutionHandler — testes com todos fakes injetados**

Cobrir:
- Payload inválido → erro Zod
- Deduplicação Redis funciona (segundo job é skip)
- Pipeline + surface chamados na ordem
- Timeout cancela com erro adequado
- Callback complete enviado em sucesso
- Callback failed enviado em erro
- Synthesize chamado com resultado correto

```typescript
it("dedupes execution_id within TTL window", async () => {
  const redis = createFakeRedis();
  const handler = new ExecutionHandler({ redis, /* ...fakes */ });
  const job = makeFakeJob({ execution_id: "e1", /*...*/ });
  await handler.handle(job);
  const result = await handler.handle(job);
  expect(result.skipped).toBe(true);
});
```

- [ ] **Step 3: Commit**

---

### Task 8: Testes de integração (Postgres + Redis reais)

**Files:**
- Create: `tests/integration/memory.integration.test.ts`
- Create: `tests/integration/handler.integration.test.ts`

- [ ] **Step 1: Helper para subir containers + aplicar migrations**

```typescript
// tests/integration/_helpers.ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { Client } from "pg";

export async function setupInfra() {
  const pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  const redis = await new RedisContainer("redis:7-alpine").start();

  // Aplicar migrations em ordem
  const migrationsDir = join(__dirname, "../../migrations");
  const files = (await readdir(migrationsDir)).filter(f => f.endsWith(".sql")).sort();
  const client = new Client({ connectionString: pg.getConnectionUri() });
  await client.connect();
  for (const f of files) {
    const sql = await readFile(join(migrationsDir, f), "utf8");
    // Extrai apenas a seção UP (entre marcadores)
    const upMatch = sql.match(/-- UP[\s\S]*?(?=-- DOWN|$)/);
    await client.query(upMatch ? upMatch[0] : sql);
  }
  await client.end();

  return {
    databaseUrl: pg.getConnectionUri(),
    redisUrl: redis.getConnectionUri(),
    teardown: async () => { await pg.stop(); await redis.stop(); },
  };
}
```

- [ ] **Step 2: `memory.integration.test.ts`** — testa repositories contra Postgres real

- [ ] **Step 3: `handler.integration.test.ts`** — testa o handler completo (sem mock de DB/Redis, com LLM e Calendar fakes)

- [ ] **Step 4: Marcar como `describe.concurrent` desabilitado e usar tag**

Adicionar em `package.json`:
```json
"test:integration": "vitest run tests/integration --testTimeout=60000"
```

- [ ] **Step 5: Commit**

---

### Task 9: Teste E2E (fluxo completo)

**Files:**
- Create: `tests/e2e/full-pipeline.e2e.test.ts`

- [ ] **Step 1: Simular um job BullMQ chegando, processar até callback**

```typescript
it("processa job BullMQ end-to-end com agendamento bem-sucedido", async () => {
  // 1. setup: containers + fakes (LLM responde script pre-definido)
  // 2. enfileira job com mensagem "quero marcar consulta amanhã 14h"
  // 3. handler processa
  // 4. assert: callback /complete chamado com appointment criado
  // 5. assert: Calendar fake recebeu create
  // 6. assert: contact_profile foi atualizado
});
```

- [ ] **Step 2: Commit**

---

### Task 10: Atingir threshold de cobertura

- [ ] **Step 1: Rodar com coverage**

```bash
npm run test:coverage
```

- [ ] **Step 2: Identificar arquivos abaixo do threshold**

- [ ] **Step 3: Adicionar testes incrementais até atingir 60/60/55/60 inicial**

- [ ] **Step 4: Commit final**

```bash
git commit -m "test: reach initial coverage thresholds (60/60/55/60)"
```

- [ ] **Step 5: PR de seguimento (separado) para subir thresholds**

Após Wave 1 mergeada e estável, abrir PR `test: ratchet coverage to 70/70/65/70` que aumenta os números em `vitest.config.ts`.

---

## Definition of Done

- ✅ `npm run test:coverage` passa com thresholds iniciais 60/60/55/60 (subir para 70/70/65/70 em PR de seguimento)
- ✅ Estrutura `tests/{unit,integration,e2e,fakes}/` populada
- ✅ Fakes reutilizáveis para LLM, Calendar, Redis, BullMQ
- ✅ Todos os 5 reasoning engines com testes unitários
- ✅ Todas as 12 tools com testes unitários (arquivos reais: 12 `*.tool.ts` em `src/tools/`)
- ✅ Permissions evaluator com testes das 3 camadas
- ✅ Pelo menos 1 teste de integração com Postgres+Redis reais
- ✅ Pelo menos 1 teste E2E do fluxo completo

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Testcontainers lento no Windows | Usar Docker Desktop com WSL2; opcionalmente skip em dev local com `it.skipIf(process.platform === 'win32')` |
| Fakes divergem da interface real | Cada fake `implements` a interface; mudança quebra compilação |
| Cobertura artificial (testes ruins) | Code review focado em assert quality; usar mutation testing (Stryker) em seguimento |
| Threshold muito agressivo bloqueia merge | Começar com threshold menor (60%) e subir gradualmente em PRs separados |
