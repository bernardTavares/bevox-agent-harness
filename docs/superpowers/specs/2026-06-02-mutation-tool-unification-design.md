# Mutation Tool Unification — Design

> **Spec ID:** `2026-06-02-mutation-tool-unification-design`
> **Status:** Draft — pendente review pelo founder
> **Autor:** Claude (Haiku 4.5) com instruções do founder em 2026-06-02
> **Escopo:** Audit finding C9 + C10 (severity CRÍTICO); bernardTavares/bevox-harness
> **Estimate:** 24h total em 3 phases (Phase 1: 8h, Phase 2: 8h, Phase 3: 8h)
> **Issue:** bernardTavares/bevox-harness#33

## §1. Context

O harness possui uma base abstrata `MutationTool<Params, Result>` em `src/tools/_shared/mutation-tool.ts:60–131` que implementa o padrão `executeOrPropose()` conforme ADR-006/ADR-007: em modo `autonomous_supervised` executa o efeito real; em `manual_assisted`/`copilot` retorna uma `ToolProposal` (proposta sem efeito) para que o backend a converta em `AISuggestion` pendente de aprovação humana.

**Estado atual (2026-06-02):**
- `MutationTool` existe como código vivo, bem documentado e testado isoladamente (tests: `tests/unit/tools/calendar/create-appointment.mutation.test.ts`, `tests/unit/tools/_shared/mutation-tool-bridge.test.ts`).
- Um **bridge adapter** `wrapMutationTool()` (`:161–203`) converte `MutationTool` para o contrato `ToolDefinition` consumido pelo registry.
- **Apenas `create-appointment`** adota o padrão (via `createAppointmentTool = wrapMutationTool(createAppointmentMutation, ...)` em `src/tools/calendar/create-appointment.tool.ts:27`); é a POC de issue #44.
- **As 4 outras mutation tools** (`send-message`, `cancel-appointment`, `reschedule-appointment`, `waitlist-add`) implementam `ToolDefinition` plana (sem herança de `MutationTool`) e **sempre executam efeito real**, ignorando completamente a autonomy mode (audit finding **C9**: `grep "extends MutationTool"` retorna 0 para as 4 tools).

