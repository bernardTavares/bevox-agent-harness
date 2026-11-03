# Mutation Tool Rollout + Content-Derived Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all 4 remaining mutation tools (`send-message`, `cancel-appointment`, `reschedule-appointment`, `waitlist-add`) to the `MutationTool` + `wrapMutationTool` pattern so they propose-not-execute in draft modes (closes audit C9), give them content-derived sha256 `Idempotency-Key` keys, fix the `react.synthesize()` `response_text` nesting bug, and thread idempotency keys into all 6 `sendComplete` call-sites discriminated by terminal outcome (closes audit C10).

**Architecture:** Three phases. Phase 1 hardens the shared `MutationTool` base: moves `MutationPreconditionError` into the shared module, makes `executeOrPropose` honor `err.code`, and rewrites `deriveIdempotencyKey` to `sha256(execution_id:step_index:tool_name:canonical(params))` with a new `canonicalize()` helper; it also fixes `react.synthesize()` to read the response text from the `data.*` level of the `ToolResult` envelope. Phase 2 migrates the 4 tools using one identical recipe (each becomes a thin `.tool.ts` wrapper over a `.mutation.ts` business-logic class that throws `MutationPreconditionError` for typed error codes and passes `params` to `deriveIdempotencyKey`). Phase 3 threads `Idempotency-Key` into the 6 `sendComplete` sites via a `completeKey()` helper keyed by terminal outcome, fixes the PERM-03 audit "proposed" label, and corrects two rule files.

**Tech Stack:** Node.js 20, TypeScript 5.9 (ESM/NodeNext — all relative imports use `.js` extensions), Vitest 4. `npm run build` = `tsc`; `npm test` = `vitest run`. Run a single file with `npm test -- <path-or-substring>`.

**Branch & coordination:**
- This is **Track B, Plan 1 of 2**. Run it in its own git worktree on branch `mutation-stack`, in parallel with the context-builder track.
- The ONLY file shared with the other track is `src/runtime/execution-handler.ts`, edited in **different regions**: this plan touches the 6 `sendComplete` sites (`:286`, `:398`, `:1132`, `:1237`, `:1573`, `:1674`) and the PERM-03 audit block (`~:1465-1484`); the other track touches context wiring. A small textual merge is expected; no semantic conflict.
- The follow-on **UNIFY plan** (registry consolidation, runs AFTER this one on the same track) will **delete the thin `.tool.ts` wrappers** this plan creates but **preserves the `.mutation.ts` business logic**. So the `.mutation.ts` files produced here are the durable artifact — keep their logic complete and self-contained.
- **Honest audit status this plan records:** unlike either source spec alone, this merged plan **fully closes C9** (all 5 mutation tools propose in draft mode: `create-appointment` already done in #44, plus the 4 here) and **fully closes C10** (content-derived sha256 keys on all mutations + the 6 callbacks).

---

## File Structure

**Modified (Phase 1):**
- `src/tools/_shared/mutation-tool.ts` — add `MutationPreconditionError`, `canonicalize()`; honor `err.code` in catch; rewrite `deriveIdempotencyKey` (instance + static) to sha256 + `params`.
- `src/tools/calendar/create-appointment.mutation.ts` — import `MutationPreconditionError` from shared (re-export for compat); pass `params` to `deriveIdempotencyKey`.
- `src/reasoning/react.ts` — fix `synthesize()` to read `data.*` + add proposal branch.
- `tests/unit/tools/_shared/mutation-tool-idempotency.test.ts` — rewrite for sha256.
- `tests/unit/tools/create-appointment.test.ts` — update 2 tests (typed codes now surface).
- `tests/unit/reasoning/react.test.ts` — add `data.*` extraction cases.

**Created (Phase 2):**
- `src/tools/messaging/send-message.mutation.ts` + rewritten `src/tools/messaging/send-message.tool.ts`.
- `src/tools/calendar/cancel-appointment.mutation.ts` + rewritten `cancel-appointment.tool.ts`.
- `src/tools/calendar/reschedule-appointment.mutation.ts` + rewritten `reschedule-appointment.tool.ts`.
- `src/tools/calendar/waitlist-add.mutation.ts` + rewritten `waitlist-add.tool.ts`.
- `tests/unit/tools/messaging/send-message.mutation.test.ts` (new).
- Updated: `tests/unit/tools/send-message.test.ts`, `cancel-appointment.test.ts`, `reschedule-appointment.test.ts`, `waitlist-add.test.ts`.

**Modified (Phase 3):**
- `src/runtime/execution-handler.ts` — `completeKey()` helper, 6 `sendComplete` sites, PERM-03 audit label.
- `tests/unit/integration/idempotency-key-headers.test.ts` — extend with `completeKey` discrimination + sha256 format checks.
- `.claude/rules/harness-tools.md` — fix idempotency formula.
- `.claude/rules/harness-payload.md` — mark C8 LANDED.

---

## Phase 1 — Harden the MutationTool base + fix response_text

### Task 1: Add `canonicalize()` to the shared module

**Files:**
- Modify: `src/tools/_shared/mutation-tool.ts`
- Test: `tests/unit/tools/_shared/mutation-tool-idempotency.test.ts`

- [ ] **Step 1: Write the failing test** — replace the ENTIRE contents of `tests/unit/tools/_shared/mutation-tool-idempotency.test.ts` with the sha256-based suite (the old plaintext suite is now wrong):

```typescript
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import {
  MutationTool,
  canonicalize,
  type ToolContext,
} from "../../../../src/tools/_shared/mutation-tool.js";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

describe("canonicalize", () => {
  it("orders object keys lexicographically (insertion order irrelevant)", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("orders keys recursively in nested objects", () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe(
      canonicalize({ outer: { a: 2, z: 1 } }),
    );
  });

  it("preserves array order (semantically meaningful)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("serializes primitives and null via JSON.stringify", () => {
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(null)).toBe("null");
  });
});

describe("MutationTool.deriveIdempotencyKey (static, sha256 + params)", () => {
  const ctx: ToolContext = {
    execution_id: "01234567-89ab-7000-8000-000000000001",
    organization_id: "01234567-89ab-7000-8000-000000000002",
    step_index: 3,
  };

  it("produces sha256-hex of `execution_id:step_index:tool_name:canonical(params)`", () => {
    const params = { calendar_id: "cal-1" };
    const expected = sha256Hex(
      `${ctx.execution_id}:3:create-appointment:${canonicalize(params)}`,
    );
    const key = MutationTool.deriveIdempotencyKey(ctx, "create-appointment", params);
    expect(key).toBe(expected);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input → same key", () => {
    const params = { a: 1 };
    expect(MutationTool.deriveIdempotencyKey(ctx, "send-message", params)).toBe(
      MutationTool.deriveIdempotencyKey(ctx, "send-message", params),
    );
  });

  it("param key ORDER is irrelevant (canonicalize)", () => {
    expect(
      MutationTool.deriveIdempotencyKey(ctx, "create-appointment", { b: 1, a: 2 }),
    ).toBe(MutationTool.deriveIdempotencyKey(ctx, "create-appointment", { a: 2, b: 1 }));
  });

  it("DISTINCT params → DISTINCT keys (regression: lost-mutation bug)", () => {
    expect(
      MutationTool.deriveIdempotencyKey(ctx, "create-appointment", { date: "A" }),
    ).not.toBe(MutationTool.deriveIdempotencyKey(ctx, "create-appointment", { date: "B" }));
  });

  it("step_index absent vs 0 → same key (degenerate pin)", () => {
    const withZero: ToolContext = { ...ctx, step_index: 0 };
    const without: ToolContext = {
      execution_id: ctx.execution_id,
      organization_id: ctx.organization_id,
    };
    expect(MutationTool.deriveIdempotencyKey(withZero, "x", {})).toBe(
      MutationTool.deriveIdempotencyKey(without, "x", {}),
    );
  });

  it("matches the backend regex ^[A-Za-z0-9._\\-:/=+]{1,128}$", () => {
    const key = MutationTool.deriveIdempotencyKey(ctx, "x", { a: 1 });
    expect(key).toMatch(/^[A-Za-z0-9._\-:/=+]{1,128}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mutation-tool-idempotency`
Expected: FAIL — `canonicalize` is not exported; `deriveIdempotencyKey` does not accept a 3rd `params` arg / still returns plaintext.

- [ ] **Step 3: Write minimal implementation** — in `src/tools/_shared/mutation-tool.ts`, add the crypto import at the top of the import block (after the existing `import type` lines):

```typescript
import { createHash } from "node:crypto";
```

Then add the exported `canonicalize` helper immediately **above** the `export abstract class MutationTool` declaration:

```typescript
/**
 * Canonicalização determinística (chaves ordenadas recursivamente) para
 * `canonical(params)` do ADR-015. Mesmo shape de params → mesma string,
 * independente da ordem de inserção. Segue o precedente de
 * `src/integration/llm/request-hasher.ts:22`.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}
```

Now replace the instance + static `deriveIdempotencyKey` methods (currently lines ~112-130) with the content-derived versions. Replace this exact block:

```typescript
  protected deriveIdempotencyKey(context: ToolContext): string {
    return MutationTool.deriveIdempotencyKey(context, this.name);
  }

  /**
   * Helper estático — fórmula canônica `harness:${execution_id}:${step}:${name}`.
   *
   * Determinístico por construção: mesma execução + mesmo step + mesmo nome
   * de operação produz a mesma chave. Permite que retries BullMQ do mesmo
   * step não dupliquem side-effects no backend / calendar service
   * (ADR-023 / PRD §13.3).
   *
   * `step` cai para `0` quando não fornecido — útil para call-sites
   * pré-threading (ex: o único `sendComplete` por execução).
   */
  static deriveIdempotencyKey(context: ToolContext, operationName: string): string {
    const step = context.step_index ?? 0;
    return `harness:${context.execution_id}:${step}:${operationName}`;
  }
```

with:

```typescript
  protected deriveIdempotencyKey(context: ToolContext, params: unknown): string {
    return MutationTool.deriveIdempotencyKey(context, this.name, params);
  }

  /**
   * Chave canônica ADR-015 (bevox-backend/ADR-015, renumerado do hub ADR-023):
   *   sha256(`${execution_id}:${step_index}:${tool_name}:${canonical(params)}`)
   *
   * `step_index` cai para 0 (degenerado): no domínio de mutações de
   * calendário do harness, params idênticos ⇒ duplicata genuína (dedup
   * correto), e params distintos ⇒ chaves distintas. Logo a posição do step
   * não acrescenta distinção e o conteúdo (params) é o discriminador.
   * Determinística e trajectory-independent: a MESMA operação lógica produz
   * a MESMA chave em qualquer retry (BullMQ após-throw, Reflexion in-process).
   * Saída: 64-char hex — passa o regex opaco do backend.
   */
  static deriveIdempotencyKey(
    context: ToolContext,
    operationName: string,
    params: unknown,
  ): string {
    const step = context.step_index ?? 0;
    const raw = `${context.execution_id}:${step}:${operationName}:${canonicalize(params)}`;
    return createHash("sha256").update(raw).digest("hex");
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- mutation-tool-idempotency`
Expected: PASS (all `canonicalize` + `deriveIdempotencyKey` cases green).

- [ ] **Step 5: Commit**

```bash
git add src/tools/_shared/mutation-tool.ts tests/unit/tools/_shared/mutation-tool-idempotency.test.ts
git commit -m "feat(tools): content-derived sha256 idempotency keys via canonicalize (C10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Move `MutationPreconditionError` into the shared module + honor `err.code`

**Files:**
- Modify: `src/tools/_shared/mutation-tool.ts`
- Modify: `src/tools/calendar/create-appointment.mutation.ts`
- Test: `tests/unit/tools/_shared/mutation-tool-bridge.test.ts` (add one case)

- [ ] **Step 1: Write the failing test** — append this `describe` block to the END of `tests/unit/tools/_shared/mutation-tool-bridge.test.ts` (the file already imports `MutationTool`, `wrapMutationTool`, `type ToolContext`; add `MutationPreconditionError` to that import). First update the import to:

```typescript
import {
  MutationTool,
  MutationPreconditionError,
  extractProposal,
  wrapMutationTool,
  type ToolContext,
} from "../../../../src/tools/_shared/mutation-tool.js";
```

Then append:

```typescript
describe("executeOrPropose honors MutationPreconditionError.code (§4.2.b)", () => {
  interface PParams {
    ok: boolean;
  }
  class TypedErrorMutation extends MutationTool<PParams, { done: true }> {
    readonly name = "typed-error";
    readonly action = "typed-error";
    async execute(params: PParams): Promise<{ done: true }> {
      if (!params.ok) {
        throw new MutationPreconditionError("INVALID_PARAMS", "ok is required");
      }
      return { done: true };
    }
  }

  it("preserves the typed code in autonomous mode (not E_TOOL_BACKEND_5XX)", async () => {
    const m = new TypedErrorMutation();
    const ctx: ToolContext = { execution_id: "e1", organization_id: "o1" };
    const outcome = await m.executeOrPropose({ ok: false }, ctx, "autonomous_supervised");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INVALID_PARAMS");
      expect(outcome.error.message).toBe("ok is required");
    }
  });

  it("generic (non-typed) errors still collapse to E_TOOL_BACKEND_5XX", async () => {
    class GenericFail extends MutationTool<PParams, { done: true }> {
      readonly name = "generic-fail";
      readonly action = "generic-fail";
      async execute(): Promise<{ done: true }> {
        throw new Error("network 503");
      }
    }
    const ctx: ToolContext = { execution_id: "e1", organization_id: "o1" };
    const outcome = await new GenericFail().executeOrPropose(
      { ok: true },
      ctx,
      "autonomous_supervised",
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("E_TOOL_BACKEND_5XX");
      expect(outcome.error.message).toContain("503");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mutation-tool-bridge`
Expected: FAIL — `MutationPreconditionError` is not exported from `mutation-tool.js`; the typed-code test fails because the catch hardcodes `E_TOOL_BACKEND_5XX`.

- [ ] **Step 3: Write minimal implementation** — in `src/tools/_shared/mutation-tool.ts`, add the `MutationPreconditionError` class immediately **above** the `canonicalize` function (so it is defined before the class uses it in the catch):

```typescript
/**
 * Erro estruturado que `executeOrPropose` captura e converte em
 * `{ ok: false, error: { code, message } }`, preservando o `code` tipado
 * (ex: INVALID_PARAMS, RATE_LIMITED) em vez de colapsar para
 * `E_TOOL_BACKEND_5XX`. Subclasses de `MutationTool` lançam isto em
 * pré-condições (validação de params, rate-limit). Movida para cá do
 * `create-appointment.mutation.ts` (§4.2.a) para reuso pelas 4 mutation
 * tools migradas.
 */
export class MutationPreconditionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MutationPreconditionError";
  }
}
```

Then replace the catch block inside `executeOrPropose` (currently lines ~85-93). Replace this exact block:

```typescript
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: {
            code: "E_TOOL_BACKEND_5XX",
            message,
          },
        };
      }
```

with:

```typescript
      } catch (err) {
        // Honra códigos tipados de pré-condição (INVALID_PARAMS,
        // RATE_LIMITED) — sem isto o catch colapsava tudo em
        // E_TOOL_BACKEND_5XX, matando os códigos legados (§4.2.b).
        const code = err instanceof MutationPreconditionError ? err.code : "E_TOOL_BACKEND_5XX";
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: {
            code,
            message,
          },
        };
      }
