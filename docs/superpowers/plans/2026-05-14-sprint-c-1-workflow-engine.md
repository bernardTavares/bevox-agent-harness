# Sprint C.1: Workflow Engine (declarativo, suspend/resume) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Adicionar um **workflow engine declarativo** ao harness como **alternativa complementar** (não substituto) aos reasoning engines existentes (`direct`, `react`, `plan-execute`, `rewoo`, `reflexion`). Inspirado em `mastra/core/workflows`: DSL fluente com `.then()/.branch()/.parallel()/.suspend()/.resume()`. Útil para fluxos **conhecidos e repetitivos** (ex.: "verificar disponibilidade → reservar slot → cobrar → confirmar") onde o raciocínio emergente do ReAct é overkill e custoso.

**⚠ Convivência obrigatória.** Reasoning engines permanecem intactos. `AgentDefinition` ganha um campo opcional `workflow?: string`; se presente, o `agent-router` despacha para o workflow em vez de instanciar engine. Ambos os caminhos compartilham `AgentExecutionContext`, `ToolRegistry` e `PermissionEvaluator`.

**Architecture:** Novo módulo `src/workflow/` com builder fluente (`createWorkflow`, `createStep`), executor com state machine, store de estado em Postgres (suspend/resume durável) e subscriber Redis pub/sub para resume assíncrono. Cada step executa dentro do mesmo `withSpan()` que reasoning engines (Phase 4 observability). Workflow execution é tratada como uma "strategy" adicional no `AgentResponse.strategy: 'workflow'`.

**Tech Stack:** TypeScript, `pg` (state persistence), `ioredis` (pub/sub), Zod (validação de payload de step), OTEL spans (Phase 4 quando disponível).

---

## Dependencies

- **Hard:** Nenhuma. Reasoning engines coexistem; nada precisa ser refatorado para o workflow rodar.
- **Soft:**
  - Phase 4 observability — workflow emite `withSpan('workflow.step.execute', ...)`; sem F4 vira no-op
  - Phase 8 pluggable skills — steps podem invocar skills além de tools
- **Blocks:** Nada externo. Sprint C.2 (streaming) é independente.
- **Conflitos:**
  - `src/runtime/execution-handler.ts` — adicionar ramo "workflow vs reasoning" (low conflict)
  - `src/agents/types.ts` — adicionar campo `workflow?: string` em `AgentDefinition` (low)
  - `src/runtime/agent-router.ts` — roteamento por intent inalterado, mas `resolve()` retorna agora também a "strategy" (workflow vs reasoning)

## Files Touched

### Create
- `src/workflow/types.ts` — `WorkflowDefinition`, `WorkflowStep`, `WorkflowState`, `SuspendSignal`, `StepResult`
- `src/workflow/builder.ts` — `createWorkflow()`, `createStep()`, métodos fluentes `.then()/.branch()/.parallel()/.map()`
- `src/workflow/engine.ts` — executor (state machine), entrypoint `runWorkflow(def, input, context)`
- `src/workflow/state-store.ts` — repo Postgres para `workflow_executions` (insert/load/update/listSuspended)
- `src/workflow/subscriber.ts` — Redis pub/sub para `workflow:resume:{execution_id}`
- `src/workflow/registry.ts` — singleton `WorkflowRegistry` (similar a `AgentRegistry`)
- `src/workflow/examples/book-appointment.ts` — workflow de referência usado em testes
- `src/workflow/resume-handler.ts` — entrypoint para webhooks / timeout cleanup
- `migrations/005_workflow_state.sql` — schema da tabela
- `tests/unit/workflow/builder.test.ts`
- `tests/unit/workflow/engine.test.ts`
- `tests/unit/workflow/state-store.test.ts`
- `tests/integration/workflow-suspend-resume.test.ts`

### Modify
- `src/agents/types.ts` — adicionar `workflow?: string` em `AgentDefinition`
- `src/runtime/execution-handler.ts` — após resolução de agent, checar `agent.workflow` e despachar para `runWorkflow` se presente
- `src/reasoning/engine.ts` — estender union `strategy: 'direct'|'react'|'plan-execute'|'rewoo'|'workflow'`
- `src/bootstrap/03-register-agents.ts` (ou equivalente) — adicionar **stage 3.5** `register-workflows` populando o registry
- `src/config/env.ts` — `WORKFLOW_DEFAULT_TIMEOUT_MS`, `WORKFLOW_SUSPEND_TTL_MS`
- `README.md` — seção "Workflows vs Reasoning"