**Impacto em produção (C9 evidence):**
- Em `manual_assisted` ou `copilot`, a IA invoca `send-message` → mensagem é **enviada de verdade** sem aprovação humana (viola ADR-018 §92–106).
- Idem para `create-appointment` se fosse chamada sem o wrapper (ele não é — mas foi POC de #44).
- Acoplado a **C8** (execution_mode nunca é lido do payload) — até que C8 seja fechado, todas as execuções correm em modo `autonomous_supervised` por default conservador, mascarando C9.

**Precedente aceito:** O bridge de `create-appointment` (PR #44, conforme comments na issue) já provou o pattern. A issue #33 é a **unificação das 4 tools restantes**.

## §2. Problem statement

**Gap técnico:** Quatro mutation tools críticas não adotam o padrão `executeOrPropose`, permitindo execução incondicional de efeitos colaterais em modos de autonomia onde não deveriam executar.

**Evidência (audit lines):**
- C9 (`docs/audits/runtime-gap-audit-2026-06-02.md:151–161`): "`grep "extends MutationTool"` = 0" para tools de mutação; "5 tools de mutação... são `ToolDefinition` planas que **sempre** chamam o efeito real".
- `src/tools/messaging/send-message.tool.ts:35–46`: `execute()` chama `checkRateLimit()` → retorna sucesso incondicionalmente sem discriminar por modo.
- `src/tools/calendar/cancel-appointment.tool.ts`, `reschedule-appointment.tool.ts`, `waitlist-add.tool.ts`: padrão idêntico — `ToolDefinition` direta, sem proposta.

**Contraste:** `create-appointment.tool.ts:27–44` já demonstra a solução — wrapper `wrapMutationTool()` transforma a mutation em ToolDefinition que respeita autonomy.

**Segurança:** Conforme ADR-006/ADR-007, em `manual_assisted`/`copilot` **toda mutação deve proposar, nunca executar**. A ausência desse gate antes de produção é um risco de segurança operacional.

## §3. Goals & non-goals

**Goals:**
- Migrar `send-message` end-to-end de `ToolDefinition` plana para `MutationTool` + wrapper, respeitando `executeOrPropose()`.
- Integrar a migration em `src/tools/messaging/send-message.tool.ts` mantendo assinatura pública e compatibilidade com registro.
- Adicionar testes integration que validem: em `manual_assisted`, chamada retorna proposal; em `autonomous_supervised`, executa.
- Documentar o **migration path** para as 4 tools restantes (`cancel-appointment`, `reschedule-appointment`, `waitlist-add`, e confirmar qual é a quinta).
- Validar que o bridge capta proposals via `extractProposal()` e as hoista para `/complete.proposals[]`.

**Non-goals:**
- Não migrar as 4 tools restantes nesta POC (fica backlog conforme issue body).
- Não resolver C8 (execution_mode parsing) — assume que C8 será fechado antes da integração em produção.
- Não modificar o contrato de `ToolDefinition` ou `MutationTool`.
- Não integrar com ADR-023 (Idempotency-Key) nesta POC — será fase separada (C10).

## §4. Architecture proposal

### 4.1 Refator de `send-message` (target tool para POC)

**Opção A (recomendada): Nova classe `SendMessageMutation` herda de `MutationTool`**

Criar arquivo `src/tools/messaging/send-message.mutation.ts` com:

```typescript
import { MutationTool, type ToolContext } from "../_shared/mutation-tool.js";
import { checkRateLimit } from "../_shared/rate-limit.js";

export interface SendMessageParams {
  message: string;
}

export interface SendMessageResult {
  sent: true;
  message: string;
}

export class SendMessageMutation extends MutationTool<SendMessageParams, SendMessageResult> {
  readonly name = "send-message";
  readonly action = "send-message";

  async execute(
    params: SendMessageParams,
    context: ToolContext,
  ): Promise<SendMessageResult> {
    // Validação
    if (!params.message) {
      throw new Error("message is required");
    }

    // Rate-limit (preserva a política `send-message` do legado)
    const denied = await checkRateLimit(
      context.organization_id,
      "send-message",
      "send-message",
    );
    if (denied) {
      throw new Error(denied.detail ?? "Rate limit exceeded");
    }

    // Em autonomous_supervised: retorna o sinal
    // Nota: o handler de execução (execution-handler.ts) é o ÚNICO que
    // chama sendComplete() — a tool apenas retorna {sent:true, message}.
    return { sent: true, message: params.message };
  }
}

export const sendMessageMutation = new SendMessageMutation();
```

**Atualizar `src/tools/messaging/send-message.tool.ts`:**

Substituir a implementação plana de `ToolDefinition` por:

```typescript
import { wrapMutationTool } from "../_shared/mutation-tool.js";
import type { ToolDefinition } from "../types.js";
import { sendMessageMutation } from "./send-message.mutation.js";

export const sendMessageTool: ToolDefinition = wrapMutationTool(sendMessageMutation, {
  description: "Send a response message to the customer.",
  category: "messaging",
  agentType: "surface",
  parameters: {
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string", description: "The text to send to the customer" },
    },
  },
});
```

### 4.2 Integração com o execution-handler

O handler **já** implementa suporte a proposals (verify via `grep extractProposal src/runtime/execution-handler.ts`):

- Linha ~1489: `const proposal = extractProposal(result);` após cada `executeTool()`.
- Linhas ~1494–1504: proposta é logada e adicionada ao acumulador `proposals: []`.
- Linha ~1257–1262: `/complete` final inclui `proposals[]` (se não-vazio).

**Sem mudanças** no handler — apenas validar que a proposta é capturada e emitida.

### 4.3 Fluxo de execução

```
Payload BullMQ (execution_id, execution_mode: "manual_assisted")
         ↓
execution-handler.handleExecution()
         ↓
Agent ReAct loop → invoca "send-message" com {message: "..."}
         ↓
toolRegistry.resolve("send-message") → sendMessageTool (ToolDefinition)
         ↓
sendMessageTool.execute(params, AgentExecutionContext)
         ↓
wrapMutationTool bridge:
  - Extrai execution_mode = "manual_assisted"
  - Converte AgentExecutionContext → ToolContext
  - Chama sendMessageMutation.executeOrPropose(params, ctx, "manual_assisted")
         ↓
SendMessageMutation.executeOrPropose():
  - Como mode ≠ "autonomous_supervised", retorna ToolProposal (sem chamar execute())
  - { ok: true, proposal: { action: "send-message", params } }
         ↓
wrapMutationTool bridge materializa para ToolDefResult:
  - { success: true, data: { proposal: { action, params } } }
         ↓
execution-handler.executeTool():
  - extractProposal(result) → { action: "send-message", params }
  - Adiciona a proposals[]
  - Não emite `/complete` ainda (loop continua)
         ↓
Loop ReAct termina (send-message é STOP signal — react.ts:176)
         ↓
execution-handler.sendComplete():
  - Monta /complete com proposals: [{action, params}]
  - Backend converte em AISuggestion (ADR-007)
```

## §5. Implementation plan

### Phase 1 — Foundation (8h)

**Objetivo:** Criar `SendMessageMutation` e refatorar `send-message.tool.ts`.

**Files:**
- `src/tools/messaging/send-message.mutation.ts` — NOVO
- `src/tools/messaging/send-message.tool.ts` — REFATORADO (remove implementação, invoca wrapper)

**Tests:**
- `tests/unit/tools/messaging/send-message.mutation.test.ts` — NOVO
  - `autonomous_supervised` → executa, injeta rate-limit, retorna `{sent, message}`
  - `manual_assisted` → retorna proposal (sem side-effect, sem rate-limit check)
  - `copilot` → idem `manual_assisted`
  - Error handling (message missing, rate-limited) → lança erro capturado por `executeOrPropose`

**Checklist:**
- [ ] Criar `SendMessageMutation` com `executeOrPropose` (herda de `MutationTool`)
- [ ] Refatorar `send-message.tool.ts` para usar `wrapMutationTool()`
- [ ] Adicionar testes de modo `autonomous_supervised` (executa)
- [ ] Adicionar testes de modo `manual_assisted` (proposta, sem side-effect)
- [ ] Validar que suite de testes passa (`npm test -- send-message.mutation`)
- [ ] Verificar que import/export públicos permanecem compatíveis

**Commits:**
- `send-message: migrate to MutationTool pattern (C9 POC)`

### Phase 2 — Integration & validation (8h)

**Objetivo:** Integrar com execution-handler, adicionar testes integration, validar proposta é capturada.

**Files:**
- `src/runtime/execution-handler.ts` — verificar que `extractProposal()` funciona (pode não precisar mudança)
- `tests/integration/tools/send-message-proposal.integration.test.ts` — NOVO

**Tests integration:**
- Simular execução com `execution_mode: "manual_assisted"`
- Verificar que tool.execute() retorna `{success: true, data: {proposal: {...}}}`
- Verificar que `extractProposal()` extrai a proposta
- Verificar que `/complete` final inclui `proposals[0] = {action: "send-message", params}`
- Idem para `autonomous_supervised` (executa, sem proposal)

**Checklist:**
- [ ] Criar teste integration que simula ReAct loop com `send-message` em draft mode
- [ ] Validar que proposta é capturada e hoisted
- [ ] Validar que em `autonomous_supervised`, executa normalmente
- [ ] Documentar o fluxo (diagrama ASCII em §4.3 acima é o spec)
- [ ] Rodar suite completa (`npm test`)

**Commits:**
- `send-message: add integration tests for proposal flow (C9 POC)`

### Phase 3 — Documentation & migration path (8h)

**Objetivo:** Documentar o pattern e facilitar migração das 4 tools restantes.

**Files:**
- `docs/superpowers/specs/2026-06-02-mutation-tool-unification-design.md` — ESTE ARQUIVO
- `docs/architecture/harness-tools.md` ou `docs/guides/mutation-tool-migration.md` — NOVO
- `src/tools/_shared/mutation-tool.ts` — adicionar JSDoc expandido sobre herança (opcional)

**Documentação:**
- Guia: "Como migrar uma `ToolDefinition` plana para `MutationTool`" (template em 3 passos)
- Listar as 4 tools restantes com esforço estimado (calendar: 3×3h cada, waitlist: 3h)
- Descrever divergências entre shapes (`ToolContext` vs `AgentExecutionContext`, erro em `Error` vs em `{ code, message }`)
- Adicionar exemplo de erro handling (preconditon vs falha de execução)

**Backlog issues:**
- Criar issue #34 (cancel-appointment migration)
- Criar issue #35 (reschedule-appointment migration)
- Criar issue #36 (waitlist-add migration)
- Confirmar a 5ª mutation tool (audit menciona 5 tools, mas lista 4 no C9) — pode ser `request-human.tool.ts`

**Checklist:**
- [ ] Escrever doc guia de migration (passo-a-passo)
- [ ] Confirmar lista de 5 tools: `send-message` (✓), `create-appointment` (✓ em #44), `cancel-appointment`, `reschedule-appointment`, `waitlist-add`, `request-human` (?)
- [ ] Estimar esforço por tool (tipo: read-only, mutation, stop signal → impacto diferente)
- [ ] Crear backlog issues para as 4 restantes
- [ ] Validar que ADR-006/ADR-007 referenciam o padrão (ou criar ADR-024 "Mutation Tool Unification")

**Commits:**
- `docs: add mutation-tool migration guide and backlog for C9 cleanup`

## §6. Testing strategy

### Unit tests (Phase 1)

**`tests/unit/tools/messaging/send-message.mutation.test.ts`:**

```typescript
describe("SendMessageMutation (C9 POC)", () => {
  it("autonomous_supervised → executa de fato + rate-limit", async () => {
    // Mock rate-limiter como permitido
    // Chamar mutation.executeOrPropose(params, ctx, "autonomous_supervised")
    // Verify: retorna {ok:true, result:{sent, message}}
    // Verify: checkRateLimit foi chamado
  });

  it("manual_assisted → retorna proposal SEM executar", async () => {
    // Mock rate-limiter como permitido (não deve ser chamado)
    // Chamar mutation.executeOrPropose(params, ctx, "manual_assisted")
    // Verify: retorna {ok:true, proposal:{action, params}}
    // Verify: checkRateLimit NÃO foi chamado
  });

  it("copilot → retorna proposal SEM executar", async () => {
    // Idem manual_assisted
  });

  it("invalid params → lança erro capturado em proposal", async () => {
    // params.message vazio
    // Em autonomous_supervised: erro propagado
    // Em manual_assisted: erro capturado, retorna {ok:false, error}
  });

  it("rate-limited → lança erro capturado", async () => {
    // Mock rate-limiter como negado
    // Em autonomous_supervised: erro propagado
    // Em manual_assisted: erro capturado, retorna {ok:false}
  });
});
```

### Integration tests (Phase 2)

**`tests/integration/tools/send-message-proposal.integration.test.ts`:**

```typescript
describe("send-message tool (integration — C9 proposal flow)", () => {
  it("manual_assisted mode → proposal captured and hoisted", async () => {
    // Simular execução com execution_mode: "manual_assisted"
    // Mock agent executor para chamar send-message
    // Verify: result = {success:true, data:{proposal:{action,params}}}
    // Verify: extractProposal(result) retorna a proposta
    // Verify: completCallback.proposals[] inclui a proposta
  });

  it("autonomous_supervised mode → executa normalmente", async () => {
    // Simular execução com execution_mode: "autonomous_supervised"
    // Verify: result = {success:true, data:{sent:true, message}}
    // Verify: extractProposal(result) retorna undefined
  });
});
```

### Regression (before & after)

- Suite existente `tests/unit/tools/send-message.test.ts` deve passar sem mudanças (compatibilidade pública mantida).

## §7. Migration & rollback

### Ativação

**Gradual:**
1. Merge Phase 1 + 2 + testes passando.
2. Rodar contra ambiente staging com `execution_mode: "manual_assisted"` em subset de orgs.
3. Validar que proposals[] chegam no backend.
4. Se estável, rodar contra produção (sem feature flag necessária — é opt-in conforme modo).

**Sem breaking change:** `send-message.tool.ts` mantém mesmo `export`, registry não muda.

### Rollback

Se proposals não forem hoistadas corretamente:
1. Reverter refatoração de `send-message.tool.ts` → volta a implementação plana (simples revert commit).
2. Mutations voltam a executar sempre (V0 behavior).
3. Nenhuma mudança de dados — schemas imutáveis.

**Risco baixo:** pattern já foi provado em `create-appointment` (PR #44).

## §8. Risks & open questions

### Técnicos

1. **Divergência entre shapes:** `MutationTool.execute()` lança `Error` (simples); `ToolDefinition.execute()` retorna `{success:false, error:string}`. O bridge `wrapMutationTool` converte lançamento em erro estruturado. **Mitigação:** o bridge já existe e funciona (testado em #44).

2. **Rate-limit em draft mode:** Em `manual_assisted`, `checkRateLimit()` não deve ser chamado (não há efeito a limitar). A implementação atual coloca rate-limit dentro de `execute()` — logo, não roda em draft. **Mitigação:** correto por construção do pattern.

3. **Idempotência em retry:** Se uma execução falhar e o BullMQ re-tentar, ambas as tentativas geram proposals distintas (execution_id novo em cada retry). **Mitigação:** não é problema nesta POC (C10 é tópico separado).

4. **C8 dependency:** Se `execution_mode` continuar não sendo lido (C8 aberto), todas as execuções virão como `autonomous_supervised` por default, e proposals nunca serão emitidas em produção. **Mitigação:** issue #33 assume que C8 está no caminho crítico e será fechado antes de integração. Testes unitários provam o pattern funciona, mesmo que C8 não esteja fechado.

### Escopo

1. **Quinta mutation tool:** Audit C9 menciona "5 tools" mas lista claramente 4. Investigar se `request-human.tool.ts` também é mutation. **Ação:** Phase 3 confirma a lista.

2. **ADR para mutation-tool unification:** Deve criar ADR-024 ou expandir ADR-018/ADR-007 para nomear o padrão `MutationTool + wrapMutationTool`? **Ação:** Phase 3 inspeciona.

3. **`send-message` como STOP signal:** Após proposal, o ReAct loop para (`:176 react.ts`). Em draft mode, proposta é emitida e loop termina. **Correto.** Sem risco.

## §9. Definition of done

- [ ] **Phase 1 complete:**
  - `src/tools/messaging/send-message.mutation.ts` criado e testado unitariamente
  - `src/tools/messaging/send-message.tool.ts` refatorado para usar `wrapMutationTool`
  - Testes unitários passam: `npm test -- send-message`
  - Verificação: `npm run build` sem erros (TypeScript compile)

- [ ] **Phase 2 complete:**
  - Testes integration validam: `manual_assisted` → proposal, `autonomous_supervised` → executa
  - `extractProposal()` funciona conforme esperado
  - `/complete` final contém `proposals[]` quando em draft mode
  - Suite completa passa: `npm test`

- [ ] **Phase 3 complete:**
  - Documentação de migration path publicada
  - Issues backlog criadas para as 4 tools restantes (com esforço, @mentions)
  - Confirmada quinta mutation tool (ou atualizada documentação com lista correta)
  - Code review aprovado (para Phase 1 + 2 conjuntamente)

- [ ] **Audit finding C9 POC closed:**
  - Uma tool (send-message) adota `MutationTool` pattern
  - Padrão foi provado estar correto
  - Caminho de migração documentado
  - Nenhuma regressão em testes existentes

## §10. References

- **Audit:** `docs/audits/runtime-gap-audit-2026-06-02.md` § C9 (linhas 151–161) + C10 (linhas 163–171)
- **Issue:** bernardTavares/bevox-harness#33 (C9: executeOrPropose unification — migrate 1 tool from ToolDefinition to MutationTool)
- **Related ADRs:**
  - ADR-006: Execution modes (autonomous_supervised, manual_assisted, copilot)
  - ADR-007: AISuggestion workflow (human approval)
  - ADR-018: Mutation tool execution (3-option analysis, Opção C chosen)
  - ADR-023: Idempotency (Idempotency-Key header)
- **Prior POC:** PR #44 (create-appointment migration)
- **Precedent spec:** `docs/superpowers/specs/2026-05-15-hitl-rejection-retry-aprendizado-continuo-design.md` (similar structure)
- **Relevant files:**
  - `src/tools/_shared/mutation-tool.ts` (base class + bridge)
  - `src/tools/messaging/send-message.tool.ts` (current implementation)
  - `src/tools/calendar/create-appointment.{tool,mutation}.ts` (POC reference)
  - `src/runtime/execution-handler.ts` (integration point: extractProposal, proposals[])
  - `tests/unit/tools/_shared/mutation-tool-bridge.test.ts` (existing bridge tests)