```

Now in `src/tools/calendar/create-appointment.mutation.ts`, delete the local `MutationPreconditionError` class definition (lines ~41-56, the JSDoc + the `export class MutationPreconditionError extends Error {...}` block) and update the import line so it pulls the error from shared and re-exports it for backward compatibility. Replace this exact line:

```typescript
import { MutationTool, type ToolContext } from "../_shared/mutation-tool.js";
```

with:

```typescript
import { MutationTool, MutationPreconditionError, type ToolContext } from "../_shared/mutation-tool.js";

// Re-export para retrocompat: a definição canônica agora vive no shared
// `mutation-tool.ts` (§4.2.a). Importadores existentes continuam válidos.
export { MutationPreconditionError };
```

(Delete the entire JSDoc comment block + `export class MutationPreconditionError ...` that sat between the import and `export class CreateAppointmentMutation`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- mutation-tool-bridge`
Expected: PASS — both new cases green; existing bridge cases still pass (generic throw still maps to `E_TOOL_BACKEND_5XX`).

- [ ] **Step 5: Commit**

```bash
git add src/tools/_shared/mutation-tool.ts src/tools/calendar/create-appointment.mutation.ts tests/unit/tools/_shared/mutation-tool-bridge.test.ts
git commit -m "feat(tools): move MutationPreconditionError to shared + honor err.code in executeOrPropose (C9 §4.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pass `params` to `deriveIdempotencyKey` in create-appointment + fix the now-typed tests

**Files:**
- Modify: `src/tools/calendar/create-appointment.mutation.ts`
- Modify: `tests/unit/tools/create-appointment.test.ts`
- Modify: `tests/unit/tools/calendar/create-appointment.mutation.test.ts`

> **Why the test edits:** Task 1 changed the key format (plaintext → sha256), and Task 2 made the catch honor `err.code`. Two existing assertions in `create-appointment.test.ts` (INVALID_PARAMS, RATE_LIMITED) currently expect `E_TOOL_BACKEND_5XX` and one assertion in `create-appointment.mutation.test.ts` expects the plaintext `harness:...` key. Those become wrong now and MUST be updated. (The MUT spec's "blast radius verified" note only inspected `.mutation.test.ts`'s backend-5xx case — it missed these.)

- [ ] **Step 1: Write the failing test** — update `tests/unit/tools/create-appointment.test.ts`. Replace the body of the test `"returns precondition error when required field is missing (post-EM-03 bridge)"` (lines ~31-41) so it now asserts the typed code surfaces:

```typescript
  it("returns INVALID_PARAMS when required field is missing (typed code now preserved)", async () => {
    // Post §4.2.b: executeOrPropose honra MutationPreconditionError.code,
    // então INVALID_PARAMS chega ao result.error em vez de colapsar para 5xx.
    const result = await createAppointmentTool.execute({ calendar_id: "cal-1" }, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(result.detail).toContain("required");
  });
```

Replace the body of the test `"returns RATE_LIMITED when limiter denies (via MutationPreconditionError)"` (lines ~89-104) so it asserts the typed code:

```typescript
  it("returns RATE_LIMITED when limiter denies (typed code now preserved)", async () => {
    // Post §4.2.b: o RATE_LIMITED do MutationPreconditionError sobrevive ao
    // catch de executeOrPropose. O calendar-client NÃO é chamado.
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 60_000 }),
    } as unknown as RateLimiter);
    const result = await createAppointmentTool.execute(validParams, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("RATE_LIMITED");
    expect(result.detail).toContain("Rate limit exceeded");
    expect(calendarClient.createAppointment).not.toHaveBeenCalled();
  });
