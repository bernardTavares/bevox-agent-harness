# Idempotency-Key Full Threading — Design

> **Spec ID:** `2026-06-02-idempotency-key-full-threading-design`
> **Status:** Draft — pendente review pelo founder · **Addendum §11 (original_execution_id lineage): LANDED (read-side)**
> **Autor:** Claude (Haiku 4.5) com instruções do founder em 2026-06-02
> **Escopo:** bevox-harness C10 audit finding (CRÍTICO — retry de mutação duplica side-effects)
> **Estimate:** 12h (3 phases, 4-4-4h)
> **Issue:** bernardTavares/bevox-harness#32

> **NB (2026-06-03):** O corpo §1–§10 abaixo é o design histórico (stepIndex
> threading + sendComplete keys + tool migrations) e está em grande parte
> LANDED na branch `mutation-stack` (#59). A fórmula viva já é
> `sha256(${execution_id}:${step}:${tool}:${canonical(params)})`. O
> **Addendum §11** documenta a extensão `original_execution_id` (linhagem de
> replay), agora com **canon APROVADO** (bevox-knowledge #62 + #63) e
> **read-side LANDED** neste worktree.

## §1. Context

Hoje o harness processa mutações (calendar ops: `create-appointment`, `cancel-appointment`, `reschedule-appointment`, `waitlist-add`) e callbacks (`/complete` para backend) sem carregar header `Idempotency-Key` em chamadas HTTP. Em retry BullMQ de mesma execução, o backend calendar-service e bevox-backend recebem chamadas idênticas sem chave deduplidora, causando duplicação de side-effects: dois appointments criados, duas cancelações, múltiplas respostas enviadas.

A infraestrutura de suporte **já existe**:
- `ToolContext` em `/src/tools/_shared/mutation-tool.ts` (linha 37-50) já define `step_index?: number` desde C8.
- `MutationTool.deriveIdempotencyKey()` estático (linhas 127-130) implementa fórmula canônica `harness:${execution_id}:${step}:${operationName}`.
- `calendar-client.ts` (linhas 54-75, 77-98) e `bevox-callback.ts` (linhas 15-38) já aceitam parâmetro opcional `idempotencyKey` e injetam header `Idempotency-Key` quando fornecido.
- `create-appointment.mutation.ts` (linha 104) já chama `this.deriveIdempotencyKey(context)` e passa para `calendar-client.createAppointment()`.
- Testes unitários em `/tests/unit/tools/_shared/mutation-tool-idempotency.test.ts` e `/tests/unit/integration/idempotency-key-headers.test.ts` validam derivação e injeção.

**O gap crítico:** `ToolExecutor` em `/src/reasoning/engine.ts` (linhas 92-96) não recebe `stepIndex`, e os 5 reasoning engines (react.ts:116, rewoo.ts, plan-execute.ts, reflexion.ts, direct.ts) chamam `executeTool(toolName, params, context)` **sem passar step_index**. Consequência: `wrapMutationTool` no bridge (linha 176-183) cria `ToolContext` sem `step_index`, a derivação cai para `0`, e mutações múltiplas no mesmo step reutilizam a mesma chave (correto), **mas diferentes execuções retentadas também reutilizam a mesma chave** (duplicação). Além disso, `sendComplete` é chamado em 16 locais de `execution-handler.ts` (linhas 286, 398, 1132, etc.) sem passar idempotencyKey.

**Impacto produção:** PRD §13.3 + ADR-023 exigem idempotência determinística por `sha256(${execution_id}:${step_index}:${tool_name})`. Em BullMQ retry de mesma `execution_id`, retries de appointment mutations **duplicam criações**, e `/complete` callbacks são **reprocessados sem dedup**.

## §2. Problem statement

**Gap 1: Threading de `stepIndex` nos engines.**
Assinatura de `ToolExecutor` (engine.ts:92-96) não carrega `stepIndex`. Cada engine (ReAct, ReWOO, PlanExecute, Reflexion, Direct) executa steps com índice conhecido internamente mas não repassa ao executor. Resultado: `ToolContext.step_index` fica `undefined`, derivação usa `0`, e todas as tentativas (mesmo step repetido em retry) geram **mesma chave**.

**Gap 2: Idempotency-Key não é injetado em `sendComplete`.**
`sendComplete()` é chamado em 16 call-sites de execution-handler.ts (linhas 286, 398, 1132, 1237, 1573, 1674) sem passar `idempotencyKey`. Callback `/complete` não é dedupado em BullMQ retry.

**Gap 3: Mutation tools legados ainda não herdamMutationTool.**
`cancel-appointment.tool.ts`, `reschedule-appointment.tool.ts`, `waitlist-add.tool.ts` ainda são tools convencionais (ToolDefinition inline) e **nunca chamam `calendar-client` com idempotencyKey**. (NB: `create-appointment.tool.ts` já migrou como EM-03 POC.)

**Evidência concreta:**
- BullMQ retry de job `{execution_id: "abc123", step: 2, tool: "create-appointment"}` gera chave `harness:abc123:0:create-appointment` em ambas as tentativas (missing stepIndex) → backend calendar service cria 2 appointments.
- `/complete` callback sem `Idempotency-Key` header → backend processa ambos os retries como submissões novas.

## §3. Goals & non-goals

**Goals:**
- Derivar `stepIndex` em cada engine (ReAct, ReWOO, PlanExecute, Reflexion, Direct, workflow) e passar via `ToolExecutor` callback.
- Assinar `ToolExecutor` para receber `stepIndex` e repassar em `ToolContext`.
- Propagar `stepIndex` de `wrapMutationTool` bridge para `ToolContext`.
- Chamar `deriveIdempotencyKey()` em cada call-site de `sendComplete()` com `execution_id + 0 + "complete"` (step único por execução).
- Migrar `cancel-appointment`, `reschedule-appointment`, `waitlist-add` para herdar de `MutationTool` e chamar `deriveIdempotencyKey()`.
- Atualizar assinaturas de `calendar-client` (cancelAppointment, rescheduleAppointment, addToWaitlist) para aceitar `idempotencyKey?`.
- Testes: unitários para derivação + headers, integração BullMQ retry + dedup, regressão em tools legadas.

**Non-goals:**
- Não modificar contrato de payload BullMQ (discriminador de retry é `human_feedback`, não valor novo em `execution_mode`).
- Não refocar ADR-006 (autonomy modes) ou ADR-023 (fórmula); apenas threadar.
- Não tocar workflow-state-store ou persistência; `stepIndex` é ephemeral (não salvo).
- Não reescrever engines de reasoning; apenas adicionar parâmetro ao executor.

## §4. Architecture proposal

### 4.1 Fluxo de threading

```
┌─────────────────────────────────────────────────────────────────┐
│ execution-handler.ts: dispatchModelC / dispatchSurfaceReAct     │
│   - Resolve `agentContext` (executionId, organizationId)        │
│   - Registra `executeTool` callback                             │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────────────────┐
│ reasoning/react.ts (ou outros engines)                          │
│   - Loop: for (step=0; step < max; step++)                      │
│   - LLM outputs: toolName, toolParams                           │
│   - executeTool(toolName, params, context, step) ← NOVO         │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────────────────┐
│ tools/_shared/mutation-tool.ts: wrapMutationTool bridge         │
│   - receive: (rawParams, agentContext, stepIndex) ← NOVO        │
│   - create ToolContext w/ step_index = stepIndex                │
│   - invoke mutation.executeOrPropose(params, toolCtx, mode)     │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────────────────┐
│ tools/calendar/*.mutation.ts (create, cancel, reschedule, etc)  │
│   - execute() has ToolContext w/ step_index                     │
│   - key = deriveIdempotencyKey(context) ← uses step_index       │
│   - calendar-client.createAppointment(..., idempotencyKey)      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ execution-handler.ts: AFTER agentResponse                       │
│   - key = MutationTool.deriveIdempotencyKey({execution_id, 0}) │
│   - sendComplete(executionId, token, payload, key)              │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Assinatura nova de `ToolExecutor`

**Antes:**
```typescript
export type ToolExecutor = (
  toolName: string,
  params: unknown,
  context: AgentExecutionContext,
) => Promise<unknown>;
```

**Depois:**
```typescript
export type ToolExecutor = (
  toolName: string,
  params: unknown,
  context: AgentExecutionContext,
  stepIndex: number,
) => Promise<unknown>;
```

`stepIndex` é **obrigatório** (não optional). Engines devem sempre fornecer o índice do step atual.

### 4.3 Propagação em `wrapMutationTool` (bridge)

**Antes (linha 176-183):**
```typescript
async execute(rawParams: unknown, context: AgentExecutionContext): Promise<ToolDefResult> {
  const params = rawParams as P;
  const mode: ExecutionMode = context.executionMode ?? "autonomous_supervised";
  const toolContext: ToolContext = {
    execution_id: context.executionId,
    organization_id: context.organizationId,
    execution_mode: mode,
  };
  const outcome = await mutation.executeOrPropose(params, toolContext, mode);
  // ...
}
```

**Depois:**
```typescript
async execute(
  rawParams: unknown,
  context: AgentExecutionContext,
  stepIndex: number,  // ← NOVO (via super.execute(params, context, stepIndex))
): Promise<ToolDefResult> {
  const params = rawParams as P;
  const mode: ExecutionMode = context.executionMode ?? "autonomous_supervised";
  const toolContext: ToolContext = {
    execution_id: context.executionId,
    organization_id: context.organizationId,
    step_index: stepIndex,  // ← NOVO
    execution_mode: mode,
  };
  const outcome = await mutation.executeOrPropose(params, toolContext, mode);
  // ...
}
```

### 4.4 Call-sites de `sendComplete` — injetar idempotencyKey

**Antes (ex: linha 398):**
```typescript
await sendComplete(
  executionId,
  executionToken,
  buildCompletePayload({
    responseText: agentResponse.answer,
    sentiment: "neutral",
    strategy: agentResponse.strategy,
  }),
);
```

**Depois:**
```typescript
const completeKey = MutationTool.deriveIdempotencyKey(
  { execution_id: executionId, organization_id: organizationId },
  "complete"
);
await sendComplete(
  executionId,
  executionToken,
  buildCompletePayload({
    responseText: agentResponse.answer,
    sentiment: "neutral",
    strategy: agentResponse.strategy,
  }),
  completeKey,
);
```

(Replicar em todos os 16 call-sites.)

### 4.5 Migração de tools legadas

**cancel-appointment.tool.ts → cancel-appointment.mutation.ts**

```typescript
// Novo arquivo: src/tools/calendar/cancel-appointment.mutation.ts
import * as calendarClient from "../../integration/calendar-client.js";
import { MutationTool, type ToolContext } from "../_shared/mutation-tool.js";

export interface CancelAppointmentParams {
  appointment_id: string;
  reason?: string;
}

export class CancelAppointmentMutation extends MutationTool<
  CancelAppointmentParams,
  { ok: true }
> {
  readonly name = "cancel-appointment";
  readonly action = "cancel-appointment";

  async execute(params: CancelAppointmentParams, context: ToolContext) {
    if (!params.appointment_id) {
      throw new Error("appointment_id is required");
    }
    const idempotencyKey = this.deriveIdempotencyKey(context);
    const data = await calendarClient.cancelAppointment(
      params.appointment_id,
      params.reason ?? "",
      undefined,
      idempotencyKey,
    );
    return data;
  }
}
```

**cancel-appointment.tool.ts → wrapper**

```typescript
import { wrapMutationTool } from "../_shared/mutation-tool.js";
export const cancelAppointmentTool = wrapMutationTool(new CancelAppointmentMutation(), {
  description: "Cancel an existing appointment.",
  category: "calendar",
  agentType: "surface",
  parameters: { /* ... */ },
});
```

(Repetir para `reschedule-appointment`, `waitlist-add`.)

### 4.6 Assinaturas de `calendar-client` — adicionar `idempotencyKey?`

**Antes:**
```typescript
export async function cancelAppointment(
  appointmentId: string,
  reason: string,
  token?: string,
): Promise<unknown>
```

**Depois:**
```typescript
export async function cancelAppointment(
  appointmentId: string,
  reason: string,
  token?: string,
  idempotencyKey?: string,
): Promise<unknown>
```

(Repetir para `rescheduleAppointment`, `addToWaitlist`.)

Implementação interna já existe (post/patch aceitam e usam).

## §5. Implementation plan

### Phase 1 — Foundation (4h)

**Objetivo:** assinatura de ToolExecutor + infra de headers + calendar-client updated signatures (backward-compatible).

**Files:**

- `src/reasoning/engine.ts` — atualizar type `ToolExecutor` (linhas 92-96).
- `src/integration/calendar-client.ts` — adicionar `idempotencyKey?` a `cancelAppointment()`, `rescheduleAppointment()`, `addToWaitlist()` (forward-compatible; logic já existe).
- `src/tools/_shared/mutation-tool.ts` — modificar `wrapMutationTool` bridge para receber `stepIndex` e popul `toolContext.step_index` (linhas 176-183).

**Testes:**

- Unit: `tests/unit/tools/_shared/mutation-tool-idempotency.test.ts` — adicionar caso de `stepIndex` propagado via bridge.
- Unit: `tests/unit/integration/idempotency-key-headers.test.ts` — testar que `cancelAppointment(..., undefined, idempotencyKey)`, `rescheduleAppointment(..., undefined, idempotencyKey)`, `addToWaitlist(..., idempotencyKey)` injetam header.

**Backward-compat:** engines ainda chamam `executeTool()` sem `stepIndex`; compilador errará → fase 2 fixa.

**Result:** Type-safe assinatura pronta, calendar-client pronto, wrapMutationTool pronto.

### Phase 2 — Engine threading (4h)

**Objetivo:** cada reasoning engine passa `stepIndex` real em cada chamada a `executeTool()`.

**Files:**

- `src/reasoning/react.ts` — mudar linha 116 de `await executeTool(toolName, toolParams, context)` para `await executeTool(toolName, toolParams, context, stepIndex)`.
- `src/reasoning/rewoo.ts` — idem (2-3 call-sites).
- `src/reasoning/plan-execute.ts` — idem (4-5 call-sites).
- `src/reasoning/reflexion.ts` — idem (2 call-sites).
- `src/reasoning/direct.ts` — idem (1 call-site).
- `src/workflow/engine.ts` — idem (workflow step executor callback).

**Testes:**

- Integration: cada engine + calendar-mutation → verify idempotencyKey é passado e header injetado.
- Regression: ReAct/ReWOO/PlanExecute/Reflexion/Direct path com non-mutation tools (read-only) — verify não quebrou.

**Result:** Todos os engines threadam stepIndex; mutações começam a receber chave por step.

### Phase 3 — Tool migrations + callback threading (4h)

**Objetivo:** migrar 3 tools legadas + threadar idempotencyKey em sendComplete.

**Files:**

- `src/tools/calendar/cancel-appointment.mutation.ts` — criar (novo arquivo; migrar de tool legado).
- `src/tools/calendar/cancel-appointment.tool.ts` — atualizar para usar `wrapMutationTool`.
- `src/tools/calendar/reschedule-appointment.mutation.ts` — criar (novo arquivo).
- `src/tools/calendar/reschedule-appointment.tool.ts` — atualizar para usar `wrapMutationTool`.
- `src/tools/calendar/waitlist-add.mutation.ts` — criar (novo arquivo).
- `src/tools/calendar/waitlist-add.tool.ts` — atualizar para usar `wrapMutationTool`.
- `src/runtime/execution-handler.ts` — adicionar `deriveIdempotencyKey()` em todos os 16 call-sites de `sendComplete()` (linhas 286, 398, 1132, 1237, 1573, 1674 + others).

**Testes:**

- Unit: `mutation-tool-idempotency.test.ts` — validar derivação com `operationName: "complete"`.
- Unit: `idempotency-key-headers.test.ts` — testar que cada novo mutation tool injeta header.
- Integration: BullMQ retry scenario — verify same execution_id + same step reutiliza chave, dedupando no backend.
- Integration: `/complete` callback com retry — verify header `Idempotency-Key` está presente e dedupado.

**Result:** Todas as mutações + callbacks carregam chave determinística; BullMQ retry não duplica side-effects.

## §6. Testing strategy

### Unit tests

**File:** `tests/unit/tools/_shared/mutation-tool-idempotency.test.ts`
- Validar `deriveIdempotencyKey(context, operationName)` com `step_index` provided.
- Validar com `operationName = "complete"` (step sempre 0).
- Validar determinismo: mesma input → mesma output.

**File:** `tests/unit/integration/idempotency-key-headers.test.ts`
- Verify `calendar-client.cancelAppointment(..., idempotencyKey)` injeta header.
- Verify `calendar-client.rescheduleAppointment(..., idempotencyKey)` injeta header.
- Verify `calendar-client.addToWaitlist(..., idempotencyKey)` injeta header.
- Verify `bevox-callback.sendComplete(..., idempotencyKey)` injeta header.
- Backward-compat: omitting idempotencyKey → header não presente.

**File:** `tests/unit/tools/calendar/*.test.ts`
- New mutation tools herdam de `MutationTool` e injetam idempotencyKey.
- Verify mode dispatch (autonomous_supervised → execute; manual_assisted → propose).

### Integration tests

**BullMQ retry scenario:**
- Setup: Enfileira job normal com `execution_id: "abc123"`, step 0, `create-appointment`.
- Expect: `Idempotency-Key: harness:abc123:0:create-appointment` em header.
- Simulate retry: Dequeue, processar novamente (mock BullMQ redelivery).
- Expect: Mesma chave → backend calendar-service deduplica (mock return 409 Conflict + existing appointment ID).
- Verify: Harness não falha; usar `existing appointment_id` em resultado.

**Callback `/complete` dedup:**
- Setup: Execução normal, `sendComplete()` chamado com derived key.
- Simulate retry: Mock backend, verify header `Idempotency-Key: harness:abc123:0:complete` está presente.
- Mock backend dedup: Verificar que second `/complete` com mesma chave é rejeitado (409) ou silenciosamente ignorado.

### Regression tests

- All engines (ReAct, ReWOO, PlanExecute, Reflexion, Direct, workflow) c/ non-mutation tools (read-only) ainda funcionam.
- Existing proposals in manual_assisted mode continuam a funcionar.
- Rate-limit checks em tools de mutação continuam a aplicar.

## §7. Migration & rollback

### Gradual activation

1. **Phase 1 (foundation):** compilar, deploy (sem efeito, engines ainda não threadam).
2. **Phase 2 (threading):** deploy, engines começam a passar stepIndex. Mutações começam a receber chaves por step. Calendars service vê novo header — already idempotency-safe, nenhuma mudança no comportamento.
3. **Phase 3 (tools + callback):** migrar tools, threadar idempotencyKey em sendComplete. Backend `/complete` começa a receber header, deduplica.

### Feature flag (opcional)

Se houver dúvida sobre impacto, adicionar env var `HARNESS_IDEMPOTENCY_KEYS_ENABLED` (default true); false ativa legacy behavior (não injeta headers). Retire em 2026-07.

### Rollback

- Phase 1 rollback: Revert type signature; engines compilam com `stepIndex: 0` default, chama `executeTool(toolName, params, context, 0)`.
- Phase 2 rollback: Revert engine changes; `stepIndex` cai para 0, idempotencyKey derivation tira `0`, retry-dedup quebra mas não piora (status quo).
- Phase 3 rollback: Revert tool migrations + sendComplete; legacy tools executam sem header (status quo), callback sem header.

Nenhum rollback é destrutivo de dados.

## §8. Risks & open questions

### Risks

1. **16 call-sites de `sendComplete()`:** Chance de um ser esquecido. Mitigar: grep para confirmar todos foram tocados; teste de integração que valida presença de header em `/complete`.

2. **Tool registry integrations:** Se houver código fora de `execution-handler.ts` que registra ou chama `ToolExecutor` diretamente, precisará atualizar. Mitigar: codebase search; integration tests.

3. **Workflow step executor:** Workflow engine tem seu próprio `toolExecutor` callback. Verificar que também threadar stepIndex corretamente (não é listado nos 5 main engines mas é similarmente importante).

### Open questions

1. **Timeout per engine:** Engines passam stepIndex = current loop index. Reflexion wrapper re-executa steps; qual stepIndex no retry do Reflexion? (Resposta esperada: o índice original do step; Reflexion não cria novo step, reexecuta.) Confirmar no design do Reflexion.

2. **Workflow step number:** Workflow steps têm IDs semânticos, não índices. Como mapear? (Resposta esperada: usar ordem na lista de steps como índice, ex: step 3 = index 2.) Confirmar com workflow-engine owner.

3. **ADR update:** C10 não cobre idempotência em geral, só retry-dedup. Considerar nova seção em ADR-023 ou doc separado de referência. (Fora do scope desta entrega.)

## §9. Definition of done

- [ ] Phase 1 merged (foundation PRs):
  - [ ] `src/reasoning/engine.ts` — ToolExecutor type assinado
  - [ ] `src/tools/_shared/mutation-tool.ts` — bridge recebe stepIndex
  - [ ] `src/integration/calendar-client.ts` — cancelAppointment, rescheduleAppointment, addToWaitlist assinado c/ idempotencyKey?
  - [ ] Unit tests: mutation-tool-idempotency, idempotency-key-headers (novos casos)
  - [ ] Compila sem warnings
  
- [ ] Phase 2 merged (threading PRs):
  - [ ] Todos os 5 engines (react, rewoo, plan-execute, reflexion, direct) threadam stepIndex
  - [ ] Workflow engine threadar stepIndex
  - [ ] Integration tests: BullMQ retry scenario + header injection
  - [ ] Regression tests: non-mutation tools, proposals, rate-limits
  
- [ ] Phase 3 merged (tool migrations + callback PRs):
  - [ ] 3 mutation tools migradas (cancel, reschedule, waitlist)
  - [ ] 16 call-sites de sendComplete com deriveIdempotencyKey()
  - [ ] Integration tests: callback dedup, BullMQ retry end-to-end
  - [ ] Audit finding C10 validado como closed
  
- [ ] Audit finding #C10 marked as resolved in audit doc
  
- [ ] No regressions em test suite (unit + integration)
  
- [ ] Code review aprovado (mutation-tool + engines + callback-threading)

## §10. References

- **Issue:** bernardTavares/bevox-harness#32
- **Audit finding:** docs/audits/v1-2026-04-22/ (C10 — retry idempotência)
- **ADR-023:** Idempotency-Key format e propagação
- **PRD §13.3:** Contrato de mutação com retry-safety
- **Specs relacionadas:**
  - `2026-05-15-hitl-rejection-retry-aprendizado-continuo-design.md` (seção §5.2 — discriminador de retry)
  - `2026-05-16-sdr-fase-c-correlation-bridge-design.md` (seção §4 — ToolExecutor bridge)
- **Código fonte:**
  - `src/tools/_shared/mutation-tool.ts` (linhas 37-50, 127-130)
  - `src/reasoning/engine.ts` (linhas 92-96)
  - `src/integration/calendar-client.ts` (linhas 54-75, 77-98)
  - `src/integration/bevox-callback.ts` (linhas 15-38)
  - `src/runtime/execution-handler.ts` (linhas 286, 398, 1132, 1237, 1573, 1674)
  - Testes: `tests/unit/tools/_shared/mutation-tool-idempotency.test.ts`, `tests/unit/integration/idempotency-key-headers.test.ts`

## §11. Addendum — `original_execution_id` lineage (read-side) — LANDED

> **Status:** LANDED (read-side) na branch `mutation-stack` (#59).
> **Canon:** **APROVADO** — bevox-knowledge PR #62 (harness-proposal) + PR #63
> (backend-edits); status PROPOSED → approved pelo founder em 2026-06-03.
> **Track:** `orig-exec-id`.

### §11.1 Problema

A fórmula viva deriva a idempotency-key a partir de `execution_id`:

```
sha256(`${execution_id}:${step}:${tool}:${canonical(params)}`)
```

Um **replay de staff** (re-despacho de uma execução para refazer/corrigir uma
ação) chega com um `execution_id` NOVO. Com a fórmula acima, o replay deriva
uma chave DIFERENTE da execução original → o backend NÃO dedup → uma mutação
de agendamento (ex.: `create-appointment`) é **duplicada**. Por isso o replay
seguro de mutação de agendamento estava **gated** até existir um discriminador
de linhagem.

### §11.2 Contrato aprovado

O backend passa a enviar, no payload de dispatch BullMQ, um campo OPCIONAL
`original_execution_id`: a **RAIZ da linhagem** de replay. O backend encadeia
TODO replay à raiz (não ao pai imediato), então toda a cadeia de replays de
uma mesma operação lógica compartilha o mesmo `original_execution_id`.

- **OPCIONAL.** Ausente (default) → comportamento **byte-idêntico a hoje**
  (chave usa `execution_id`).
- **Presente** → `z.string().uuid()`.

### §11.3 Read-side implementado (este worktree)

1. **Schema inbound** (`src/runtime/execution-handler.ts`,
   `executionPayloadSchema`): adicionado `original_execution_id:
   z.string().uuid().optional()`. O schema usa `.passthrough()`, mas o campo
   é declarado EXPLICITAMENTE para ser tipado e threadado.
2. **Threading**: `payload.original_execution_id` →
   `AgentExecutionContext.originalExecutionId` (construído uma vez no handler;
   cobre tanto o ReAct path quanto o Model-C path, que recebe o mesmo
   `agentContext` via `DispatchModelCArgs`) → bridge `wrapMutationTool` →
   `ToolContext.original_execution_id`.
3. **Derivação** (`MutationTool.deriveIdempotencyKey`): o componente
   execution_id do hash passa a ser
   `lineageId = context.original_execution_id ?? context.execution_id`:

   ```
   sha256(`${original_execution_id ?? execution_id}:${step}:${tool}:${canonical(params)}`)
   ```

### §11.4 Semântica de dedup

Um replay de staff chega com um `execution_id` NOVO mas o MESMO
`original_execution_id` (a raiz). Como a derivação usa a raiz, o replay
produz a **MESMA chave** da execução original → backend **dedup** → **SEM
mutação duplicada**. Isto **des-bloqueia o replay seguro de mutação de
agendamento** (não precisa mais ser gated nisto).

Ausente → `lineageId` cai para `execution_id` → byte-idêntico a hoje
(retrocompat total para payloads sem o campo).

### §11.5 Cobertura de testes (TDD, `tests/**`)

- `tests/unit/runtime/original-execution-id-payload.test.ts` — schema REAL
  (`executionPayloadSchema` exportado): ausente → `undefined`; presente UUID →
  parseado/tipado; não-UUID / tipo errado → rejeitado; payload de replay
  (NEW `execution_id`, SAME `original_execution_id`) parseia.
- `tests/unit/tools/_shared/mutation-tool-idempotency.test.ts` — dois contexts
  com `execution_id` DIFERENTE mas `original_execution_id` IGUAL + mesmos
  params + mesma tool → MESMA chave; ausente → chave usa `execution_id`
  (inalterado); linhagens distintas → chaves distintas.
- `tests/unit/tools/_shared/mutation-tool-bridge.test.ts` — o bridge
  `wrapMutationTool` threada `originalExecutionId` →
  `ToolContext.original_execution_id` (presente e ausente); replay
  bridge-threaded deriva a MESMA chave da execução original.

### §11.6 Não-objetivos (read-side)

- Não emite/propaga `original_execution_id` em callbacks de saída (write-side
  é do backend; aqui é puramente READ-SIDE de consumo).
- Não altera a fórmula para payloads sem o campo (retrocompat).
- Não migra o shape de `skills`/`account_denied_tools` (PERM-05 follow-up
  separado).