### NÃO modificar
- `src/reasoning/*` — engines intactos
- `src/tools/*` — workflows reusam tools existentes via `ToolRegistry`
- Interface pública do `LLMGateway`

### High-conflict files
- ⚠️ `src/runtime/execution-handler.ts` — também tocado por Sprint C.2 (streaming). Coordenação: C.1 primeiro, C.2 depois (ramo workflow precisa estar estável antes de streaming hookar nos eventos).
- ⚠️ `src/agents/types.ts` — qualquer alteração em `AgentDefinition` conflita

## Estimated Effort
3-4 semanas (~80-100 horas).

---

## Tasks

### Task 1: Migration + state store

**Files:**
- Create: `migrations/005_workflow_state.sql`
- Create: `src/workflow/state-store.ts`
- Create: `tests/unit/workflow/state-store.test.ts`

- [ ] **Step 1: Criar migration**

```sql
-- migrations/005_workflow_state.sql
CREATE TABLE workflow_executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id    UUID NOT NULL,                  -- correlaciona com Bevox execution_id
  workflow_id     TEXT NOT NULL,
  workflow_version INTEGER NOT NULL DEFAULT 1,
  account_id      BIGINT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running','suspended','completed','failed','cancelled')),
  state           JSONB NOT NULL,                 -- step outputs, cursor, branch decisions
  current_step    TEXT,
  suspend_token   TEXT UNIQUE,                    -- token p/ resume via webhook
  suspend_reason  TEXT,
  resume_event    TEXT,                           -- ex: "callback:payment.confirmed"
  resume_payload  JSONB,
  timeout_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  error           JSONB
);

CREATE INDEX idx_wf_exec_status         ON workflow_executions(status);
CREATE INDEX idx_wf_exec_suspend_token  ON workflow_executions(suspend_token) WHERE suspend_token IS NOT NULL;
CREATE INDEX idx_wf_exec_timeout        ON workflow_executions(timeout_at) WHERE status = 'suspended';
CREATE INDEX idx_wf_exec_execution_id   ON workflow_executions(execution_id);
```

- [ ] **Step 2: Implementar `WorkflowStateStore`**

```typescript
// src/workflow/state-store.ts
export interface WorkflowStateRow {
  id: string;
  executionId: string;
  workflowId: string;
  workflowVersion: number;
  accountId: number;
  status: "running" | "suspended" | "completed" | "failed" | "cancelled";
  state: WorkflowState;
  currentStep: string | null;
  suspendToken: string | null;
  resumeEvent: string | null;
  resumePayload: unknown;
  timeoutAt: Date | null;
}

export class WorkflowStateStore {
  constructor(private readonly pool: Pool) {}

  async create(row: Omit<WorkflowStateRow, "id">): Promise<string> { /* INSERT RETURNING id */ }
  async load(id: string): Promise<WorkflowStateRow | null> { /* SELECT */ }
  async loadBySuspendToken(token: string): Promise<WorkflowStateRow | null> { /* SELECT */ }
  async update(id: string, patch: Partial<WorkflowStateRow>): Promise<void> { /* UPDATE */ }
  async listExpired(now: Date, limit: number): Promise<WorkflowStateRow[]> { /* WHERE timeout_at <= now AND status='suspended' */ }
}
```

⚠ Validar `state: jsonb` com Zod antes de persistir (next task define schema).

- [ ] **Step 3: Testes — happy path, suspend token unicidade, list expired**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(workflow): postgres state store with suspend/resume support"
```

---

### Task 2: Types e Zod schemas

**Files:**
- Create: `src/workflow/types.ts`

- [ ] **Step 1: Definir tipos núcleo**

```typescript
// src/workflow/types.ts
import type { AgentExecutionContext } from "../agents/execution-context";

export type WorkflowStatus = "running" | "suspended" | "completed" | "failed" | "cancelled";