```

Now update the idempotency-key assertions in `tests/unit/tools/calendar/create-appointment.mutation.test.ts`. At the top, add this import:

```typescript
import { canonicalize } from "../../../../src/tools/_shared/mutation-tool.js";
import { createHash } from "node:crypto";
```

In the test `"autonomous_supervised → executa de fato + injeta Idempotency-Key"`, replace the final assertion (line ~71):

```typescript
    expect(headers["Idempotency-Key"]).toBe("harness:exec-poc-1:2:create-appointment");
```

with:

```typescript
    const expectedKey = createHash("sha256")
      .update(`exec-poc-1:2:create-appointment:${canonicalize(params)}`)
      .digest("hex");
    expect(headers["Idempotency-Key"]).toBe(expectedKey);
```

In the test `"step_index ausente cai para 0 (sendComplete-style call-site)"`, replace the final assertion (line ~136):

```typescript
    expect(headers["Idempotency-Key"]).toBe("harness:exec-no-step:0:create-appointment");
```

with:

```typescript
    const expectedKey = createHash("sha256")
      .update(`exec-no-step:0:create-appointment:${canonicalize(params)}`)
      .digest("hex");
    expect(headers["Idempotency-Key"]).toBe(expectedKey);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- create-appointment`
Expected: FAIL — `create-appointment.mutation.ts` still calls `this.deriveIdempotencyKey(context)` (1 arg), which no longer compiles against the new 2-arg instance signature; tests also fail on key mismatch.

- [ ] **Step 3: Write minimal implementation** — in `src/tools/calendar/create-appointment.mutation.ts`, update the `deriveIdempotencyKey` call (line ~104). Replace:

```typescript
    const idempotencyKey = this.deriveIdempotencyKey(context);
```

with:

```typescript
    const idempotencyKey = this.deriveIdempotencyKey(context, params);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- create-appointment`
Expected: PASS — both unit suites green; typed codes surface; sha256 keys match.

- [ ] **Step 5: Commit**

```bash
git add src/tools/calendar/create-appointment.mutation.ts tests/unit/tools/create-appointment.test.ts tests/unit/tools/calendar/create-appointment.mutation.test.ts
git commit -m "feat(tools): thread params into create-appointment idempotency key; surface typed codes (C9/C10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Fix `react.synthesize()` response_text nesting + proposal branch

**Files:**
- Modify: `src/reasoning/react.ts`
- Test: `tests/unit/reasoning/react.test.ts`

> **The bug:** `synthesize()` reads `out.message` where `out` is the FULL `ToolResult` envelope `{success, data:{message}}` — so `out.message` is always `undefined` and `response_text` falls back to the JSON envelope. The fix reads from `out.data.message` (tolerating the legacy unwrapped shape via `?? out`) and adds a proposal branch so a drafted `send-message` emits the drafted text.

- [ ] **Step 1: Write the failing test** — append these cases to the `describe('ReactEngine', ...)` block in `tests/unit/reasoning/react.test.ts` (just before the closing `});` of the describe). They use the REAL wrapped `ToolResult` shape, not the legacy unwrapped mocks:

```typescript
  it("synthesize() reads response_text from data.message (real wrapped ToolResult, autonomous)", async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan("g", makeContext());
    const obs: Observation[] = [
      {
        stepIndex: 0,
        summary: '{"success":true,"data":{"sent":true,"message":"olá cliente"}}',
        success: true,
        raw: {
          stepIndex: 0,
          success: true,
          toolName: "send-message",
          toolOutput: { success: true, data: { sent: true, message: "olá cliente" } },
          durationMs: 1,
        },
        stopSignal: true,
      },
    ];
    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe("olá cliente");
  });

  it("synthesize() reads response_text from data.proposal.params.message (draft send-message)", async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan("g", makeContext());
    const obs: Observation[] = [
      {
        stepIndex: 0,
        summary: "envelope",
        success: true,
        raw: {
          stepIndex: 0,
          success: true,
          toolName: "send-message",
          toolOutput: {
            success: true,
            data: { proposal: { action: "send-message", params: { message: "texto rascunhado" } } },
          },
          durationMs: 1,
        },
        stopSignal: true,
      },
    ];
    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe("texto rascunhado");
  });

  it("synthesize() returns empty string for request-human handoff (data.handoff)", async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan("g", makeContext());
    const obs: Observation[] = [
      {
        stepIndex: 0,
        summary: '{"success":true,"data":{"handoff":true}}',
        success: true,
        raw: {
          stepIndex: 0,
          success: true,
          toolName: "request-human",
          toolOutput: { success: true, data: { handoff: true } },
          durationMs: 1,
        },
        stopSignal: true,
      },
    ];
    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe("");
  });

  it("synthesize() tolerates legacy unwrapped shape (data.* absent → top-level message)", async () => {
    const engine = new ReactEngine();
    const plan = await engine.plan("g", makeContext());
    const obs: Observation[] = [
      {
        stepIndex: 0,
        summary: "legacy",
        success: true,
        raw: {
          stepIndex: 0,
          success: true,
          toolName: "send-message",
          toolOutput: { message: "legacy unwrapped" },
          durationMs: 1,
        },
        stopSignal: true,
      },
    ];
    const resp = await engine.synthesize(obs, plan, makeContext());
    expect(resp.answer).toBe("legacy unwrapped");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- react.test`
Expected: FAIL — the autonomous case returns the JSON envelope (not `"olá cliente"`), and the draft-proposal case is not handled.

- [ ] **Step 3: Write minimal implementation** — in `src/reasoning/react.ts`, replace the response-text extraction block inside `synthesize()` (currently lines ~234-247). Replace this exact block:

```typescript
    let answer = "";
    if (stopObs && stopObs.raw && typeof stopObs.raw === "object") {
      const raw = stopObs.raw as { toolOutput?: unknown };
      const out = raw.toolOutput;
      if (out && typeof out === "object") {
        // send-message → use a mensagem real (não o envelope `{sent:true}`)
        const msg = (out as { message?: unknown }).message;
        if (typeof msg === "string" && msg.length > 0) answer = msg;
        // request-human → resposta canônica é vazia (handoff sem texto pro cliente);
        // o `strategy: "request-human"` já carrega a semântica.
        else if ((out as { handoff?: unknown }).handoff === true) answer = "";
      }
    }
    if (!answer) answer = final?.summary ?? "";
```

with:

```typescript
    let answer = "";
    if (stopObs && stopObs.raw && typeof stopObs.raw === "object") {
      const out = (stopObs.raw as { toolOutput?: unknown }).toolOutput;
      if (out && typeof out === "object") {
        // O executor entrega o ToolResult COMPLETO `{success, data}`; os
        // campos canônicos das STOP tools (message/handoff/proposal) ficam
        // sob `.data`. Tolera também o shape desembrulhado (mocks legados)
        // via `?? out`. Sem isto, `response_text` saía como envelope JSON
        // cru — auditoria CRÍT #6 / §2.1.
        const payload = ((out as { data?: unknown }).data ?? out) as {
          message?: unknown;
          handoff?: unknown;
          proposal?: { params?: { message?: unknown } };
        };
        if (typeof payload.message === "string" && payload.message.length > 0) {
          answer = payload.message; // send-message executado (autonomous)
        } else if (payload.handoff === true) {
          answer = ""; // request-human → response_text vazio (semântica no strategy)
        } else if (typeof payload.proposal?.params?.message === "string") {
          answer = payload.proposal.params.message; // send-message PROPOSTO (draft)
        }
      }
    }
    if (!answer) answer = final?.summary ?? "";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- react.test`
Expected: PASS — all 4 new cases green; the pre-existing `synthesize()` cases (which use `summary`-only observations) still pass via the `final.summary` fallback.

- [ ] **Step 5: Commit**

```bash
git add src/reasoning/react.ts tests/unit/reasoning/react.test.ts
git commit -m "fix(reasoning): read response_text from data.* level in synthesize + proposal branch (CRÍT §2.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Phase 1 gate — full build + targeted suite

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 2: Run the Phase 1 suite**

Run: `npm test -- mutation-tool create-appointment react`
Expected: PASS — idempotency, bridge, create-appointment (unit + mutation), and react suites all green.

- [ ] **Step 3: Commit (no-op if clean)** — if the build produced no source changes, skip. Otherwise:

```bash
git add -A
git commit -m "chore: phase 1 gate — build clean + targeted suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Migrate all 4 remaining mutation tools

> **Identical recipe for all 4 tools:** create a `.mutation.ts` class extending `MutationTool` that (1) validates params and rate-limits by throwing `MutationPreconditionError` with `INVALID_PARAMS` / `RATE_LIMITED` codes, (2) derives the idempotency key with `this.deriveIdempotencyKey(context, params)`, (3) calls the backend with the key as the last positional arg; then reduce the `.tool.ts` to a thin `wrapMutationTool(...)` wrapper preserving the original metadata. This gives all 4 tools draft-mode proposals (C9) AND content-derived keys (C10) for free.

### Task 6: Migrate `send-message`