export interface StepContext extends AgentExecutionContext {
  /** Outputs anteriores indexados por step id. */
  readonly stepOutputs: Record<string, unknown>;
  /** Suspende o workflow. Lançar via `ctx.suspend(...)` ou retornar `{ suspend: true, ... }`. */
  suspend(signal: SuspendSignal): never;
}

export interface SuspendSignal {
  /** Evento ao qual o workflow resume. Ex: "callback:payment.confirmed" ou "timeout". */
  resumeOn: string;
  /** TTL em ms — após isso, status vira `failed` com reason `timeout`. */
  timeoutMs: number;
  /** Token externo para o webhook resumir. Gerado pelo engine se omitido. */
  suspendToken?: string;
  /** Payload de contexto para o webhook validar (ex: payment_intent_id). */
  metadata?: Record<string, unknown>;
}

export interface StepResult<T = unknown> {
  output: T;
  durationMs: number;
}

export type StepFn<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  ctx: StepContext,
) => Promise<TOutput | { suspend: SuspendSignal }>;

export interface WorkflowStep {
  id: string;
  kind: "step" | "branch" | "parallel" | "map";
  execute: StepFn;
  /** Para branch: predicado que escolhe `truthy` ou `falsy`. */
  predicate?: (input: unknown, ctx: StepContext) => boolean | Promise<boolean>;
  branches?: { truthy: WorkflowStep[]; falsy: WorkflowStep[] };
  /** Para parallel: steps que rodam concorrentemente. */
  parallel?: WorkflowStep[];
  retry?: { maxAttempts: number; baseDelayMs: number };
  timeoutMs?: number;
}

export interface WorkflowDefinition {
  id: string;            // ex: "book-appointment"
  version: number;       // bump sempre que step shapes mudam
  description: string;
  steps: WorkflowStep[];
  inputSchema?: unknown; // Zod schema (validado no entry)
}

export interface WorkflowState {
  cursor: number;        // índice do step atual em `steps`
  stepOutputs: Record<string, unknown>;
  branchTrail: Array<{ stepId: string; branch: "truthy" | "falsy" }>;
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(workflow): core type definitions"
```

---

### Task 3: Builder DSL

**Files:**
- Create: `src/workflow/builder.ts`
- Create: `tests/unit/workflow/builder.test.ts`

- [ ] **Step 1: Implementar `createStep` e `createWorkflow`**

```typescript
// src/workflow/builder.ts
export function createStep<TInput, TOutput>(
  id: string,
  fn: StepFn<TInput, TOutput>,
  opts: { retry?: WorkflowStep["retry"]; timeoutMs?: number } = {},
): WorkflowStep {
  return { id, kind: "step", execute: fn as StepFn, retry: opts.retry, timeoutMs: opts.timeoutMs };
}

export class WorkflowBuilder {
  private steps: WorkflowStep[] = [];

  constructor(private readonly id: string, private readonly version = 1) {}

  step(s: WorkflowStep): this { this.steps.push(s); return this; }

  then(s: WorkflowStep): this { return this.step(s); }

  branch(
    id: string,
    predicate: (input: unknown, ctx: StepContext) => boolean | Promise<boolean>,
    truthy: WorkflowStep[],
    falsy: WorkflowStep[] = [],
  ): this {
    this.steps.push({ id, kind: "branch", execute: async () => null, predicate, branches: { truthy, falsy } });
    return this;
  }

  parallel(id: string, steps: WorkflowStep[]): this {
    this.steps.push({ id, kind: "parallel", execute: async () => null, parallel: steps });
    return this;
  }