**Files:**
- Create: `src/tools/messaging/send-message.mutation.ts`
- Modify: `src/tools/messaging/send-message.tool.ts`
- Create: `tests/unit/tools/messaging/send-message.mutation.test.ts`
- Modify: `tests/unit/tools/send-message.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/unit/tools/messaging/send-message.mutation.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";

import { SendMessageMutation } from "../../../../src/tools/messaging/send-message.mutation.js";
import type { ToolContext } from "../../../../src/tools/_shared/mutation-tool.js";
import { setRateLimiter, type RateLimiter } from "../../../../src/security/rate-limiter.js";

const ctx: ToolContext = { execution_id: "exec-sm-1", organization_id: "org-sm-1" };

describe("SendMessageMutation (C9)", () => {
  afterEach(() => {
    setRateLimiter(null);
  });

  it("autonomous_supervised → executes + returns {ok:true, result:{sent,message}}", async () => {
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "hi" }, ctx, "autonomous_supervised");
    expect(outcome.ok).toBe(true);
    if (outcome.ok && "result" in outcome) {
      expect(outcome.result).toEqual({ sent: true, message: "hi" });
    } else {
      throw new Error("expected ToolResult");
    }
  });

  it("manual_assisted → {ok:true, proposal} without touching execute()", async () => {
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "hi" }, ctx, "manual_assisted");
    expect(outcome.ok).toBe(true);
    if (outcome.ok && "proposal" in outcome) {
      expect(outcome.proposal.action).toBe("send-message");
      expect(outcome.proposal.params).toEqual({ message: "hi" });
    } else {
      throw new Error("expected ToolProposal");
    }
  });

  it("copilot → same as manual_assisted (proposal)", async () => {
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "hi" }, ctx, "copilot");
    expect(outcome.ok).toBe(true);
    expect("proposal" in outcome).toBe(true);
  });

  it("autonomous + empty message → {ok:false, error:{code:'INVALID_PARAMS'}}", async () => {
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "" }, ctx, "autonomous_supervised");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INVALID_PARAMS");
  });

  it("autonomous + rate-limited → {ok:false, error:{code:'RATE_LIMITED'}}", async () => {
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 60_000 }),
    } as unknown as RateLimiter);
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "hi" }, ctx, "autonomous_supervised");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("RATE_LIMITED");
  });
});
```

Also update the existing `tests/unit/tools/send-message.test.ts` to reflect the wrapped shape. Replace the body of the test `"signals success and surfaces the message via data.message"` (the `result.data` assertion stays valid since the bridge wraps `result` into `data`) — it remains correct because `wrapMutationTool` returns `{success:true, data:{sent,message}}`. No change needed there. The INVALID_PARAMS and RATE_LIMITED tests stay valid because the bridge maps `outcome.error.code` to `result.error`. Verify by leaving the file as-is; if it fails, the migration is wrong.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- send-message`
Expected: FAIL — `src/tools/messaging/send-message.mutation.js` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/tools/messaging/send-message.mutation.ts`:

```typescript
/**
 * C9 — `send-message` como `MutationTool` (ADR-006 / ADR-007).
 *
 * STOP tool: o `data.message` desta tool vira o `response_text` do
 * `/complete` (extraído pelo `react.synthesize()`). NÃO chama
 * `sendComplete` — o handler é o único dispatcher. Em draft modes
 * (manual_assisted / copilot) retorna proposal sem efeito.
 */

import { checkRateLimit } from "../_shared/rate-limit.js";
import {
  MutationTool,
  MutationPreconditionError,
  type ToolContext,
} from "../_shared/mutation-tool.js";

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

  async execute(params: SendMessageParams, context: ToolContext): Promise<SendMessageResult> {
    if (!params.message) {
      throw new MutationPreconditionError("INVALID_PARAMS", "message is required");
    }
    // Rate-limit (política `send-message`). Em draft modes nunca roda —
    // executeOrPropose só chama execute() em autonomous_supervised.
    const denied = await checkRateLimit(context.organization_id, "send-message", "send-message");
    if (denied) {
      throw new MutationPreconditionError(
        denied.errorCode ?? denied.error ?? "RATE_LIMITED",
        denied.detail ?? "Rate limit exceeded",
      );
    }
    // NÃO chama sendComplete — `message` é lido pelo synthesize e vira o
    // response_text.
    return { sent: true, message: params.message };
  }
}

export const sendMessageMutation = new SendMessageMutation();
```

Then replace the ENTIRE contents of `src/tools/messaging/send-message.tool.ts`:

```typescript
/**
 * Thin wrapper — sinaliza ao loop de reasoning que uma mensagem final
 * deve ser enviada ao cliente. NÃO dispara `/complete` daqui (o handler
 * é o único dispatcher). É uma STOP tool (`react.ts:stopTools`).
 *
 * C9: migrada para `MutationTool` via `wrapMutationTool` — respeita
 * `executionMode` (draft → proposal) e usa erros tipados
 * (INVALID_PARAMS / RATE_LIMITED) preservados pelo executeOrPropose.
 */

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- send-message`
Expected: PASS — new mutation suite green; existing `send-message.test.ts` (metadata, INVALID_PARAMS, success-data, RATE_LIMITED) still green (the bridge preserves codes + the `{sent,message}` shape).

- [ ] **Step 5: Commit**

```bash
git add src/tools/messaging/send-message.mutation.ts src/tools/messaging/send-message.tool.ts tests/unit/tools/messaging/send-message.mutation.test.ts
git commit -m "feat(tools): migrate send-message to MutationTool pattern (C9, 2/5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Migrate `cancel-appointment`

**Files:**
- Create: `src/tools/calendar/cancel-appointment.mutation.ts`
- Modify: `src/tools/calendar/cancel-appointment.tool.ts`
- Modify: `tests/unit/tools/cancel-appointment.test.ts`

- [ ] **Step 1: Write the failing test** — replace the ENTIRE contents of `tests/unit/tools/cancel-appointment.test.ts`. The migration changes two behaviors: downstream errors now map to `E_TOOL_BACKEND_5XX` (via the base catch, not `CALENDAR_SERVICE_ERROR`), and the call now includes the idempotency key as the 4th positional arg:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cancelAppointmentTool } from "../../../src/tools/calendar/cancel-appointment.tool.js";
import * as calendarClient from "../../../src/integration/calendar-client.js";
import { setRateLimiter, type RateLimiter } from "../../../src/security/rate-limiter.js";
import { makeToolContext } from "../../helpers/tool-context.js";

vi.mock("../../../src/integration/calendar-client");

describe("cancelAppointmentTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    setRateLimiter(null);
  });

  it("declares correct metadata", () => {
    expect(cancelAppointmentTool.name).toBe("cancel-appointment");
    expect(cancelAppointmentTool.category).toBe("calendar");
  });

  it("returns INVALID_PARAMS when appointment_id is missing (typed code)", async () => {
    const result = await cancelAppointmentTool.execute({}, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("cancels appointment successfully + passes idempotency key (4th arg)", async () => {
    vi.mocked(calendarClient.cancelAppointment).mockResolvedValueOnce({ cancelled: true });
    const result = await cancelAppointmentTool.execute(
      { appointment_id: "a-1", reason: "customer request" },
      makeToolContext(),
    );
    expect(result.success).toBe(true);
    const callArgs = vi.mocked(calendarClient.cancelAppointment).mock.calls[0];
    expect(callArgs[0]).toBe("a-1");
    expect(callArgs[1]).toBe("customer request");
    expect(callArgs[2]).toBeUndefined(); // token positional
    expect(callArgs[3]).toMatch(/^[0-9a-f]{64}$/); // sha256 idempotency key
  });

  it("passes empty reason when omitted", async () => {
    vi.mocked(calendarClient.cancelAppointment).mockResolvedValueOnce({ cancelled: true });
    await cancelAppointmentTool.execute({ appointment_id: "a-1" }, makeToolContext());
    expect(vi.mocked(calendarClient.cancelAppointment).mock.calls[0][1]).toBe("");
  });

  it("wraps downstream errors as E_TOOL_BACKEND_5XX (base catch)", async () => {
    vi.mocked(calendarClient.cancelAppointment).mockRejectedValueOnce(new Error("not found"));
    const result = await cancelAppointmentTool.execute(
      { appointment_id: "missing" },
      makeToolContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("E_TOOL_BACKEND_5XX");
    expect(result.detail).toContain("not found");
  });

  it("returns RATE_LIMITED when limiter denies; calendar-client NOT called", async () => {
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 60_000 }),
    } as unknown as RateLimiter);
    const result = await cancelAppointmentTool.execute(
      { appointment_id: "a-1" },
      makeToolContext(),
    );
    expect(result.error).toBe("RATE_LIMITED");
    expect(calendarClient.cancelAppointment).not.toHaveBeenCalled();
  });

  it("manual_assisted → returns proposal, calendar-client NOT called (ADR-006)", async () => {
    const result = await cancelAppointmentTool.execute(
      { appointment_id: "a-1", reason: "x" },
      makeToolContext({ executionMode: "manual_assisted" }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      proposal: { action: "cancel-appointment", params: { appointment_id: "a-1", reason: "x" } },
    });
    expect(calendarClient.cancelAppointment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- cancel-appointment`
Expected: FAIL — `cancel-appointment.mutation.js` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/tools/calendar/cancel-appointment.mutation.ts`:

```typescript
/**
 * C9/C10 — `cancel-appointment` como `MutationTool` (ADR-006 / ADR-015).
 * Em draft modes retorna proposal; em autonomous executa + injeta
 * Idempotency-Key content-derived.
 */

import * as calendarClient from "../../integration/calendar-client.js";
import { checkRateLimit } from "../_shared/rate-limit.js";
import {
  MutationTool,
  MutationPreconditionError,
  type ToolContext,
} from "../_shared/mutation-tool.js";

export interface CancelAppointmentParams {
  appointment_id: string;
  reason?: string;
}

export class CancelAppointmentMutation extends MutationTool<CancelAppointmentParams, unknown> {
  readonly name = "cancel-appointment";
  readonly action = "cancel-appointment";

  async execute(params: CancelAppointmentParams, context: ToolContext): Promise<unknown> {
    if (!params.appointment_id) {
      throw new MutationPreconditionError("INVALID_PARAMS", "appointment_id is required");
    }
    const denied = await checkRateLimit(
      context.organization_id,
      "cancel-appointment",
      "calendar-mutation",
    );
    if (denied) {
      throw new MutationPreconditionError(
        denied.errorCode ?? denied.error ?? "RATE_LIMITED",
        denied.detail ?? "Rate limit exceeded",
      );
    }
    const idempotencyKey = this.deriveIdempotencyKey(context, params);
    return calendarClient.cancelAppointment(
      params.appointment_id,
      params.reason ?? "",
      undefined, // token (posicional)
      idempotencyKey,
    );
  }
}