  build(description: string, inputSchema?: unknown): WorkflowDefinition {
    return { id: this.id, version: this.version, description, steps: this.steps, inputSchema };
  }
}

export function createWorkflow(id: string, version = 1) {
  return new WorkflowBuilder(id, version);
}
```

- [ ] **Step 2: Testes — encadeamento, branch, parallel monta árvore correta**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(workflow): fluent builder DSL (then/branch/parallel)"
```

---

### Task 4: Engine executor (state machine síncrona)

**Files:**
- Create: `src/workflow/engine.ts`
- Create: `tests/unit/workflow/engine.test.ts`

- [ ] **Step 1: Executor que percorre `steps` e atualiza `WorkflowState`**

```typescript
// src/workflow/engine.ts
export interface RunWorkflowOptions {
  definition: WorkflowDefinition;
  input: unknown;
  context: AgentExecutionContext;
  store: WorkflowStateStore;
  executionId: string;       // do Bevox
  accountId: number;
}

export interface RunWorkflowResult {
  workflowExecutionId: string;
  status: WorkflowStatus;
  output?: unknown;
  suspend?: SuspendSignal & { token: string };
  error?: string;
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunWorkflowResult> {
  // 1. Valida input com inputSchema (se houver)
  // 2. Cria row em workflow_executions (status: running, state: { cursor: 0, stepOutputs: {} })
  // 3. Loop: itera state.cursor até steps.length
  //    - executeStep(step) — wraps em withSpan('workflow.step.execute', ...)
  //    - se step retorna { suspend }: persistir status='suspended', suspend_token=uuid, retornar
  //    - se step lança erro: aplicar retry policy; após esgotar → status='failed'
  //    - persistir output em state.stepOutputs[step.id], avançar cursor
  // 4. Quando cursor === steps.length: status='completed', retornar output do último step
}

export async function resumeWorkflow(
  store: WorkflowStateStore,
  suspendToken: string,
  resumePayload: unknown,
  context: AgentExecutionContext,
): Promise<RunWorkflowResult> {
  // 1. Carregar row por suspend_token
  // 2. Se status !== 'suspended' → reject ("already-resumed" idempotente)
  // 3. Injeta resumePayload em state.stepOutputs['__resume__']
  // 4. Continua o loop a partir do state.cursor (próximo step)
}
```

- [ ] **Step 2: Implementar `executeStep` por kind**

```typescript
async function executeStep(step: WorkflowStep, input: unknown, ctx: StepContext): Promise<unknown> {
  switch (step.kind) {
    case "step":
      return await withRetry(step.execute, input, ctx, step.retry);
    case "branch": {
      const truthy = await step.predicate!(input, ctx);
      const branchSteps = truthy ? step.branches!.truthy : step.branches!.falsy;
      // Executa branchSteps sequencialmente; output do último é o output do branch
      return executeSequence(branchSteps, input, ctx);
    }
    case "parallel": {
      const outs = await Promise.all(step.parallel!.map((s) => executeStep(s, input, ctx)));
      return outs;
    }
    default:
      throw new Error(`Unknown step kind: ${step.kind}`);
  }
}
```

- [ ] **Step 3: Persistência incremental — após cada step, `store.update` com novo state**

Garante que crash recupere do último checkpoint.

- [ ] **Step 4: Testes**
  - Happy path: 3 steps sequenciais → completed
  - Step lança erro → retry → falha → status='failed' com error preservado
  - Branch truthy/falsy escolhe ramo correto
  - Parallel retorna array ordenado
  - Suspend persiste status='suspended' e suspend_token retornado

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(workflow): executor with state machine and per-step persistence"
```

---

### Task 5: Suspend/Resume — webhook e subscriber Redis

**Files:**
- Create: `src/workflow/subscriber.ts`
- Create: `src/workflow/resume-handler.ts`
- Create: `tests/integration/workflow-suspend-resume.test.ts`

- [ ] **Step 1: Subscriber Redis pub/sub**

```typescript
// src/workflow/subscriber.ts
// Bevox publica em canal "workflow:resume" com payload { suspendToken, payload }
// quando webhook externo chega (ex: Stripe payment.confirmed).
// Subscriber chama resumeWorkflow().

export class WorkflowResumeSubscriber {
  constructor(private readonly redis: Redis, private readonly store: WorkflowStateStore, /*...*/) {}

  async start(): Promise<void> {
    await this.redis.subscribe("workflow:resume");
    this.redis.on("message", async (channel, raw) => {
      if (channel !== "workflow:resume") return;
      const { suspendToken, payload } = JSON.parse(raw) as { suspendToken: string; payload: unknown };
      // Construir contexto mínimo a partir da row persistida (NÃO confiar no payload bruto do webhook)
      const row = await this.store.loadBySuspendToken(suspendToken);
      if (!row) return; // token desconhecido — ignorar (log warn)
      const ctx = await rebuildContext(row); // utilitário
      await resumeWorkflow(this.store, suspendToken, payload, ctx);
    });
  }
}
```

- [ ] **Step 2: HTTP resume handler (opcional v1)**

Se Bevox preferir HTTP direto em vez de Redis pub/sub, expor função `handleResumeHttp(token, payload)` que valida `suspendToken` (constant-time compare) e chama `resumeWorkflow`. Em V1, **somente Redis** — HTTP fica para sprint de seguimento.

- [ ] **Step 3: Cleanup job — expirar workflows zumbis**

```typescript
// src/workflow/cleanup.ts (BullMQ repeat job a cada 5min)
const expired = await store.listExpired(new Date(), 100);
for (const row of expired) {
  await store.update(row.id, { status: "failed", error: { reason: "timeout" } });
}
```

- [ ] **Step 4: Testes de integração — suspend → publish via Redis → resume completa**

Mock externo: o teste publica manualmente em `workflow:resume` simulando webhook.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(workflow): suspend/resume via redis pubsub + timeout cleanup"
```

---

### Task 6: Registry + bootstrap

**Files:**
- Create: `src/workflow/registry.ts`
- Modify: `src/bootstrap/03-register-agents.ts` (renomear para `03-register-agents-and-workflows.ts` ou criar novo stage 3.5)

- [ ] **Step 1: Singleton `WorkflowRegistry`**

```typescript
export class WorkflowRegistry {
  private static instance?: WorkflowRegistry;
  private map = new Map<string, WorkflowDefinition>();
  static getInstance() { return (this.instance ??= new WorkflowRegistry()); }
  register(def: WorkflowDefinition): void {
    const key = `${def.id}@${def.version}`;
    if (this.map.has(key)) throw new Error(`Workflow ${key} already registered`);
    this.map.set(key, def);
    this.map.set(def.id, def); // alias para latest
  }
  get(id: string): WorkflowDefinition | undefined { return this.map.get(id); }
}
```

- [ ] **Step 2: Bootstrap stage**

Registrar workflows conhecidos (a princípio só `book-appointment` da Task 7). Falha em registrar → `process.exit(1)`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(workflow): registry + bootstrap stage"
```

---

### Task 7: Workflow de referência — `book-appointment`

**Files:**
- Create: `src/workflow/examples/book-appointment.ts`

- [ ] **Step 1: Definir usando builder + tools existentes**

```typescript
// src/workflow/examples/book-appointment.ts
import { createWorkflow, createStep } from "../builder";

const checkAvailability = createStep("check-availability", async (input: { slotIso: string }, ctx) => {
  const result = await ctx.toolExecutor("calendar.check-availability", { slot: input.slotIso }, ctx);
  if (!result.available) throw new Error(`Slot ${input.slotIso} not available`);
  return { slotIso: input.slotIso };
});

const reserveSlot = createStep("reserve-slot", async (input, ctx) => {
  return ctx.toolExecutor("calendar.create-appointment", { slot: input.slotIso, hold: true }, ctx);
});

const requestPayment = createStep("request-payment", async (input, ctx) => {
  const session = await ctx.toolExecutor("payment.create-session", { amount: input.price }, ctx);
  // Suspende aguardando webhook
  return ctx.suspend({
    resumeOn: "callback:payment.confirmed",
    timeoutMs: 30 * 60 * 1000,
    metadata: { sessionId: session.id },
  });
});

const confirmBooking = createStep("confirm-booking", async (input, ctx) => {
  return ctx.toolExecutor("calendar.confirm-appointment", { appointmentId: input.appointmentId }, ctx);
});

export const bookAppointmentWorkflow = createWorkflow("book-appointment", 1)
  .step(checkAvailability)
  .then(reserveSlot)
  .branch(
    "needs-payment",
    (input, ctx) => Boolean(ctx.stepOutputs["reserve-slot"]?.requiresPayment),
    [requestPayment, confirmBooking],
    [confirmBooking],
  )
  .build("Workflow para marcar consulta com pagamento opcional");
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(workflow): book-appointment reference workflow"
```

---

### Task 8: Integração com `execution-handler` e `agent-router`

**Files:**
- Modify: `src/agents/types.ts`
- Modify: `src/runtime/execution-handler.ts`
- Modify: `src/runtime/agent-router.ts` (revisar — provavelmente sem mudança)
- Modify: `src/reasoning/engine.ts` (estender union `strategy`)

- [ ] **Step 1: Estender `AgentDefinition`**

```typescript
export interface AgentDefinition {
  name: string;
  type: AgentType;
  description: string;
  reasoning: ReasoningConfig;       // mantido — usado se workflow ausente
  workflow?: string;                // NOVO — se presente, dispatch para workflow engine
  permissions: AgentPermissions;
}
```

- [ ] **Step 2: Atualizar `AgentResponse.strategy`**

```typescript
strategy: "direct" | "react" | "plan-execute" | "rewoo" | "workflow";
```

- [ ] **Step 3: Adicionar ramo workflow no `execution-handler`**

```typescript
// src/runtime/execution-handler.ts (próximo ao loop de reasoning)
const agent = agentRouter.resolve(intent);
if (agent.workflow) {
  const def = WorkflowRegistry.getInstance().get(agent.workflow);
  if (!def) throw new Error(`Workflow ${agent.workflow} not registered`);
  const result = await runWorkflow({
    definition: def,
    input: extractedInput,
    context: executionContext,
    store: workflowStateStore,
    executionId: payload.execution_id,
    accountId: payload.account_id ?? 0,
  });
  // Mapear RunWorkflowResult → AgentResponse para preservar callback contract
  return mapWorkflowResultToAgentResponse(result);
}
// Caso contrário, fluxo de reasoning atual permanece intocado
```

⚠ `mapWorkflowResultToAgentResponse` precisa preencher `strategy: 'workflow'`, `observations: []` (ou serializar `stepOutputs`), `totalSteps: def.steps.length`.

- [ ] **Step 4: Suspend não fecha o callback de complete**

Se workflow suspende, o handler envia `PATCH /executions/{id}/status` com `status: 'suspended'` e **não** envia `complete`. O `complete` é enviado pelo `resumeWorkflow` quando workflow termina (success ou failed).

⚠ Bevox precisa aceitar status `suspended`. Coordenar — em V1, mapear suspended → `running` como fallback se Bevox não suportar.

- [ ] **Step 5: Testes E2E — agent com `workflow: 'book-appointment'` executa workflow; agent sem `workflow` segue reasoning normal**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(workflow): integrate with execution-handler (coexists with reasoning)"
```

---

### Task 9: Retry, timeout e observability

**Files:**
- Modify: `src/workflow/engine.ts`

- [ ] **Step 1: Retry policy por step**

Reusar `withRetry` da Phase 5 (`src/integration/llm/retry-decorator.ts`) — generaliza não-LLM em utilitário compartilhado `src/utils/with-retry.ts`. Cada step com `retry: { maxAttempts, baseDelayMs }` aplica backoff exponencial.

- [ ] **Step 2: Timeout por step**

`Promise.race([step.execute(...), timeout(step.timeoutMs ?? env.WORKFLOW_DEFAULT_TIMEOUT_MS)])`. Timeout vira erro retryable.

- [ ] **Step 3: OTEL spans**

```typescript
await withSpan("workflow.step.execute", { stepId, workflowId, kind }, async () => { /* executeStep */ });
```

Atributos: `workflow.id`, `workflow.version`, `step.id`, `step.kind`, `step.attempt`. Phase 4 cobre tracing infra.

- [ ] **Step 4: Métricas (se Phase 4 expõe counter)**

- `workflow.executions{id, status}` counter
- `workflow.step.duration_ms{step_id}` histogram
- `workflow.suspended_total{workflow_id}` counter

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(workflow): retry, timeout, otel spans per step"
```

---

### Task 10: Versionamento e migração de estado

**Files:**
- Modify: `src/workflow/engine.ts`
- Create: `docs/workflows/versioning.md`

- [ ] **Step 1: Política de versionamento**

- Workflows são imutáveis após registro: qualquer mudança de step shape **exige bump de `version`**
- Workflows suspended carregam `workflow_version` no DB; ao resumir, o engine carrega `WorkflowRegistry.get(`${id}@${version}`)` exato — nunca o latest
- Se versão exata não está mais registrada (deprecation), workflow é marcado `failed` com `error.reason: 'workflow_version_removed'`

- [ ] **Step 2: Documentar**

`docs/workflows/versioning.md` com regras: quando bumpar, como suportar workflows antigos durante deploy gradual, como deprecar.

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(workflow): versioning policy"
```

---

### Task 11: Documentação e exemplo

**Files:**
- Modify: `README.md`
- Create: `docs/workflows/README.md`

- [ ] **Step 1: README do projeto — seção "Workflows vs Reasoning"**

Tabela rápida:

| Caso | Use |
|---|---|
| Fluxo conhecido, determinístico ("marcar → cobrar → confirmar") | Workflow |
| Pergunta aberta, exploratória | Reasoning (ReAct) |
| Múltiplas tools em paralelo, sem dependência | Reasoning (ReWOO) ou Workflow.parallel |
| Precisa suspender e esperar evento externo (webhook) | Workflow (suspend/resume) |
| Resposta direta sem tools | Reasoning (direct) |

- [ ] **Step 2: `docs/workflows/README.md` com guia completo**

- DSL reference
- Step authoring (validação de input, error handling)
- Suspend/resume mental model
- Versioning
- Como adicionar workflow novo (passo a passo)

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(workflow): user-facing documentation"
```

---

### Task 12: Validação final e PR

- [ ] **Step 1: Verificar localmente**

```bash
psql $DATABASE_URL -f migrations/005_workflow_state.sql
npm run lint
npm run typecheck
npm test -- workflow
npm run build
```

- [ ] **Step 2: Smoke E2E — enfileirar execução com agent que usa workflow**

Manual: payload BullMQ com `agent_config.workflow_override: 'book-appointment'`, observar logs:
1. `workflow.execution.created`
2. `workflow.step.execute` x N
3. Em `request-payment`: `workflow.suspended`
4. Publicar manualmente em `workflow:resume` via `redis-cli PUBLISH workflow:resume '{"suspendToken":"...","payload":{}}'`
5. Logs continuam: `workflow.resumed`, `workflow.completed`
6. Callback `complete` enviado ao Bevox

- [ ] **Step 3: PR**

```bash
git push origin HEAD:sprint-c-1-workflow-engine
gh pr create --title "Sprint C.1: Workflow Engine" --body "$(cat docs/superpowers/plans/2026-05-14-sprint-c-1-workflow-engine.md | head -40)"
```

---

## Definition of Done

- ✅ Migration `005_workflow_state.sql` aplicada e testada
- ✅ `createWorkflow().step().then().branch().parallel().build()` funcional via builder
- ✅ Executor persiste estado por step (crash-safe)
- ✅ Suspend/Resume via Redis pub/sub round-trip em teste de integração
- ✅ Timeout cleanup expira workflows zumbis
- ✅ Workflow `book-appointment` registrado e executa happy path + suspend em pagamento
- ✅ Reasoning engines coexistem (testes de regressão `npm test -- reasoning` verdes)
- ✅ Cobertura ≥ 75% em `src/workflow/*`
- ✅ Docs `docs/workflows/README.md` + seção no README do projeto
- ✅ OTEL spans `workflow.step.execute` emitidos (no-op se Phase 4 ausente)

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| State drift entre versões de workflow durante deploy gradual | Versionar workflow_id; resume carrega versão exata gravada na row; deprecação documentada |
| Workflows suspended zumbis acumulando no DB | Job de cleanup roda a cada 5min expirando por `timeout_at`; índice parcial em `status='suspended'` |
| Dependência circular reasoning↔workflow (workflow chamando agent que chama workflow) | Detectar via depth counter em `StepContext` (max 2 níveis); falha explícita |
| Bevox não suporta status `suspended` no callback PATCH | Em V1, mapear para `running` com flag `paused: true` no payload; coordenar antes do merge |
| `suspend_token` adivinhável compromete resume | UUID v4 + constant-time compare; validar `account_id` da row contra fonte do resume |
| Migration `005` colide com sequência (existem 004?) | Verificar `ls migrations/` antes — se conflito, renumerar para próximo livre |
| Workflow definition mudou em código mas versão não bumpada | Lint rule (future) detecta diff em step ids/shapes sem version bump; em V1, code review |
| Pub/sub Redis perde mensagem se subscriber não está conectado | Resume token é durável no DB; webhook do Bevox deve retry; subscriber é at-least-once |
| Acoplamento com Phase 4 spans | `withSpan` é no-op se F4 não estiver presente — sem hard dependency |

---

## Correções Pós-Review (2026-05-14)

Aplicadas após review automatizado. Consultar [INDEX](./2026-05-14-INDEX-bevox-2.0-sprints.md#correções-pós-review-2026-05-14) para decisões globais.

### Critical
- **Task 0 (nova)** — Husky no-verify global (G.6) + Hook modular `src/runtime/hooks/` (G.5) prerequisito.
- **Migration `005_workflow_state.sql`** — Confirmada via G.1 (reserva canônica). Manter `005`, NÃO renumerar para `004` (que vai pra A.2).
- **Resume HTTP via Bevox callback reverso (G.11)** — Substituir Task 5 Step 2 "Bevox publica em canal Redis" por: harness expõe endpoint HTTP interno (não REST público) em interface privada com bind localhost OU socket Unix, auth via shared secret. Bevox chama via VPC interno quando evento externo ocorre. **Não viola CLAUDE.md "NÃO expõe API REST"** porque é boundary trusted, não internet. Adicionar ADR `docs/adr/00X-workflow-resume-boundary.md`.
- **`AgentDefinition` precedence** — Quando ambos `reasoning` e `workflow?` presentes: workflow vence. Se workflow falha no boot (não registrado), hard fail (não fallback silencioso para reasoning). Documentar em JSDoc de `src/agents/types.ts`.
- **`WorkflowState` Zod schema versionado** — Em Task 2: definir `WorkflowStateSchemaV1 = z.object({...})` com `schemaVersion: number` dentro de `state`. Adicionar migrator `migrateStateV1ToV2()` placeholder para futuras versões. Sem isso, resume após deploy com shape novo corrompe.
- **Conflito C.2 mencionado bidirecional** — Adicionar nota em Task 8 (escolha workflow vs reasoning) sobre interação com `StreamPublisher` (status `suspended` deve parar streaming).

### Important
- **DAG cycle detection** — Validar em `WorkflowBuilder.build()`: percorrer árvore com Set de IDs visitados, rejeitar referências repetidas. Sem isso, branch dentro de branch pode loop infinito.
- **DSL `.then()` vs `.step()`** — Remover `.then()` ou definir semântica própria. Atualmente alias idêntico = dívida de API.
- **Retry policy** — Extrair só algoritmo de backoff+jitter de `src/integration/llm/retry-decorator.ts`, NÃO a classificação de erros (workflow errors são domínio diferente). Documentar matriz "quais erros são retryable em step".
- **Index `(account_id, status)`** — Adicionar `idx_wf_exec_account_status ON workflow_executions(account_id, status)` para listSuspended por account.
- **`suspend_token` query** — `loadBySuspendToken(token, accountId)` com WHERE em ambos para evitar enumeration attack.
- **Workflow versioning retention** — Documentar regra: versions ficam registradas enquanto `status IN ('running','suspended')` referenciar. Query de check antes de deprecation.
- **`RunWorkflowResult → AgentResponse`** — `AgentResponse` exige `sentiment`/`usage` (per CLAUDE.md). Workflow não produz. Especificar defaults ou marcar nullable no callback contract.
- **`stepOutputs['__resume__']`** — Documentar como constant exportada + adicionar ao `WorkflowState` schema explicitamente como `resumePayload?: unknown`.

### Nitpick
- Bootstrap stage rename: escolher um (3.5 ou rename) — CLAUDE.md tem 7 stages numerados.
- DoD coverage ≥75% — Confirmar que vitest config tem coverage threshold ou substituir por contagem mínima.
- Cleanup BullMQ queue name — Especificar (reusa `HARNESS_QUEUE_NAME` ou nova).
- PR command Windows-compat.