export const cancelAppointmentMutation = new CancelAppointmentMutation();
```

Then replace the ENTIRE contents of `src/tools/calendar/cancel-appointment.tool.ts`:

```typescript
import { wrapMutationTool } from "../_shared/mutation-tool.js";
import type { ToolDefinition } from "../types.js";

import { cancelAppointmentMutation } from "./cancel-appointment.mutation.js";

export const cancelAppointmentTool: ToolDefinition = wrapMutationTool(cancelAppointmentMutation, {
  description: "Cancel an existing appointment.",
  category: "calendar",
  agentType: "surface",
  parameters: {
    type: "object",
    required: ["appointment_id"],
    properties: {
      appointment_id: { type: "string" },
      reason: { type: "string" },
    },
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- cancel-appointment`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/calendar/cancel-appointment.mutation.ts src/tools/calendar/cancel-appointment.tool.ts tests/unit/tools/cancel-appointment.test.ts
git commit -m "feat(tools): migrate cancel-appointment to MutationTool pattern (C9, 3/5; C10 key)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Migrate `reschedule-appointment`

**Files:**
- Create: `src/tools/calendar/reschedule-appointment.mutation.ts`
- Modify: `src/tools/calendar/reschedule-appointment.tool.ts`
- Modify: `tests/unit/tools/reschedule-appointment.test.ts`

- [ ] **Step 1: Write the failing test** — replace the ENTIRE contents of `tests/unit/tools/reschedule-appointment.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rescheduleAppointmentTool } from "../../../src/tools/calendar/reschedule-appointment.tool.js";
import * as calendarClient from "../../../src/integration/calendar-client.js";
import { setRateLimiter, type RateLimiter } from "../../../src/security/rate-limiter.js";
import { makeToolContext } from "../../helpers/tool-context.js";

vi.mock("../../../src/integration/calendar-client");

const validParams = {
  appointment_id: "a-1",
  new_date: "2026-04-12",
  new_start_time: "14:30",
};

describe("rescheduleAppointmentTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    setRateLimiter(null);
  });

  it("declares correct metadata", () => {
    expect(rescheduleAppointmentTool.name).toBe("reschedule-appointment");
    expect(rescheduleAppointmentTool.category).toBe("calendar");
  });

  it("returns INVALID_PARAMS when any field is missing (typed code)", async () => {
    const r1 = await rescheduleAppointmentTool.execute({}, makeToolContext());
    expect(r1.error).toBe("INVALID_PARAMS");
    const r2 = await rescheduleAppointmentTool.execute(
      { appointment_id: "a-1", new_date: "2026-04-12" },
      makeToolContext(),
    );
    expect(r2.error).toBe("INVALID_PARAMS");
  });

  it("reschedules successfully + passes idempotency key (5th arg)", async () => {
    vi.mocked(calendarClient.rescheduleAppointment).mockResolvedValueOnce({ rescheduled: true });
    const result = await rescheduleAppointmentTool.execute(validParams, makeToolContext());
    expect(result.success).toBe(true);
    const callArgs = vi.mocked(calendarClient.rescheduleAppointment).mock.calls[0];
    expect(callArgs[0]).toBe("a-1");
    expect(callArgs[1]).toBe("2026-04-12");
    expect(callArgs[2]).toBe("14:30");
    expect(callArgs[3]).toBeUndefined(); // token positional
    expect(callArgs[4]).toMatch(/^[0-9a-f]{64}$/); // sha256 idempotency key
  });

  it("wraps downstream errors as E_TOOL_BACKEND_5XX (base catch)", async () => {
    vi.mocked(calendarClient.rescheduleAppointment).mockRejectedValueOnce(new Error("conflict"));
    const result = await rescheduleAppointmentTool.execute(validParams, makeToolContext());
    expect(result.error).toBe("E_TOOL_BACKEND_5XX");
  });

  it("returns RATE_LIMITED when limiter denies; calendar-client NOT called", async () => {
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 60_000 }),
    } as unknown as RateLimiter);
    const result = await rescheduleAppointmentTool.execute(validParams, makeToolContext());
    expect(result.error).toBe("RATE_LIMITED");
    expect(calendarClient.rescheduleAppointment).not.toHaveBeenCalled();
  });

  it("manual_assisted → returns proposal, calendar-client NOT called (ADR-006)", async () => {
    const result = await rescheduleAppointmentTool.execute(
      validParams,
      makeToolContext({ executionMode: "manual_assisted" }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      proposal: { action: "reschedule-appointment", params: validParams },
    });
    expect(calendarClient.rescheduleAppointment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- reschedule-appointment`
Expected: FAIL — `reschedule-appointment.mutation.js` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/tools/calendar/reschedule-appointment.mutation.ts`:

```typescript
/**
 * C9/C10 — `reschedule-appointment` como `MutationTool` (ADR-006 / ADR-015).
 */

import * as calendarClient from "../../integration/calendar-client.js";
import { checkRateLimit } from "../_shared/rate-limit.js";
import {
  MutationTool,
  MutationPreconditionError,
  type ToolContext,
} from "../_shared/mutation-tool.js";

export interface RescheduleAppointmentParams {
  appointment_id: string;
  new_date: string;
  new_start_time: string;
}

export class RescheduleAppointmentMutation extends MutationTool<
  RescheduleAppointmentParams,
  unknown
> {
  readonly name = "reschedule-appointment";
  readonly action = "reschedule-appointment";

  async execute(params: RescheduleAppointmentParams, context: ToolContext): Promise<unknown> {
    if (!params.appointment_id || !params.new_date || !params.new_start_time) {
      throw new MutationPreconditionError(
        "INVALID_PARAMS",
        "appointment_id, new_date, and new_start_time are required",
      );
    }
    const denied = await checkRateLimit(
      context.organization_id,
      "reschedule-appointment",
      "calendar-mutation",
    );
    if (denied) {
      throw new MutationPreconditionError(
        denied.errorCode ?? denied.error ?? "RATE_LIMITED",
        denied.detail ?? "Rate limit exceeded",
      );
    }
    const idempotencyKey = this.deriveIdempotencyKey(context, params);
    return calendarClient.rescheduleAppointment(
      params.appointment_id,
      params.new_date,
      params.new_start_time,
      undefined, // token (posicional)
      idempotencyKey,
    );
  }
}

export const rescheduleAppointmentMutation = new RescheduleAppointmentMutation();
```

Then replace the ENTIRE contents of `src/tools/calendar/reschedule-appointment.tool.ts`:

```typescript
import { wrapMutationTool } from "../_shared/mutation-tool.js";
import type { ToolDefinition } from "../types.js";

import { rescheduleAppointmentMutation } from "./reschedule-appointment.mutation.js";

export const rescheduleAppointmentTool: ToolDefinition = wrapMutationTool(
  rescheduleAppointmentMutation,
  {
    description: "Reschedule an existing appointment to a new date and time.",
    category: "calendar",
    agentType: "surface",
    parameters: {
      type: "object",
      required: ["appointment_id", "new_date", "new_start_time"],
      properties: {
        appointment_id: { type: "string" },
        new_date: { type: "string", description: "ISO date" },
        new_start_time: { type: "string", description: "HH:MM" },
      },
    },
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- reschedule-appointment`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/calendar/reschedule-appointment.mutation.ts src/tools/calendar/reschedule-appointment.tool.ts tests/unit/tools/reschedule-appointment.test.ts
git commit -m "feat(tools): migrate reschedule-appointment to MutationTool pattern (C9, 4/5; C10 key)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Migrate `waitlist-add`

**Files:**
- Create: `src/tools/calendar/waitlist-add.mutation.ts`
- Modify: `src/tools/calendar/waitlist-add.tool.ts`
- Modify: `tests/unit/tools/waitlist-add.test.ts`

> **Note:** the original `waitlist-add.tool.ts` had NO rate-limit call. Preserve that — the migrated mutation does NOT call `checkRateLimit` (matches existing behavior; rate-limit for waitlist is out of scope here). The idempotency key is derived from the full `params` (including the `body` fields), satisfying open question §8.2 — distinct waitlist entries get distinct keys.

- [ ] **Step 1: Write the failing test** — replace the ENTIRE contents of `tests/unit/tools/waitlist-add.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitlistAddTool } from "../../../src/tools/calendar/waitlist-add.tool.js";
import * as calendarClient from "../../../src/integration/calendar-client.js";
import { makeToolContext } from "../../helpers/tool-context.js";

vi.mock("../../../src/integration/calendar-client");

describe("waitlistAddTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("declares correct metadata", () => {
    expect(waitlistAddTool.name).toBe("waitlist-add");
    expect(waitlistAddTool.category).toBe("calendar");
  });

  it("returns INVALID_PARAMS when calendar_id is missing (typed code)", async () => {
    const result = await waitlistAddTool.execute({ customer_name: "Alice" }, makeToolContext());
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns INVALID_PARAMS when customer_name is missing (typed code)", async () => {
    const result = await waitlistAddTool.execute({ calendar_id: "cal-1" }, makeToolContext());
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("adds to waitlist successfully + passes idempotency key (4th arg)", async () => {
    vi.mocked(calendarClient.addToWaitlist).mockResolvedValueOnce({ waitlisted: true });
    const result = await waitlistAddTool.execute(
      {
        calendar_id: "cal-1",
        customer_name: "Alice",
        service_id: "svc-1",
        preferred_date_from: "2026-04-10",
        preferred_date_to: "2026-04-15",
      },
      makeToolContext(),
    );
    expect(result.success).toBe(true);
    const callArgs = vi.mocked(calendarClient.addToWaitlist).mock.calls[0];
    expect(callArgs[0]).toBe("cal-1");
    expect(callArgs[1]).toMatchObject({
      service_id: "svc-1",
      customer_name: "Alice",
      preferred_date_from: "2026-04-10",
      preferred_date_to: "2026-04-15",
    });
    expect(callArgs[2]).toBeUndefined(); // token positional
    expect(callArgs[3]).toMatch(/^[0-9a-f]{64}$/); // sha256 idempotency key
  });

  it("wraps downstream errors as E_TOOL_BACKEND_5XX (base catch)", async () => {
    vi.mocked(calendarClient.addToWaitlist).mockRejectedValueOnce(new Error("500"));
    const result = await waitlistAddTool.execute(
      { calendar_id: "cal-1", customer_name: "Alice" },
      makeToolContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("E_TOOL_BACKEND_5XX");
  });

  it("manual_assisted → returns proposal, calendar-client NOT called (ADR-006)", async () => {
    const result = await waitlistAddTool.execute(
      { calendar_id: "cal-1", customer_name: "Alice" },
      makeToolContext({ executionMode: "manual_assisted" }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      proposal: {
        action: "waitlist-add",
        params: { calendar_id: "cal-1", customer_name: "Alice" },
      },
    });
    expect(calendarClient.addToWaitlist).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- waitlist-add`
Expected: FAIL — `waitlist-add.mutation.js` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/tools/calendar/waitlist-add.mutation.ts`:

```typescript
/**
 * C9/C10 — `waitlist-add` como `MutationTool` (ADR-006 / ADR-015).
 * Preserva o comportamento legado: SEM rate-limit (a tool original não
 * chamava `checkRateLimit`). A chave idempotente é derivada do `params`
 * completo (inclui customer_name + datas) → entradas distintas geram
 * chaves distintas (open question §8.2).
 */

import * as calendarClient from "../../integration/calendar-client.js";
import {
  MutationTool,
  MutationPreconditionError,
  type ToolContext,
} from "../_shared/mutation-tool.js";

export interface WaitlistAddParams {
  calendar_id: string;
  service_id?: string;
  customer_name: string;
  preferred_date_from?: string;
  preferred_date_to?: string;
}

export class WaitlistAddMutation extends MutationTool<WaitlistAddParams, unknown> {
  readonly name = "waitlist-add";
  readonly action = "waitlist-add";

  async execute(params: WaitlistAddParams, context: ToolContext): Promise<unknown> {
    if (!params.calendar_id || !params.customer_name) {
      throw new MutationPreconditionError(
        "INVALID_PARAMS",
        "calendar_id and customer_name are required",
      );
    }
    const body = {
      service_id: params.service_id,
      customer_name: params.customer_name,
      preferred_date_from: params.preferred_date_from,
      preferred_date_to: params.preferred_date_to,
    };
    const idempotencyKey = this.deriveIdempotencyKey(context, params);
    return calendarClient.addToWaitlist(
      params.calendar_id,
      body,
      undefined, // token (posicional)
      idempotencyKey,
    );
  }
}

export const waitlistAddMutation = new WaitlistAddMutation();
```

Then replace the ENTIRE contents of `src/tools/calendar/waitlist-add.tool.ts`:

```typescript
import { wrapMutationTool } from "../_shared/mutation-tool.js";
import type { ToolDefinition } from "../types.js";

import { waitlistAddMutation } from "./waitlist-add.mutation.js";

export const waitlistAddTool: ToolDefinition = wrapMutationTool(waitlistAddMutation, {
  description: "Add a customer to the waitlist for a calendar.",
  category: "calendar",
  agentType: "surface",
  parameters: {
    type: "object",
    required: ["calendar_id", "customer_name"],
    properties: {
      calendar_id: { type: "string" },
      service_id: { type: "string" },
      customer_name: { type: "string" },
      preferred_date_from: { type: "string", description: "ISO date" },
      preferred_date_to: { type: "string", description: "ISO date" },
    },
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- waitlist-add`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/calendar/waitlist-add.mutation.ts src/tools/calendar/waitlist-add.tool.ts tests/unit/tools/waitlist-add.test.ts
git commit -m "feat(tools): migrate waitlist-add to MutationTool pattern (C9, 5/5 — C9 CLOSED; C10 key)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Phase 2 gate — build + all tool tests

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors. (Confirms the registry imports of the rewritten `.tool.ts` files still resolve.)

- [ ] **Step 2: Run all tool + reasoning tests**

Run: `npm test -- tools reasoning`
Expected: PASS — all 5 mutation tools migrated, all draft/autonomous/error paths green.

- [ ] **Step 3: Commit (no-op if clean)**

```bash
git add -A
git commit -m "chore: phase 2 gate — all 4 remaining mutation tools migrated, suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Phase 3 — Callback idempotency keys + PERM-03 audit + rule files

### Task 11: Add `completeKey()` helper and thread it into the 6 `sendComplete` sites

**Files:**
- Modify: `src/runtime/execution-handler.ts`
- Test: `tests/unit/integration/idempotency-key-headers.test.ts`

> **The 6 sites + their `kind`** (verified line numbers; var names differ by scope):
> - `:286` (Model-C, no agent) → `kind: "request-human"`, vars `executionId`/`executionToken`/`organizationId`
> - `:398` (Model-C success) → `kind: "success"`, vars `executionId`/`executionToken`/`organizationId`
> - `:1132` (main, request-human) → `kind: "request-human"`, vars `execution_id`/`execution_token`/`organizationId`
> - `:1237` (workflow) → `kind: "workflow"`, vars `execution_id`/`execution_token`/`organizationId`
> - `:1573` (main success) → `kind: "success"`, vars `execution_id`/`execution_token`/`organizationId`
> - `:1674` (boundary catch, failed) → `kind: "failed"`, vars `execution_id`/`execution_token`/`organizationId`
>
> The key is keyed by `(execution_id, complete:<kind>)` with empty params — so a retry of the SAME outcome deduplicates, but `failed` never collides with `success`.

- [ ] **Step 1: Write the failing test** — append this `describe` block to `tests/unit/integration/idempotency-key-headers.test.ts`. It pins the discrimination contract via the public static helper that `completeKey` wraps:

```typescript
import { MutationTool } from "../../../src/tools/_shared/mutation-tool.js";

describe("sendComplete idempotency key discriminated by terminal outcome", () => {
  const exec = "exec-term-1";
  const org = "org-term-1";
  const makeKey = (kind: string) =>
    MutationTool.deriveIdempotencyKey(
      { execution_id: exec, organization_id: org },
      `complete:${kind}`,
      {},
    );

  it("success and failed derive DISTINCT keys (no cross-outcome dedup)", () => {
    expect(makeKey("success")).not.toBe(makeKey("failed"));
  });

  it("request-human and workflow derive DISTINCT keys", () => {
    expect(makeKey("request-human")).not.toBe(makeKey("workflow"));
  });

  it("same outcome → SAME key (retry of same terminal state deduplicates)", () => {
    expect(makeKey("success")).toBe(makeKey("success"));
  });

  it("the complete key is sha256-hex (passes backend regex)", () => {
    expect(makeKey("success")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- idempotency-key-headers`
Expected: the 4 new cases PASS already (they only exercise the static helper, which Task 1 delivered). This step is a contract guard — if any fail, Task 1 regressed. Proceed to wire the handler.

- [ ] **Step 3: Write minimal implementation** — in `src/runtime/execution-handler.ts`, add the `completeKey` helper. Place it immediately after the `MUTATION_TOOL_NAMES` declaration (after line ~81). First confirm `MutationTool` is imported; the file already imports `extractProposal` from the same module (line 50) — extend that import. Replace:

```typescript
import { extractProposal } from "../tools/_shared/mutation-tool.js";
```

with:

```typescript
import { extractProposal, MutationTool } from "../tools/_shared/mutation-tool.js";
```

Then add the helper after the `MUTATION_TOOL_NAMES` set:

```typescript
/**
 * C10 — chave idempotente para o callback `/complete`, discriminada por
 * DESFECHO terminal (não pelo conteúdo do payload, que é volátil entre
 * retries). `params = {}` → estável; só `complete:<kind>` discrimina.
 * Assim um retry do MESMO desfecho deduplica, mas `failed` nunca colide
 * com `success`. Defense-in-depth atrás do Redis dedup + replied-marker.
 */
function completeKey(executionId: string, organizationId: string, kind: string): string {
  return MutationTool.deriveIdempotencyKey(
    { execution_id: executionId, organization_id: organizationId },
    `complete:${kind}`,
    {},
  );
}
```

Now thread the key into each of the 6 sites by adding a 4th argument to each `sendComplete(...)` call.

Site `:286` (Model-C request-human) — replace:

```typescript
    await sendComplete(
      executionId,
      executionToken,
      buildCompletePayload({
        responseText: "",
        sentiment: "neutral",
        strategy: "request-human",
      }),
    );
```

with:

```typescript
    await sendComplete(
      executionId,
      executionToken,
      buildCompletePayload({
        responseText: "",
        sentiment: "neutral",
        strategy: "request-human",
      }),
      completeKey(executionId, organizationId, "request-human"),
    );
```

Site `:398` (Model-C success) — replace:

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

with:

```typescript
    await sendComplete(
      executionId,
      executionToken,
      buildCompletePayload({
        responseText: agentResponse.answer,
        sentiment: "neutral",
        strategy: agentResponse.strategy,
      }),
      completeKey(executionId, organizationId, "success"),
    );
```

Site `:1132` (main request-human) — replace:

```typescript
          await sendComplete(
            execution_id,
            execution_token,
            buildCompletePayload({
              responseText: "",
              sentiment: analyzerOutput.sentiment,
              strategy: "request-human",
            }),
          );
```

with:

```typescript
          await sendComplete(
            execution_id,
            execution_token,
            buildCompletePayload({
              responseText: "",
              sentiment: analyzerOutput.sentiment,
              strategy: "request-human",
            }),
            completeKey(execution_id, organizationId, "request-human"),
          );
```

Site `:1237` (workflow) — replace:

```typescript
          await sendComplete(
            execution_id,
            execution_token,
            mapWorkflowResultToCallback(wfResult, analyzerOutput.sentiment),
          );
```

with:

```typescript
          await sendComplete(
            execution_id,
            execution_token,
            mapWorkflowResultToCallback(wfResult, analyzerOutput.sentiment),
            completeKey(execution_id, organizationId, "workflow"),
          );
```

Site `:1573` (main success, inside `withSpan`) — replace:

```typescript
        await withSpan("execution.callback.complete", { "execution.id": execution_id }, async () =>
          sendComplete(
            execution_id,
            execution_token,
            buildCompletePayload({
              responseText: agentResponse.answer,
              sentiment: analyzerOutput.sentiment,
              strategy: agentResponse.strategy,
              usage: finalUsage,
              proposals: proposalsAccumulator,
            }),
          ),
        );
```

with:

```typescript
        await withSpan("execution.callback.complete", { "execution.id": execution_id }, async () =>
          sendComplete(
            execution_id,
            execution_token,
            buildCompletePayload({
              responseText: agentResponse.answer,
              sentiment: analyzerOutput.sentiment,
              strategy: agentResponse.strategy,
              usage: finalUsage,
              proposals: proposalsAccumulator,
            }),
            completeKey(execution_id, organizationId, "success"),
          ),
        );
```

Site `:1674` (boundary catch, failed) — replace:

```typescript
        await sendComplete(
          execution_id,
          execution_token,
          buildCompletePayload({ responseText: "", sentiment: "neutral", strategy: "failed" }),
        ).catch((callbackErr) => {
          logger.warn({ callbackErr }, "Failed to send error /complete callback");
        });
```

with:

```typescript
        await sendComplete(
          execution_id,
          execution_token,
          buildCompletePayload({ responseText: "", sentiment: "neutral", strategy: "failed" }),
          completeKey(execution_id, organizationId, "failed"),
        ).catch((callbackErr) => {
          logger.warn({ callbackErr }, "Failed to send error /complete callback");
        });
```

- [ ] **Step 4: Run test to verify it passes + build**

Run: `npm run build && npm test -- idempotency-key-headers`
Expected: build exits 0 (the 6 sites compile with the 4th arg; `organizationId` is in scope at every site — `:843` const for the main path, function param for Model-C); tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts tests/unit/integration/idempotency-key-headers.test.ts
git commit -m "feat(callback): thread outcome-discriminated idempotency keys into 6 sendComplete sites (C10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: PERM-03 audit — label drafted send-message as "proposed", not "escalation success"

**Files:**
- Modify: `src/runtime/execution-handler.ts`

> **The bug (MUT §4.5):** the audit block at `~:1465-1484` runs BEFORE `extractProposal`. In draft mode a drafted `send-message` returns `success:true`, so the audit currently records `escalation` + `result:"success"` for a message that was never sent. Fix: detect the proposal and record `result:"proposed"` with `actionType:"proposal"`.

- [ ] **Step 1: Write the implementation** — this audit path is fire-and-forget and asserting on it requires the heavy DB integration harness; we verify by build + reading the diff (the integration suite under `permission-audit.integration.test.ts` is gated by `RUN_INTEGRATION=1`). In `src/runtime/execution-handler.ts`, the audit block currently reads (lines ~1465-1484):

```typescript
          if (MUTATION_TOOL_NAMES.has(tool.name)) {
            const sanitizedParams =
              resolvedParams !== null && typeof resolvedParams === "object"
                ? sanitizeAuditDetails(resolvedParams as Record<string, unknown>)
                : {};
            emitExecutionAudit({
              executionId: execution_id,
              organizationId,
              agentName: agentDef.name,
              toolName: tool.name,
              actionType: tool.name === "send-message" ? "escalation" : "mutation_execution",
              actionDetails: {
                tool_category: tool.category,
                parameters: sanitizedParams,
                latency_ms: Date.now() - tStart,
              },
              result: result.success ? "success" : "failure",
              errorMessage: result.success ? undefined : result.error,
            });
          }
```

Replace it with (compute the proposal first so the audit can branch on it):

```typescript
          if (MUTATION_TOOL_NAMES.has(tool.name)) {
            const sanitizedParams =
              resolvedParams !== null && typeof resolvedParams === "object"
                ? sanitizeAuditDetails(resolvedParams as Record<string, unknown>)
                : {};
            // §4.5: em draft mode a tool retorna success:true com um proposal
            // (efeito NÃO aplicado). Rotular como "proposed" para o trail não
            // afirmar envio/mutação. `isProposal` reusado pelo hoist abaixo.
            const auditProposal = extractProposal(result);
            const isProposal = auditProposal !== undefined;
            emitExecutionAudit({
              executionId: execution_id,
              organizationId,
              agentName: agentDef.name,
              toolName: tool.name,
              actionType: isProposal
                ? "proposal"
                : tool.name === "send-message"
                  ? "escalation"
                  : "mutation_execution",
              actionDetails: {
                tool_category: tool.category,
                parameters: sanitizedParams,
                latency_ms: Date.now() - tStart,
              },
              result: isProposal ? "proposed" : result.success ? "success" : "failure",
              errorMessage: result.success ? undefined : result.error,
            });
          }
```

Then update the hoist block right below it (lines ~1486-1496) to reuse the already-computed proposal instead of calling `extractProposal` a second time. Replace:

```typescript
          // EM-03 POC (issue #44): hoist proposta para o acumulador.
          // `extractProposal` retorna `undefined` para results
          // convencionais — zero-cost no caminho autonomous_supervised.
          const proposal = extractProposal(result);
          if (proposal !== undefined) {
            proposalsAccumulator.push(proposal);
            logger.info(
              { execution_id, toolName: tool.name, action: proposal.action },
              "EM-03: proposal captured (draft mode) — will be emitted in /complete.proposals[]",
            );
          }
```

with:

```typescript
          // EM-03 POC (issue #44): hoist proposta para o acumulador.
          // `extractProposal` retorna `undefined` para results
          // convencionais — zero-cost no caminho autonomous_supervised.
          // Reusa o resultado já computado no bloco de auditoria acima.
          const proposal =
            MUTATION_TOOL_NAMES.has(tool.name) ? extractProposal(result) : undefined;
          if (proposal !== undefined) {
            proposalsAccumulator.push(proposal);
            logger.info(
              { execution_id, toolName: tool.name, action: proposal.action },
              "EM-03: proposal captured (draft mode) — will be emitted in /complete.proposals[]",
            );
          }
```

> **Note:** all 5 mutation tools are in `MUTATION_TOOL_NAMES`, so gating the hoist on that set does not lose any proposals — only mutation tools can produce one. This keeps the autonomous path byte-identical (no `extractProposal` call for non-mutation tools, same as before).

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: exits 0. (`emitExecutionAudit` accepts string `actionType`/`result`; `"proposal"`/`"proposed"` are additive labels.)

- [ ] **Step 3: Verify the `actionType`/`result` field types accept the new labels** — confirm `emitExecutionAudit`'s param type does not restrict to a closed enum.

Run: `grep -n "actionType\|result" src/security/execution-audit.ts | head`
Expected: `actionType` and `result` typed as `string` (open). If they are a closed union missing `"proposal"`/`"proposed"`, add those members to the union in `src/security/execution-audit.ts` and re-run `npm run build` until clean.

- [ ] **Step 4: Run the handler-adjacent suite**

Run: `npm test -- execution-handler`
Expected: PASS (no unit-level handler tests assert the old `"escalation"/"success"` draft label; if one does, update it to expect `"proposal"/"proposed"` for the draft case).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts src/security/execution-audit.ts
git commit -m "fix(audit): label drafted send-message as proposed, not escalation success (PERM-03 §4.5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Confirm the Model-C `executeTool` path hoists proposals

**Files:**
- Modify: `src/runtime/execution-handler.ts`

> **The gap (MUT §4.6):** there are two `executeTool` closures. The main one (`~:1390`) calls `extractProposal` and pushes to `proposalsAccumulator`. The Model-C one (`~:337-351`) just returns `tool.execute(...)` — it has NO accumulator and NO `extractProposal`. If a mutation tool routes through Model-C in a draft mode, its proposal is silently dropped (and never reaches `/complete.proposals[]`). Add a Model-C accumulator + hoist + serialize it in the Model-C success `sendComplete`.

- [ ] **Step 1: Write the implementation** — in the Model-C dispatch (`_dispatchModelCImpl`), add a proposals accumulator just before the `executeTool` closure (currently at `~:336`). Insert immediately above `const executeTool: ToolExecutor = ...`:

```typescript
  // §4.6: Model-C precisa do mesmo hoist de propostas que o caminho main.
  // Sem isto, uma mutation tool em draft mode roteada por Model-C perderia
  // sua proposta (nunca chegaria a /complete.proposals[]).
  const mcProposals: Array<{ action: string; params: unknown }> = [];
```

Then update the Model-C `executeTool` closure body. Replace:

```typescript
    return tool.execute(params, toolContext);
  };
```

with:

```typescript
    const result = await tool.execute(params, toolContext);
    if (MUTATION_TOOL_NAMES.has(toolName)) {
      const proposal = extractProposal(result);
      if (proposal !== undefined) {
        mcProposals.push(proposal);
        logger.info(
          { executionId: agentContext.executionId, toolName, action: proposal.action },
          "EM-03 (Model-C): proposal captured (draft mode) — emitting in /complete.proposals[]",
        );
      }
    }
    return result;
  };
```

Then serialize the accumulator in the Model-C success `sendComplete` (the `:398` site, already updated in Task 11). Replace:

```typescript
    await sendComplete(
      executionId,
      executionToken,
      buildCompletePayload({
        responseText: agentResponse.answer,
        sentiment: "neutral",
        strategy: agentResponse.strategy,
      }),
      completeKey(executionId, organizationId, "success"),
    );
```

with:

```typescript
    await sendComplete(
      executionId,
      executionToken,
      buildCompletePayload({
        responseText: agentResponse.answer,
        sentiment: "neutral",
        strategy: agentResponse.strategy,
        proposals: mcProposals,
      }),
      completeKey(executionId, organizationId, "success"),
    );
```

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: exits 0. (`buildCompletePayload` omits `proposals` when the array is empty, so the autonomous Model-C path stays byte-identical.)

- [ ] **Step 3: Run the handler suite**

Run: `npm test -- execution-handler`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "fix(runtime): hoist proposals on the Model-C executeTool path (C9 §4.6)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Fix the rule files

**Files:**
- Modify: `.claude/rules/harness-tools.md`
- Modify: `.claude/rules/harness-payload.md`

- [ ] **Step 1: Fix the idempotency formula in `harness-tools.md`** — the current line (`:55`) is garbled (3-tuple, no params). Replace this exact block:

```
key = sha256(execution_id + ':' + step_index + ':' + tool_name)
```

with:

```
key = sha256(execution_id : step_index : tool_name : canonical(params))      # ADR-015
# harness: step_index pinned em 0 p/ mutações de calendário (params idênticos = duplicata genuína).
# canonical(params) = JSON com chaves ordenadas recursivamente (ver canonicalize() em mutation-tool.ts).
```

- [ ] **Step 2: Fix the C8 status in `harness-payload.md`** — the file currently says `execution_mode` parsing is "NÃO LANDED". It is LANDED (commit a22de19 / #29). Replace this exact block:

```
- `execution_mode` parseado em runtime: **NÃO LANDED** — schema vivo
  `executionPayloadSchema` usa `.passthrough()` e não declara o campo. Bug
  CRÍT #8 da auditoria (harness/ADR-018 §75/§112 manda obrigatório). Não
  documentar este `execution_mode` como "implementado" até o fix landed.
```

with:

```
- `execution_mode` parseado em runtime: **LANDED** (commit a22de19 / #29) —
  `executionPayloadSchema` declara `ExecutionModeSchema.optional().default("autonomous_supervised")`,
  propagado para `AgentExecutionContext.executionMode` e consumido pelo bridge
  `wrapMutationTool`. C8 fechado.
```

- [ ] **Step 3: Update the `idempotency_key` status in `harness-payload.md`** — the file says idempotency propagation is "NÃO LANDED" (bug CRÍT #10). It is now landed for mutations + callbacks via this plan. Replace this exact block:

```
- `idempotency_key` propagado pras tools de mutação: **NÃO LANDED** —
  bug CRÍT #10. `MutationTool.deriveIdempotencyKey()` existe morto;
  efeito externo duplica em retry.
```

with:

```
- `idempotency_key` content-derived (sha256 + canonical(params), ADR-015)
  nas 5 mutation tools + 6 call-sites de `sendComplete` (discriminado por
  desfecho terminal): **LANDED** (plano mutation-stack, 2026-06-02). C10
  fechado. `deriveIdempotencyKey()` agora recebe `params` e produz sha256.
```

- [ ] **Step 4: Verify no broken references**

Run: `grep -n "NÃO LANDED\|sha256(execution_id + " .claude/rules/harness-tools.md .claude/rules/harness-payload.md`
Expected: no matches for the old garbled formula; the `execution_mode` and `idempotency_key` lines no longer say "NÃO LANDED".

- [ ] **Step 5: Commit**

```bash
git add .claude/rules/harness-tools.md .claude/rules/harness-payload.md
git commit -m "docs(rules): fix idempotency formula (ADR-015) + mark C8/C10 LANDED

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Final gate — full build + full test suite

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 2: Full unit + non-integration suite**

Run: `npm test`
Expected: PASS — no regressions. Integration tests gated by `RUN_INTEGRATION=1` are skipped by default; that is expected.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: exits 0 (or only pre-existing warnings unrelated to the touched files).

- [ ] **Step 4: Confirm C9/C10 closure honestly** — grep that all 5 mutation tool `.tool.ts` files are now thin wrappers over `wrapMutationTool`:

Run: `grep -L "wrapMutationTool" src/tools/calendar/create-appointment.tool.ts src/tools/calendar/cancel-appointment.tool.ts src/tools/calendar/reschedule-appointment.tool.ts src/tools/calendar/waitlist-add.tool.ts src/tools/messaging/send-message.tool.ts`
Expected: NO output (every file contains `wrapMutationTool` → C9 fully closed: all 5 propose in draft mode).

- [ ] **Step 5: Final commit (no-op if clean)**

```bash
git add -A
git commit -m "chore: final gate — C9 + C10 closed; build + suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage (both specs):**

MUT spec:
- §3 P1-a (synthesize `data.*` + proposal branch) → Task 4. ✓
- §3 P1-b / §4.2.a-b (move `MutationPreconditionError` + honor `err.code`) → Task 2. ✓
- §3 P1-c / §4.1 (migrate `send-message` to MutationTool) → Task 6. ✓
- §4.4 (proposalsAccumulator already exists — no structural change) → confirmed via Task 11/12 (left intact). ✓
- §4.5 (PERM-03 audit "proposed") → Task 12. ✓
- §4.6 (dual executeTool — Model-C hoist) → Task 13. ✓
- §5 Phase 3 (rule file `harness-payload.md` C8 LANDED) → Task 14 Step 2. ✓
- MUT non-goal "do not migrate the other 3 tools" → SUPERSEDED by the merge (we DO migrate them, via IDEM); explicitly recorded in Branch & coordination ("fully closes C9"). ✓

IDEM spec:
- §4.1 (`canonicalize()` + sha256 `deriveIdempotencyKey` with `params`) → Task 1. ✓
- §4.2 (`create-appointment.mutation.ts:104` pass `params`) → Task 3. ✓
- §4.3 (migrate cancel/reschedule/waitlist) → Tasks 7, 8, 9 — using `MutationPreconditionError` (the synergy), not plain `Error`. ✓
- §4.4 (`completeKey()` + 6 sites discriminated by kind) → Task 11. ✓
- §4.5 (fix `harness-tools.md:55` formula) → Task 14 Step 1. ✓
- §6 testing: sha256 determinism + canonicalize (Task 1); per-tool inject key + ADR-006 propose (Tasks 7-9); header presence (existing `idempotency-key-headers.test.ts`); outcome discrimination (Task 11). ✓
- IDEM non-goals (do not touch engines / ToolExecutor / calendar-client signatures) → respected; no engine or calendar-client edits. ✓

**2. Placeholder scan:** No "TBD"/"TODO"/"add error handling"/"similar to Task N". Every code step contains full code. The only `grep`-based "verify" steps (Task 12 Step 3, Task 14 Step 4, Task 15 Step 4) include exact commands + expected output + the fix to apply if the expectation is not met. ✓

**3. Type consistency:**
- `canonicalize(value: unknown): string` — defined Task 1, imported in tests Task 3 + Task 11. Consistent. ✓
- `deriveIdempotencyKey(context, operationName, params)` static (3 args) and `(context, params)` instance (2 args) — defined Task 1; instance called in create-appointment (Task 3) + all 4 migrated tools (Tasks 6-9) with `(context, params)`; static called by `completeKey` (Task 11) with `(ctx, "complete:<kind>", {})`. Consistent. ✓
- `MutationPreconditionError(code, message)` — defined Task 2, used in Tasks 6-9. Consistent. ✓
- `completeKey(executionId, organizationId, kind)` — defined Task 11, used at all 6 sites with the correct scope-local var names (`executionId`/`organizationId` in Model-C, `execution_id`/`organizationId` in main). Consistent. ✓
- `extractProposal(result)` — reused (not redefined) in Task 12 (audit) and Task 13 (Model-C hoist). Consistent. ✓
- Tool wrappers all named `<tool>Tool` and mutations `<Tool>Mutation` / `<tool>Mutation` singleton — matches the existing create-appointment convention. ✓

**Issues found & fixed inline during review:**
- The MUT spec claimed §4.2.b "does not break existing tests" but only inspected `create-appointment.mutation.test.ts`. Verifying the real code showed `create-appointment.test.ts` has 2 tests asserting `E_TOOL_BACKEND_5XX` for INVALID_PARAMS/RATE_LIMITED that WILL flip to the typed codes — Task 3 updates them. (Resolved.)
- The IDEM spec's example code for the 3 calendar tools used `throw new Error(...)`; per the merge synergy, Tasks 7-9 use `MutationPreconditionError` with `INVALID_PARAMS`/`RATE_LIMITED` instead. Consequently the existing cancel/reschedule/waitlist tests' `CALENDAR_SERVICE_ERROR` assertions become `E_TOOL_BACKEND_5XX` and `INVALID_PARAMS` — those test files are fully rewritten in Tasks 7-9. (Resolved.)
- `waitlist-add` originally had no `checkRateLimit`; Task 9 preserves that (no rate-limit added). (Resolved.)
