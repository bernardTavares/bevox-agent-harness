# Dead-Letter & Unprocessable-Payload Error Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the dispatch worker from silently discarding unprocessable (Zod-invalid / oversize) payloads as "success" (audit J3); make the **authoritative dead-letter signal a backend callback** (`status='dead_letter'` + `action='retry_exhausted'`) written **once** on attempts-exhaustion of the LIVE producer `attempts:7`; treat poison (`UnrecoverableError`) as non-retryable AND surface it to the same backend signal; keep the retained `failed` set as **forensic-only local retention**; and reconcile the docs that claim a dead-letter queue exists (audit DEBT-05).

**Architecture:** Three phases. **Phase 1** introduces `UnprocessablePayloadError extends UnrecoverableError` (from `bullmq`) so `parseExecutionPayload` throws a type BullMQ short-circuits without retry; rewrites the J3 discard site to **always rethrow** (no silent `return`, no callback emitted here — the `failed` listener owns the dead-letter signal so poison is not double-signalled); and adds a `completeSent` guard + `.catch()` on the post-`/complete` steps so a late Redis hiccup cannot fire a second `/complete`, plus an `Idempotency-Key` on the boundary `failed` callback (both REQUIRED now that `attempts:7` is LIVE). **Phase 2** extends `updateStatus` with an optional 4th `meta` arg (backward-compatible — existing `updateStatus(id, token, "running")` callers untouched); adds the `recordDeadLetter({category})` counter with **3 labels** (`poison` / `retry_exhausted` / `aborted`); sets worker-level **retention** (`removeOnFail`/`removeOnComplete`) + `maxStalledCount: 1` (NOT `attempts`/`backoff` — those are producer-side and silently ignored on a `Worker`); and wires the `worker.on("failed", ...)` listener that writes `status='dead_letter'` on the **final** transient attempt (or salvageable poison), **defensively excluding aborts by error name** (the §8-open-#11 ordering gate, since J8/op-execution-bounding is NOT merged on `main`). **Phase 3** reconciles the rule + architecture docs, emits the `execution.late_completion` forensic log, and records the cross-repo / founder gates the spec leaves open.

**Tech Stack:** Node.js 20, TypeScript 5.9 (ESM/NodeNext — all relative imports use `.js` extensions), Vitest 4, BullMQ 5 (installed: **5.76.9** — verified). `UnrecoverableError` is exported from the package root (`import { UnrecoverableError } from "bullmq"`, verified importable + an `Error` subclass) and the retry short-circuit at `node_modules/bullmq/dist/cjs/classes/job.js:486` honors `err instanceof UnrecoverableError || err.name == 'UnrecoverableError'` (verified). `npm run build` = `tsc` (+ copy-skill-manifests); `npm run typecheck` = `tsc --noEmit`; gate on `npm run test:unit` (`vitest run tests/unit`) — **NEVER** `test:integration` (the `RUN_INTEGRATION` suite) as a gate. New tests live under `tests/**` (vitest only runs `tests/**/*.test.ts`; do NOT co-locate under `src/`).

---

## Scope & coordination notes

- **PIVOT (2026-06-03): the authoritative dead-letter is a BACKEND state, not the retained `failed` set.** The staff-ops replay UI is keyed on `status='dead_letter'` (built-and-waiting, currently written by nobody). The harness writes it via an **extended `updateStatus(id, token, status, meta?)`** from the `worker.on("failed")` listener on the **final** `attempts:7` attempt. The retained `failed` set (`removeOnFail.age`) is re-scoped from "the DLQ" to **forensic / Redis-down-fallback local retention** only. No dedicated `bevox.harness.dead-letter` queue is introduced — deferred to v2 (spec §3.1 Option C).
- **`attempts:7` is LIVE (producer-side).** The orchestration-service enqueues with `attempts: 7`, exponential backoff (~635s window), queue `bevox.execution.dispatch`, `jobId = execution_id`. The harness is **consumer-only** on this queue, so it does NOT add a `HARNESS_DISPATCH_ATTEMPTS` env and does NOT enable retry (it was already enabled by the producer). Because retry is LIVE, the double-`/complete` guard (Task 3) and the boundary `Idempotency-Key` are **mandatory now**, not hypothetical.
- **`MutationTool.deriveIdempotencyKey` is the live 2-arg plaintext form** `harness:${execution_id}:${step}:${name}` (`src/tools/_shared/mutation-tool.ts:127-130`, verified static; instance form is 1-arg `:112-113`). The separate *mutation-tool-rollout-idempotency* plan rewrites it to sha256 + `params` (3-arg) but **that has NOT landed**. This plan uses the **current 2-arg static form** in every `deriveIdempotencyKey` call (matching spec §4.2 / §4.3). Do NOT pre-emptively add a `params` arg here.
- **Idempotency-Key threading is incomplete (CRIT #10, spec §8 open #7).** Only `create-appointment` threads a key into its mutation. This plan threads keys into the boundary/post-complete `/complete` calls and the dead-letter signal, but does **NOT** thread keys into the other 4 mutation tools — that is the separate mutation-tool plan's job. Spec §8 open #5 (backend `/complete` last-write-wins contract) and #7 are **blocking-now** given `attempts:7` is LIVE, but are cross-repo/cross-spec dependencies outside this spec's edit surface; Task 14 records them, this plan does not close them.
- **§8 open #11 — ORDERING GATE (SRE adversarial, 2026-06-03).** J8 (op-execution-bounding) is **NOT merged on `main`** (verified: no `ExecutionAbortError`, no abort path; `runWithTimeout` at `:738` only `reject`s; the boundary `:1662-1698` does `throw err`). So **today a wall-clock timeout RETHROWS and would reach the `failed` listener**, and on the final `attempts:7` attempt would be misclassified as `retry_exhausted` → write `status='dead_letter'` for an *expected* abort. This plan therefore implements **defensive classification by error name** in the listener (`err.name === "ExecutionAbortError"` → `category="aborted"`, never `retry_exhausted`, never write `dead_letter`) so the spec is robust regardless of merge order. The merge-gate (land J8 first) remains the preferred belt; the defensive classify is the suspenders — Task 8 implements the suspenders and Task 14 records the belt.
- **Redis-down asterisk (spec §8 risk 7).** The `failed` set lives in Redis (local retention). If Redis is down at throw time the local retention evaporates — but the **authoritative** dead-letter (`status='dead_letter'`) is written over **HTTP** (`updateStatus`), independent of Redis. Graceful degradation is genuine but not guaranteed: the `updateStatus` call is `.catch()`-guarded with a warn, and the harness cannot guarantee the signal lands — the backend cron `bevox.timeout.scan` reconciliation is the backstop. Documented in Phase 3.
- **Replay-dedup hazard (spec §8 risk 10 / §d1).** Staff replay mints a NEW `execution_id`, so the `execution_id`-derived idempotency key does NOT dedup appointment mutations on replay → duplicate side-effects. The fix (`original_execution_id` lineage) lands in PR #59 (idempotency-key-full-threading). **GATE:** replay of appointment mutations must stay BLOCKED until that lineage lands; send-message replay is covered today by the content-keyed replied-marker. Task 14 records the gate; this plan does not implement lineage.

---

## File Structure

**Modified (Phase 1):**
- `src/runtime/execution-handler.ts` — add `UnrecoverableError` import from `bullmq` (after the `zod` import at `:3`); add `UnprocessablePayloadError` class + `salvageSchema` + `salvageIdToken()` near `parseExecutionPayload` (`:566-575`); rewrite `parseExecutionPayload` to throw the typed error (oversize + Zod, via `safeParse`); rewrite the J3 catch (`:835-841`) to **rethrow** (no callback here); add `completeSent` flag (declared above the wrapping `try {` at `:1047`) + `.catch()` guard on the post-`/complete` clean-up (`:1647-1651`) and a `completeSent` check + `Idempotency-Key` on the boundary `failed` callback (`:1673-1680`). Extend the existing `import { extractProposal } from "../tools/_shared/mutation-tool.js"` (`:50`) to also import `MutationTool` + the `ToolContext` type.

**Created (Phase 1 tests):**
- `tests/unit/runtime/execution-handler.j3.test.ts` — J3 rethrow + no-callback-here + no-double-complete after success.

**Modified (Phase 1 tests):**
- `tests/unit/runtime/execution-handler.payload.test.ts` — assert `instanceof UnprocessablePayloadError`/`UnrecoverableError` + salvage population.

**Created (Phase 2):**
- `src/observability/dead-letter-metrics.ts` — `recordDeadLetter({category})` counter (3 labels) + `getDeadLetterCounts()` / `resetDeadLetterCounts()` accessors (in-memory + log; no new dependency).

**Modified (Phase 2):**
- `src/integration/bevox-callback.ts:116-123` — extend `updateStatus` with an optional 4th `meta` arg (`StatusMeta`); `idempotencyKey` → header via `post`, rest → body. Backward-compatible.
- `src/config/env.ts:24` — `HARNESS_DISPATCH_FAILED_RETENTION_S`.
- `src/config/harness-config.ts` (harness block) — surface the env.
- `src/integration/bullmq-consumer.ts:14-43` — retention options + `maxStalledCount: 1` + async `failed` listener (dead-letter signal + defensive abort classify + `recordDeadLetter`); new imports.
- `tests/unit/integration/bullmq-consumer.test.ts` — extend the `vi.mock("bullmq")` to re-export `UnrecoverableError`; mock `updateStatus` + `recordDeadLetter`; assert options + listener + poison rethrow + dead-letter signal + abort exclusion.

**Created (Phase 2 tests):**
- `tests/unit/observability/dead-letter-metrics.test.ts` — counter increments by category label.

**Modified (Phase 3):**
- `.claude/rules/harness-payload.md:76-77` — rewrite (level 50 ERROR; retained `failed` set = local; backend `status='dead_letter'` = authoritative; no `bevox.harness.dead-letter`).
- `docs/architecture/fluxo-de-execucao.md:11,310` — "DLQ" → "retenção local + `status='dead_letter'` no backend".
- `docs/architecture/evals.md:173` — clarify the "No DLQ" line is scoped to evals.
- `src/runtime/execution-handler.ts` — emit `execution.late_completion` log when a job completes past its own deadline (§4.6b forensic signal).

---

## Phase 1 — Poison vs transient + J3 fail-loudly + double-`/complete` guard

### Task 1: Add `UnprocessablePayloadError` + `salvageIdToken`, make `parseExecutionPayload` throw it

**Files:**
- Modify: `src/runtime/execution-handler.ts` (import block `:1-3`; near `parseExecutionPayload` `:566-575`)
- Test: `tests/unit/runtime/execution-handler.payload.test.ts`

- [ ] **Step 1: Write the failing test** — first extend the import at the top of `tests/unit/runtime/execution-handler.payload.test.ts`. Replace this exact block (`:1-5`):

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseExecutionPayload,
  MAX_PAYLOAD_BYTES,
  MAX_MESSAGE_LENGTH } from
```

with:

```typescript
import { describe, it, expect } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  parseExecutionPayload,
  UnprocessablePayloadError,
  MAX_PAYLOAD_BYTES,
  MAX_MESSAGE_LENGTH } from
```

Then append these cases inside the `describe('parseExecutionPayload', ...)` block, just before its final closing `});`:

```typescript
  it('throws UnprocessablePayloadError (an UnrecoverableError) on Zod-invalid payload', () => {
    let caught: unknown;
    try {
      parseExecutionPayload({ ...validBase(), execution_id: 'not-a-uuid' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnprocessablePayloadError);
    expect(caught).toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnprocessablePayloadError on oversize payload', () => {
    const huge = { ...validBase(), context: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) } };
    let caught: unknown;
    try {
      parseExecutionPayload(huge);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnprocessablePayloadError);
  });

  it('salvages execution_id + execution_token when both pass the strict bounds', () => {
    // Shape-invalid (bad messages role) but id+token individually valid → salvageable.
    const bad = { ...validBase(), messages: [{ role: 'nope', content: 'x' }] };
    let caught: UnprocessablePayloadError | undefined;
    try {
      parseExecutionPayload(bad);
    } catch (err) {
      caught = err as UnprocessablePayloadError;
    }
    expect(caught?.executionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(caught?.executionToken).toBe('a-very-long-token-string-1234567890');
  });

  it('does NOT salvage when execution_id is junk (no notify possible)', () => {
    const bad = { ...validBase(), execution_id: 'not-a-uuid' };
    let caught: UnprocessablePayloadError | undefined;
    try {
      parseExecutionPayload(bad);
    } catch (err) {
      caught = err as UnprocessablePayloadError;
    }
    expect(caught?.executionId).toBeUndefined();
    expect(caught?.executionToken).toBeUndefined();
  });

  it('does NOT salvage on oversize (id/token untrusted — never validated)', () => {
    const huge = { ...validBase(), context: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) } };
    let caught: UnprocessablePayloadError | undefined;
    try {
      parseExecutionPayload(huge);
    } catch (err) {
      caught = err as UnprocessablePayloadError;
    }
    expect(caught?.executionId).toBeUndefined();
  });
```

> **Fixture note (verified):** the existing `validBase()` helper (`:10-18`) already uses `execution_token: 'a-very-long-token-string-1234567890'` (35 chars, ≥20) and `execution_id: '11111111-1111-4111-8111-111111111111'` (valid uuid) — so the salvage assertions match without touching the helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- execution-handler.payload`
Expected: FAIL — `UnprocessablePayloadError` is not exported; the new `instanceof` cases cannot resolve the class.

- [ ] **Step 3: Write minimal implementation** — in `src/runtime/execution-handler.ts`, add the `bullmq` import. The first three lines are `ioredis`, `pg`, `zod`. After line 3 (`import { z } from "zod";`) insert:

```typescript
import { UnrecoverableError } from "bullmq";
```

Then replace the existing `parseExecutionPayload` block (`:566-575`). Replace this exact block:

```typescript
export function parseExecutionPayload(raw: unknown): ExecutionPayload {
  const json = JSON.stringify(raw);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload exceeds ${MAX_PAYLOAD_BYTES} bytes (got ${byteLength})`);
  }
  return executionPayloadSchema.parse(raw);
}

export { executionPayloadSchema };
```

with:

```typescript
/**
 * J3 — payload que o harness NUNCA conseguirá processar (oversize ou
 * Zod-inválido). Distinto de erros transientes do handler: re-tentar um
 * payload poison é um loop garantido — e com `attempts: 7` LIVE no
 * produtor seria um retry-storm 7x.
 *
 * ESTENDE `UnrecoverableError` do BullMQ (NÃO `Error`): o BullMQ honra
 * `err instanceof UnrecoverableError || err.name == 'UnrecoverableError'`
 * (verificado em `bullmq@5.76.9` `classes/job.js:486`) e move o job direto
 * pro `failed` set sem re-tentar, INDEPENDENTE de `attempts`. Sem
 * dependência da API `discard()` (deprecated + síncrona/void no 5.76.9).
 *
 * Carrega o execution_id/token quando recuperáveis de um payload
 * parcialmente válido, para o sinal dead-letter best-effort (§4.3).
 */
export class UnprocessablePayloadError extends UnrecoverableError {
  readonly nonRetryable = true as const;
  readonly executionId?: string;
  readonly executionToken?: string;
  constructor(message: string, salvage?: { executionId?: string; executionToken?: string }) {
    super(message);
    this.name = "UnprocessablePayloadError";
    this.executionId = salvage?.executionId;
    this.executionToken = salvage?.executionToken;
  }
}

// Revalida ISOLADAMENTE apenas os dois campos de auth, com os mesmos bounds
// do schema vivo (execution_id uuid `:517`, execution_token 20..512 `:518`),
// para nunca propagar token-lixo no header X-Execution-Token (risco §8.3).
const salvageSchema = z.object({
  execution_id: z.string().uuid(),
  execution_token: z.string().min(20).max(512),
});

function salvageIdToken(raw: unknown): { executionId?: string; executionToken?: string } {
  // safeParse (não .parse): evita uma segunda exceção dentro do path de erro;
  // retorna {} quando id/token não são confiáveis → sem sinal (comportamento
  // seguro do risco §8.3).
  const r = salvageSchema.safeParse(raw);
  if (!r.success) return {};
  return { executionId: r.data.execution_id, executionToken: r.data.execution_token };
}

/**
 * Validates payload size (UTF-8 byte length of the JSON encoding) and shape.
 * Em violação lança `UnprocessablePayloadError` (poison). Oversize NÃO faz
 * salvage (id/token nunca validados); Zod-inválido faz salvage best-effort.
 */
export function parseExecutionPayload(raw: unknown): ExecutionPayload {
  const json = JSON.stringify(raw);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_PAYLOAD_BYTES) {
    throw new UnprocessablePayloadError(
      `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes (got ${byteLength})`,
    );
  }
  const result = executionPayloadSchema.safeParse(raw);
  if (!result.success) {
    const salvage = salvageIdToken(raw);
    throw new UnprocessablePayloadError(
      `Invalid dispatch payload: ${result.error.message}`,
      salvage,
    );
  }
  return result.data;
}

export { executionPayloadSchema };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- execution-handler.payload`
Expected: PASS — all new cases green; the pre-existing `toThrow()` cases still pass (the typed error is a thrown `Error` subclass, and the oversize `.toThrow(/exceeds.*bytes/)` regex still matches the message).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts tests/unit/runtime/execution-handler.payload.test.ts
git commit -m "feat(runtime): typed UnprocessablePayloadError for poison payloads (J3 §4.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: J3 — rethrow instead of silent return (no callback here; the failed listener owns the signal)

**Files:**
- Modify: `src/runtime/execution-handler.ts` (import `:50`; J3 catch `:835-841`)
- Test: `tests/unit/runtime/execution-handler.j3.test.ts` (new)

> **Pivot vs. the old plan:** the J3 catch no longer emits any callback. Poison salvageable id/token live on the `UnprocessablePayloadError` and are read by the `worker.on("failed")` listener (Task 8), which writes `status='dead_letter'` ONCE — emitting `sendComplete(failed)` here too would (a) be invisible to the replay UI and (b) double-signal. So J3 just **rethrows**. The listener does the salvage → dead-letter.

- [ ] **Step 1: Write the failing test** — create `tests/unit/runtime/execution-handler.j3.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted callback mock — mirrors execution-handler.flow.test.ts. `updateStatus`
// is included because the dead-letter signal path uses it (no-op here; J3
// rethrows before any callback in the handler itself).
const callbackMock = vi.hoisted(() => ({
  updateStatus: vi.fn().mockResolvedValue(undefined),
  sendComplete: vi.fn().mockResolvedValue(undefined),
  sendTrace: vi.fn().mockResolvedValue(undefined),
  sendStream: vi.fn().mockResolvedValue(undefined),
  buildCompletePayload: (opts: {
    responseText: string;
    sentiment?: string;
    strategy?: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
    proposals?: unknown[];
  }) => ({
    response_text: opts.responseText,
    sentiment: opts.sentiment ?? "neutral",
    strategy: opts.strategy ?? "direct",
    usage: opts.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
  }),
}));

vi.mock("../../../src/integration/bevox-callback", () => callbackMock);

import { handleExecution, UnprocessablePayloadError } from "../../../src/runtime/execution-handler.js";

const VALID_TOKEN = "a-very-long-token-value-1234567890";

describe("handleExecution — J3 unprocessable payload", () => {
  beforeEach(() => {
    callbackMock.sendComplete.mockClear();
    callbackMock.updateStatus.mockClear();
  });

  const ctx = {} as never; // J3 fails before ctx.redis is ever touched

  it("rethrows (does NOT silently return) on Zod-invalid payload", async () => {
    await expect(
      handleExecution({ execution_id: "not-a-uuid" }, ctx),
    ).rejects.toBeInstanceOf(UnprocessablePayloadError);
  });

  it("rethrows on oversize payload too", async () => {
    const huge = {
      execution_id: "11111111-1111-4111-8111-111111111111",
      execution_token: VALID_TOKEN,
      organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      messages: [{ role: "user", content: "x".repeat(300 * 1024) }],
    };
    await expect(handleExecution(huge, ctx)).rejects.toBeInstanceOf(UnprocessablePayloadError);
  });

  it("does NOT emit any callback from the handler on poison (the failed listener owns the signal)", async () => {
    // Valid id+token, but shape-invalid elsewhere (messages role bad) → salvage
    // lives on the error; the handler must NOT call sendComplete/updateStatus.
    const poison = {
      execution_id: "11111111-1111-4111-8111-111111111111",
      execution_token: VALID_TOKEN,
      organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      messages: [{ role: "nope", content: "x" }],
    };
    let caught: UnprocessablePayloadError | undefined;
    await handleExecution(poison, ctx).catch((err) => {
      caught = err as UnprocessablePayloadError;
    });
    // Salvage is carried on the thrown error for the failed listener to use.
    expect(caught?.executionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(caught?.executionToken).toBe(VALID_TOKEN);
    // But NO callback is emitted from inside the handler.
    expect(callbackMock.sendComplete).not.toHaveBeenCalled();
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- execution-handler.j3`
Expected: FAIL — the current handler silently `return`s on parse failure (`:840`), so `rejects` does not fire.

- [ ] **Step 3: Write minimal implementation** — in `src/runtime/execution-handler.ts`, first extend the mutation-tool import (`:50`). Replace:

```typescript
import { extractProposal } from "../tools/_shared/mutation-tool.js";
```

with:

```typescript
import { extractProposal, MutationTool } from "../tools/_shared/mutation-tool.js";
import type { ToolContext } from "../tools/_shared/mutation-tool.js";
```

Then replace the J3 catch block (`:835-841`). Replace this exact block:

```typescript
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Invalid dispatch payload",
    );
    return;
  }
```

with:

```typescript
  } catch (err) {
    if (err instanceof UnprocessablePayloadError) {
      logger.error(
        { jobErr: err.message, hasSalvage: Boolean(err.executionId) },
        "Unprocessable dispatch payload (poison) — rethrowing to failed set + dead_letter signal",
      );
      // §4.2/§b: NÃO emitir callback aqui. O salvage (id/token) viaja no
      // UnprocessablePayloadError e é lido pelo `worker.on("failed")` listener
      // (Task 8), que escreve `status='dead_letter'` UMA vez. Emitir
      // sendComplete(failed) aqui seria invisível à replay UI (não seta
      // dead_letter) e duplicaria o sinal.
    }
    // SEMPRE relança: o worker marca o job `failed` (UnrecoverableError → sem
    // retry-storm 7x) em vez de `completed`; o failed listener escreve o sinal.
    throw err;
  }
```

> **Imports note:** `MutationTool` + the `ToolContext` type are imported here for Task 3's idempotency keys (used at the success/boundary sites). They are not used inside the J3 catch.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- execution-handler.j3`
Expected: PASS — rethrow fires for both Zod-invalid and oversize; the salvage is carried on the error; no callback is emitted from the handler.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts tests/unit/runtime/execution-handler.j3.test.ts
git commit -m "feat(runtime): J3 rethrow on poison payload; salvage carried for failed listener (§4.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Double-`/complete` guard — `completeSent` flag + `.catch()` on post-complete clean-up + boundary key

**Files:**
- Modify: `src/runtime/execution-handler.ts` (wrapping `try {` `:1047`; success `:1572-1584`; clean-up `:1647-1651`; boundary `:1673-1680`)
- Test: `tests/unit/runtime/execution-handler.j3.test.ts` (add a case)

> **The latent bug (spec §4.2b), now ACTIVE because `attempts:7` is LIVE:** after the happy-path `sendComplete(success)` at `:1572-1584`, the post-complete steps (hooks `:1590`, memory enqueue `:1604-1645`, `sessionStore.update({status:"completed"})` `:1648-1651`) run inside the SAME `try` (opened at `:1047`). The clean-up session update is NOT `.catch()`-guarded — a Redis hiccup there throws, lands in the boundary catch `:1662`, and fires a SECOND `sendComplete(strategy:"failed")` for an execution the backend already saw succeed. Fix: a `completeSent` flag the boundary checks before emitting `failed`, AND wrap the genuinely off-hot-path clean-up in `.catch()`. The boundary `failed` callback also gets an `Idempotency-Key` (spec §4.2b mitigation 2) so a producer-side retry's `/complete(failed)` is last-write-wins by `execution_id`. (Verified: `organizationId` is in scope at both `:1572` and `:1662` — declared at `:843`.)

- [ ] **Step 1: Write the failing test** — append a NEW `describe` to the END of `tests/unit/runtime/execution-handler.j3.test.ts` that drives a full execution. First add these imports just below the existing `import { handleExecution, ... }` line:

```typescript
import { createFakeRedis } from "../../fakes/redis.fake.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { BaseAgent } from "../../../src/agents/base-agent.js";
import type { AgentDefinition, AgentResult } from "../../../src/agents/types.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { Pool } from "pg";
```

Then append:

```typescript
class StubAnalyzer extends BaseAgent {
  constructor() {
    super({
      name: "message-analyzer",
      type: "pipeline",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    } as AgentDefinition);
  }
  async execute(): Promise<AgentResult> {
    return {
      success: true,
      output: { intent: "scheduling", sentiment: "neutral", topics: [], urgency: "low" },
    };
  }
}
class StubSurface extends BaseAgent {
  constructor() {
    super({
      name: "scheduler",
      type: "surface",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    } as AgentDefinition);
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return { success: true, output: "ok" };
  }
}

describe("handleExecution — no double /complete after success (§4.2b)", () => {
  beforeEach(() => {
    callbackMock.sendComplete.mockClear();
    (AgentRegistry as unknown as { instance?: unknown }).instance = undefined;
    (ToolRegistry as unknown as { instance?: unknown }).instance = undefined;
  });

  it("a throw in a post-complete step does NOT emit a second failed callback after a success", async () => {
    const agentRegistry = AgentRegistry.getInstance();
    agentRegistry.register(new StubAnalyzer());
    agentRegistry.register(new StubSurface());
    const toolRegistry = ToolRegistry.getInstance();

    const redis = createFakeRedis();
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;

    const ctx = {
      db,
      redis,
      agentRegistry,
      toolRegistry,
    } as unknown as Parameters<typeof handleExecution>[1];

    const payload = {
      execution_id: "22222222-2222-4222-8222-222222222222",
      execution_token: VALID_TOKEN,
      organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      messages: [{ role: "user", content: "oi" }],
    };

    // Invariant: AT MOST a success, NEVER a `failed` AFTER a `success` for the
    // same run. (The fake redis succeeds for dedup+session-create; even if a
    // late step throws, the completeSent guard must suppress the boundary failed.)
    await handleExecution(payload, ctx).catch(() => undefined);

    const strategies = callbackMock.sendComplete.mock.calls.map(
      (c) => (c[2] as { strategy?: string }).strategy,
    );
    const firstSuccessIdx = strategies.findIndex((s) => s !== "failed");
    const failedAfterSuccess =
      firstSuccessIdx >= 0 && strategies.indexOf("failed") > firstSuccessIdx;
    expect(failedAfterSuccess).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- execution-handler.j3`
Expected: the invariant must hold both before and after the fix. If the stub success path runs and a post-complete step throws into the boundary, the pre-fix code emits a `failed` after the `success` and the test FAILS; if the stub path happens not to throw, the test still guards the invariant and must remain green after the fix. Proceed to the fix regardless.

- [ ] **Step 3: Write minimal implementation** — in `src/runtime/execution-handler.ts`. First declare the `completeSent` flag immediately above the wrapping `try {` at `:1047` (the one whose `catch (err)` is the boundary at `:1662`). The line above `:1047` is blank (`:1046`); the `try {` at `:1047` is followed by `updateStatus(..., "running")` at `:1048`. Insert the flag right before `try {`. Replace this exact block:

```typescript
      try {
        await updateStatus(execution_id, execution_token, "running");
```

with:

```typescript
      let completeSent = false;
      try {
        await updateStatus(execution_id, execution_token, "running");
```

Then update the success `sendComplete` site (`:1572-1584`). Replace this exact block:

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
            // §4.2b: chave determinística por desfecho. Forma 2-arg viva de
            // deriveIdempotencyKey (params sha256 é o mutation-tool plan, NÃO
            // landed — não adicionar 3º arg aqui).
            MutationTool.deriveIdempotencyKey(
              { execution_id, organization_id: organizationId, step_index: 0 } as ToolContext,
              "complete-success",
            ),
          ),
        );
        // §4.2b: o backend já viu SUCCESS. Qualquer throw nos passos
        // pós-/complete NÃO pode emitir um segundo /complete(failed).
        completeSent = true;
```

Then guard the post-complete clean-up. Replace this exact block (`:1647-1651`):

```typescript
        // 14. Clean up
        await sessionStore.update(execution_id, {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
```

with:

```typescript
        // 14. Clean up — §4.2b: genuinamente off-hot-path (o backend já tem o
        // SUCCESS). NUNCA relançar daqui: um hiccup de Redis aqui caía no
        // boundary catch e emitia um segundo /complete(failed).
        await sessionStore
          .update(execution_id, {
            status: "completed",
            completedAt: new Date().toISOString(),
          })
          .catch((sessErr) => {
            logger.warn(
              { execution_id, sessErr },
              "Post-complete session update failed (non-fatal)",
            );
          });
```

Then guard the boundary `failed` callback. Replace this exact block (`:1673-1680`):

```typescript
        // Error boundary: attempt /complete with status=failed, swallow callback errors
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
        // Error boundary: attempt /complete with status=failed, swallow callback errors.
        // §4.2b: se o SUCCESS já foi enviado, NÃO emitir um segundo /complete
        // (o throw veio de um passo pós-complete genuinamente off-hot-path).
        if (!completeSent) {
          await sendComplete(
            execution_id,
            execution_token,
            buildCompletePayload({ responseText: "", sentiment: "neutral", strategy: "failed" }),
            // §4.2b mitigação 2: chave por desfecho (forma 2-arg viva). Permite
            // last-write-wins no backend se um retry producer-side re-rodar.
            MutationTool.deriveIdempotencyKey(
              { execution_id, organization_id: organizationId, step_index: 0 } as ToolContext,
              "complete-failed",
            ),
          ).catch((callbackErr) => {
            logger.warn({ callbackErr }, "Failed to send error /complete callback");
          });
        } else {
          logger.warn(
            { execution_id, err: err instanceof Error ? err.message : String(err) },
            "Post-complete step threw after SUCCESS callback — suppressing duplicate /complete(failed)",
          );
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- execution-handler.j3 execution-handler.flow`
Expected: PASS — the no-double-complete invariant holds; the existing flow test still passes (the success callback now carries a 4th arg, which the hoisted `sendComplete` mock ignores; the boundary failed-strategy assertion in `flow.test.ts:209-211` still holds for genuine in-loop failures where `completeSent` is `false`).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts tests/unit/runtime/execution-handler.j3.test.ts
git commit -m "fix(runtime): completeSent guard + idempotent boundary callback to block double /complete (§4.2b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Phase 1 gate — typecheck + targeted suite

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exits 0, no TypeScript errors. (Confirms the `bullmq` import, the new `ToolContext` casts, and the `MutationTool.deriveIdempotencyKey` 2-arg calls all compile.)

- [ ] **Step 2: Run the Phase 1 suite**

Run: `npm run test:unit -- execution-handler`
Expected: PASS — payload, j3, flow, and the other execution-handler unit suites all green.

- [ ] **Step 3: Commit (no-op if clean)** — if typecheck/tests produced no source changes, skip. Otherwise:

```bash
git add -A
git commit -m "chore: phase 1 gate — typecheck clean + execution-handler suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Dead-letter signal + worker retention + failed listener + metric + config

### Task 5: Add the dead-letter metric module (3 categories)

**Files:**
- Create: `src/observability/dead-letter-metrics.ts`
- Test: `tests/unit/observability/dead-letter-metrics.test.ts` (new)

> **No new dependency.** `src/observability/` has no metrics SDK today (only tracing via OTEL — `tracer.ts`/`spans.ts`). For the pilot, `recordDeadLetter` keeps an in-memory counter keyed by `category` and logs at level 50, mirroring spec §4.5's "degrade to in-memory + log when OTEL off". A future task can attach an OTEL counter; the call-site contract (`recordDeadLetter({ category })`) stays stable. **Three categories that dashboards must NOT conflate (spec §4.5/§e):** `poison`, `retry_exhausted`, `aborted` (the last is fed by the abort path / J8, never by this listener — but the label exists so a dashboard can treat abort as a separate baseline). A 4th transient-non-final bucket `transient_attempt` is included for flakiness rate (not a dead-letter).

- [ ] **Step 1: Write the failing test** — create `tests/unit/observability/dead-letter-metrics.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";

import {
  recordDeadLetter,
  getDeadLetterCounts,
  resetDeadLetterCounts,
} from "../../../src/observability/dead-letter-metrics.js";

describe("dead-letter-metrics", () => {
  beforeEach(() => {
    resetDeadLetterCounts();
  });

  it("starts at zero for all categories", () => {
    expect(getDeadLetterCounts()).toEqual({
      poison: 0,
      retry_exhausted: 0,
      aborted: 0,
      transient_attempt: 0,
    });
  });

  it("increments the poison counter", () => {
    recordDeadLetter({ category: "poison" });
    recordDeadLetter({ category: "poison" });
    expect(getDeadLetterCounts().poison).toBe(2);
  });

  it("increments the retry_exhausted counter independently of poison", () => {
    recordDeadLetter({ category: "retry_exhausted" });
    const counts = getDeadLetterCounts();
    expect(counts.retry_exhausted).toBe(1);
    expect(counts.poison).toBe(0);
  });

  it("increments the aborted counter (fed by the abort path, never the listener)", () => {
    recordDeadLetter({ category: "aborted" });
    expect(getDeadLetterCounts().aborted).toBe(1);
  });

  it("increments the transient_attempt bucket (non-final flakiness, not a dead-letter)", () => {
    recordDeadLetter({ category: "transient_attempt" });
    expect(getDeadLetterCounts().transient_attempt).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- dead-letter-metrics`
Expected: FAIL — `src/observability/dead-letter-metrics.ts` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/observability/dead-letter-metrics.ts`:

```typescript
import { createLogger } from "../config/logger.js";

const logger = createLogger({ name: "dead-letter-metrics", level: "error" });

/**
 * §4.5/§e — sinal de SLO para jobs roteados ao `failed` set / dead-letter.
 *
 * Counter in-memory rotulado em categorias que dashboards NÃO devem conflar:
 *  - `poison`           — UnrecoverableError, morre na tentativa 1. Esperado,
 *                         baixo volume; spike = regressão de contrato do produtor.
 *  - `retry_exhausted`  — transiente que esgotou todas as attempts:7. SINAL DE
 *                         INCIDENTE. É a categoria que escreve status='dead_letter'.
 *  - `aborted`          — abort terminal de wall-clock/cost (J8). ESPERADO, NÃO
 *                         alerta; alimentado pelo path de abort, NUNCA por este
 *                         listener (§e).
 *  - `transient_attempt`— falha transiente NÃO-final (vai re-tentar). Taxa de
 *                         flakiness, NÃO é dead-letter.
 *
 * Para o pilot: sem dependência de métricas nova — incrementa contador + loga
 * level 50. O export OTEL fica para follow-up (gated por OTEL_ENABLED); o
 * contrato `recordDeadLetter({ category })` permanece estável.
 */
export type DeadLetterCategory = "poison" | "retry_exhausted" | "aborted" | "transient_attempt";

type DeadLetterCounts = Record<DeadLetterCategory, number>;

const counts: DeadLetterCounts = {
  poison: 0,
  retry_exhausted: 0,
  aborted: 0,
  transient_attempt: 0,
};

export function recordDeadLetter(opts: { category: DeadLetterCategory }): void {
  counts[opts.category] += 1;
  logger.error(
    {
      metric: "harness_dispatch_dead_letter_total",
      category: opts.category,
      counts: { ...counts },
    },
    "dispatch dead-letter recorded",
  );
}

export function getDeadLetterCounts(): DeadLetterCounts {
  return { ...counts };
}

export function resetDeadLetterCounts(): void {
  counts.poison = 0;
  counts.retry_exhausted = 0;
  counts.aborted = 0;
  counts.transient_attempt = 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- dead-letter-metrics`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/observability/dead-letter-metrics.ts tests/unit/observability/dead-letter-metrics.test.ts
git commit -m "feat(observability): dead-letter counter with poison/retry_exhausted/aborted labels (§4.5/§e)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Extend `updateStatus` with an optional `meta` arg (the dead-letter signal surface)

**Files:**
- Modify: `src/integration/bevox-callback.ts` (`updateStatus` `:116-123`)
- Test: `tests/unit/integration/bevox-callback-status-meta.test.ts` (new)

> **Pivot core (spec §a2):** the authoritative dead-letter is `status='dead_letter'` written to the backend, NOT `sendComplete(strategy:'failed')`. The recommended surface is to extend the existing `updateStatus(executionId, token, status)` with a 4th optional `meta` carrying `{ action, failedReason, attemptsMade, idempotencyKey }`. `idempotencyKey` becomes the `Idempotency-Key` header (the `post` helper already accepts an optional 4th `idempotencyKey` and sets the header at `:26` — verified); the rest goes into the body alongside `status`. **Backward-compatible:** `meta` is optional, so the two existing `updateStatus(execution_id, execution_token, "running")` callers (`execution-handler.ts:1048,1221` — verified) are untouched and the body stays `{ status }`.

- [ ] **Step 1: Write the failing test** — create `tests/unit/integration/bevox-callback-status-meta.test.ts`. It stubs global `fetch` (the `post` helper uses `fetch`) and asserts the body + the `Idempotency-Key` header:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { updateStatus } from "../../../src/integration/bevox-callback.js";

describe("updateStatus with meta (dead-letter signal §a2)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("backward-compatible: no meta → body is just { status }, no Idempotency-Key header", async () => {
    await updateStatus("exec-1", "tok-1", "running");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ status: "running" });
    expect(init.headers["Idempotency-Key"]).toBeUndefined();
    expect(init.headers["X-Execution-Token"]).toBe("tok-1");
  });

  it("dead_letter: meta flows into body (minus idempotencyKey) + header carries the key", async () => {
    await updateStatus("exec-2", "tok-2", "dead_letter", {
      action: "retry_exhausted",
      failedReason: "boom",
      attemptsMade: 7,
      idempotencyKey: "harness:exec-2:0:dead-letter",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/executions/exec-2/status");
    expect(JSON.parse(init.body)).toEqual({
      status: "dead_letter",
      action: "retry_exhausted",
      failedReason: "boom",
      attemptsMade: 7,
    });
    // idempotencyKey is NOT in the body — it is the header.
    expect(JSON.parse(init.body).idempotencyKey).toBeUndefined();
    expect(init.headers["Idempotency-Key"]).toBe("harness:exec-2:0:dead-letter");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- bevox-callback-status-meta`
Expected: FAIL — `updateStatus` is 3-arg today (`:116-123`); the 4th `meta` arg is a type error / ignored, so the `dead_letter` body lacks `action`/`failedReason`/`attemptsMade` and no `Idempotency-Key` header is sent.

- [ ] **Step 3: Write minimal implementation** — in `src/integration/bevox-callback.ts`, replace the `updateStatus` block (`:116-123`). Replace this exact block:

```typescript
export async function updateStatus(
  executionId: string,
  token: string,
  status: string,
): Promise<void> {
  await post(`/api/v1/executions/${executionId}/status`, token, { status });
  logger.debug({ executionId, status }, "Sent status update");
}
```

with:

```typescript
/**
 * §a2 — sinal de status ao backend. O `meta` opcional carrega o contexto do
 * dead-letter authoritativo (`status='dead_letter'`, `action='retry_exhausted'`)
 * escrito pelo `worker.on("failed")` na tentativa final do attempts:7. O
 * `idempotencyKey` (ADR-023) vira header via `post` (NÃO entra no body); o
 * resto do `meta` vai no body junto com `status`.
 *
 * Retrocompat: `meta` é opcional → as chamadas existentes
 * `updateStatus(id, token, status)` (ex. "running") seguem com body `{ status }`.
 */
export interface StatusMeta {
  action?: "retry_exhausted";
  failedReason?: string;
  attemptsMade?: number;
  idempotencyKey?: string; // ADR-023 — vira header `Idempotency-Key`, não body
}

export async function updateStatus(
  executionId: string,
  token: string,
  status: string,
  meta?: StatusMeta,
): Promise<void> {
  const { idempotencyKey, ...body } = meta ?? {};
  await post(
    `/api/v1/executions/${executionId}/status`,
    token,
    { status, ...body },
    idempotencyKey,
  );
  logger.debug({ executionId, status, action: meta?.action }, "Sent status update");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- bevox-callback-status-meta`
Expected: PASS — both cases green (legacy body unchanged; dead_letter body + header correct).

- [ ] **Step 5: Commit**

```bash
git add src/integration/bevox-callback.ts tests/unit/integration/bevox-callback-status-meta.test.ts
git commit -m "feat(callback): extend updateStatus with optional meta for dead_letter signal (§a2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Add `HARNESS_DISPATCH_FAILED_RETENTION_S` config

**Files:**
- Modify: `src/config/env.ts` (after `HARNESS_QUEUE_NAME` `:24`)
- Modify: `src/config/harness-config.ts` (`harness` block)
- Test: covered by Task 8's consumer test + `typecheck` (config is plumbing; no dedicated test).

> **No `HARNESS_DISPATCH_ATTEMPTS`** — `attempts` is producer-side (spec §4.4); a consumer-side env would be dead config (silently ignored on a `Worker`).

- [ ] **Step 1: Add the env var** — in `src/config/env.ts`, the `HARNESS_QUEUE_NAME` line is `:24`:

```typescript
    HARNESS_QUEUE_NAME: z.string().default("execution.dispatch.agent_harness"),
```

Add the new line immediately below it:

```typescript
    // J3/DEBT-05 (§4.4): janela de retenção LOCAL do `failed` set
    // (removeOnFail.age, segundos). NÃO é TTL determinístico (eviction lazy) e
    // NÃO é a dead-letter authoritativa (essa é status='dead_letter' no backend).
    // `attempts`/`backoff` NÃO entram aqui — são producer-side e ignorados num
    // Worker (§1/§4.3). Default 24h.
    HARNESS_DISPATCH_FAILED_RETENTION_S: z.coerce.number().int().positive().default(86_400),
```

- [ ] **Step 2: Surface it in harness-config** — in `src/config/harness-config.ts`, the `harness` block. Replace this exact block:

```typescript
    harness: {
      logLevel: env.HARNESS_LOG_LEVEL,
      maxExecutionTimeMs: env.HARNESS_MAX_EXECUTION_TIME_MS,
      queueName: env.HARNESS_QUEUE_NAME,
    },
```

with:

```typescript
    harness: {
      logLevel: env.HARNESS_LOG_LEVEL,
      maxExecutionTimeMs: env.HARNESS_MAX_EXECUTION_TIME_MS,
      queueName: env.HARNESS_QUEUE_NAME,
      dispatchFailedRetentionS: env.HARNESS_DISPATCH_FAILED_RETENTION_S,
    },
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exits 0 — the new field flows through; no consumer reads it yet (Task 8 will).

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts src/config/harness-config.ts
git commit -m "feat(config): HARNESS_DISPATCH_FAILED_RETENTION_S (24h default) for local failed-set retention (§4.4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Worker retention + failed listener (dead-letter signal + abort exclusion + recordDeadLetter)

**Files:**
- Modify: `src/integration/bullmq-consumer.ts:14-43`
- Test: `tests/unit/integration/bullmq-consumer.test.ts`

> **This is the pivot's center.** The async `worker.on("failed", ...)` listener:
> 1. Computes `exhausted = attemptsMade + 1 >= maxAttempts` (verified mental model: on the final attempt `attemptsMade=7`, `7+1>=7` true; on attempt 6, `6+1>=7` false). `attemptsMade`/`opts.attempts` read off the BullMQ `job` — matching the `condense-worker.ts:64` precedent and standard BullMQ.
> 2. **Defensively excludes aborts by error name** (`err.name === "ExecutionAbortError"`) → `category="aborted"`, never `retry_exhausted`, never writes `dead_letter`. This is the §8-open-#11 ordering gate: J8 is NOT merged on `main` (verified — no abort path exists today, so wall-clock timeouts currently RETHROW and would reach this listener). The name check is the same `err.name ==` pattern BullMQ itself uses at `job.js:486`. This makes the spec robust regardless of J8 merge order.
> 3. On `(exhausted && !poison && !aborted)` OR `poison` with salvageable id+token, writes `status='dead_letter'` + `action='retry_exhausted'` via the extended `updateStatus(meta)` (Task 6), with a deterministic `Idempotency-Key` from the live 2-arg `MutationTool.deriveIdempotencyKey`. Guarded by `.catch()` (Redis/backend down → warn; backend cron reconciles).
> 4. Records the category counter (Task 5).
>
> Retention options use `removeOnFail`/`removeOnComplete`/`maxStalledCount: 1` only — **NOT `attempts`/`backoff`** (not `WorkerOptions`; silently ignored). Poison is non-retryable by **type** (`UnrecoverableError`), not by `job.discard()`.

- [ ] **Step 1: Write the failing test** — rewrite `tests/unit/integration/bullmq-consumer.test.ts`. Replace the ENTIRE contents with:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";

// Re-export a REAL UnrecoverableError so `extends UnrecoverableError` in
// execution-handler resolves to a real class and `instanceof` works under the mock.
vi.mock("bullmq", () => {
  class UnrecoverableError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  }
  class FakeWorker {
    listeners: Record<string, (...args: unknown[]) => void> = {};
    constructor(
      public queue: string,
      public processor: (job: { data: unknown; id?: string }) => Promise<void>,
      public options: Record<string, unknown>,
    ) {}
    on(event: string, fn: (...args: unknown[]) => void): this {
      this.listeners[event] = fn;
      return this;
    }
    async close(): Promise<void> {}
  }
  return { Worker: FakeWorker, UnrecoverableError };
});

// Spy on the metric + the dead-letter signal callback.
const metricMock = vi.hoisted(() => ({ recordDeadLetter: vi.fn() }));
vi.mock("../../../src/observability/dead-letter-metrics", () => metricMock);

const callbackMock = vi.hoisted(() => ({ updateStatus: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../src/integration/bevox-callback", () => callbackMock);

// handleExecution is mocked so the processor can be driven without real infra.
const handlerMock = vi.hoisted(() => ({ handleExecution: vi.fn() }));
vi.mock("../../../src/runtime/execution-handler", async () => {
  const actual = await vi.importActual<typeof import("../../../src/runtime/execution-handler")>(
    "../../../src/runtime/execution-handler",
  );
  return { ...actual, handleExecution: handlerMock.handleExecution };
});

import { UnrecoverableError } from "bullmq";
import { UnprocessablePayloadError } from "../../../src/runtime/execution-handler.js";
import {
  startConsumer,
  stopConsumer,
  getActiveWorker,
} from "../../../src/integration/bullmq-consumer.js";

const VALID_TOKEN = "a-very-long-token-value-1234567890";

describe("bullmq-consumer", () => {
  afterEach(async () => {
    await stopConsumer();
    metricMock.recordDeadLetter.mockReset();
    callbackMock.updateStatus.mockReset();
    handlerMock.handleExecution.mockReset();
    vi.restoreAllMocks();
  });

  it("startConsumer returns a worker and registers it as active", async () => {
    const worker = await startConsumer({} as never);
    expect(worker).toBeDefined();
    expect(getActiveWorker()).toBe(worker);
  });

  it("sets retention options + maxStalledCount, and NO attempts/backoff", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { options: Record<string, unknown> };
    expect(fake.options.removeOnFail).toMatchObject({ age: 86_400 });
    expect(fake.options.removeOnComplete).toMatchObject({ age: 3600, count: 1000 });
    expect(fake.options.maxStalledCount).toBe(1);
    expect(fake.options.attempts).toBeUndefined();
    expect(fake.options.backoff).toBeUndefined();
  });

  it("processor rethrows handler errors (poison reaches failed set)", async () => {
    handlerMock.handleExecution.mockRejectedValueOnce(new UnprocessablePayloadError("poison"));
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as {
      processor: (job: { data: unknown; id?: string }) => Promise<void>;
    };
    let thrown: unknown;
    await fake.processor({ data: {}, id: "j1" }).catch((e) => {
      thrown = e;
    });
    expect(thrown).toBeInstanceOf(UnprocessablePayloadError);
  });

  it("registers a failed listener and an error listener", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    expect(typeof fake.listeners.failed).toBe("function");
    expect(typeof fake.listeners.error).toBe("function");
  });

  it("poison → records 'poison' + writes dead_letter when id+token salvageable", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    const poison = new UnprocessablePayloadError("bad", {
      executionId: "11111111-1111-4111-8111-111111111111",
      executionToken: VALID_TOKEN,
    });
    await fake.listeners.failed({ id: "j2", attemptsMade: 1, opts: { attempts: 7 } }, poison);
    expect(metricMock.recordDeadLetter).toHaveBeenCalledWith({ category: "poison" });
    expect(callbackMock.updateStatus).toHaveBeenCalledTimes(1);
    const [id, token, status, meta] = callbackMock.updateStatus.mock.calls[0];
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
    expect(token).toBe(VALID_TOKEN);
    expect(status).toBe("dead_letter");
    expect(meta).toMatchObject({ action: "retry_exhausted" });
    expect(meta.idempotencyKey).toBe(
      "harness:11111111-1111-4111-8111-111111111111:0:dead-letter",
    );
  });

  it("transient FINAL attempt → records 'retry_exhausted' + writes dead_letter", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    const job = {
      id: "j3",
      attemptsMade: 7,
      opts: { attempts: 7 },
      failedReason: "backend 503",
      data: { execution_id: "22222222-2222-4222-8222-222222222222", execution_token: VALID_TOKEN },
    };
    await fake.listeners.failed(job, new Error("backend 503"));
    expect(metricMock.recordDeadLetter).toHaveBeenCalledWith({ category: "retry_exhausted" });
    expect(callbackMock.updateStatus).toHaveBeenCalledTimes(1);
    expect(callbackMock.updateStatus.mock.calls[0][2]).toBe("dead_letter");
  });

  it("transient NON-final attempt → records 'transient_attempt', does NOT write dead_letter", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    const job = {
      id: "j4",
      attemptsMade: 3,
      opts: { attempts: 7 },
      data: { execution_id: "33333333-3333-4333-8333-333333333333", execution_token: VALID_TOKEN },
    };
    await fake.listeners.failed(job, new Error("transient"));
    expect(metricMock.recordDeadLetter).toHaveBeenCalledWith({ category: "transient_attempt" });
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
  });

  it("abort (ExecutionAbortError by name) → records 'aborted', NEVER writes dead_letter (§8 open #11)", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    const abortErr = new Error("wall-clock timeout");
    abortErr.name = "ExecutionAbortError";
    const job = {
      id: "j5",
      attemptsMade: 7, // even on the FINAL attempt, abort must not become retry_exhausted
      opts: { attempts: 7 },
      data: { execution_id: "44444444-4444-4444-8444-444444444444", execution_token: VALID_TOKEN },
    };
    await fake.listeners.failed(job, abortErr);
    expect(metricMock.recordDeadLetter).toHaveBeenCalledWith({ category: "aborted" });
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
  });

  it("stopConsumer closes worker and clears active reference", async () => {
    await startConsumer({} as never);
    expect(getActiveWorker()).not.toBeNull();
    await stopConsumer();
    expect(getActiveWorker()).toBeNull();
  });

  it("stopConsumer is a no-op when no worker is active", async () => {
    await stopConsumer();
    await expect(stopConsumer()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- bullmq-consumer`
Expected: FAIL — the worker has no retention options, no `maxStalledCount`, no `failed` listener; `recordDeadLetter`/`updateStatus` are never called.

- [ ] **Step 3: Write minimal implementation** — rewrite `src/integration/bullmq-consumer.ts`. Replace the ENTIRE contents with:

```typescript
import type { Job, WorkerOptions } from "bullmq";
import { Worker } from "bullmq";
import pino from "pino";

import { getHarnessConfig } from "../config/harness-config.js";
import { updateStatus } from "../integration/bevox-callback.js";
import {
  recordDeadLetter,
  type DeadLetterCategory,
} from "../observability/dead-letter-metrics.js";
import type { ExecutionContext } from "../runtime/execution-handler.js";
import { handleExecution, UnprocessablePayloadError } from "../runtime/execution-handler.js";
import { MutationTool } from "../tools/_shared/mutation-tool.js";
import type { ToolContext } from "../tools/_shared/mutation-tool.js";

const config = getHarnessConfig();
const logger = pino({ level: config.harness.logLevel, name: "bullmq-consumer" });

let activeWorker: Worker | null = null;

export async function startConsumer(ctx: ExecutionContext): Promise<Worker> {
  const { queueName, dispatchFailedRetentionS } = config.harness;

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const payload: unknown = job.data;
      logger.info({ jobId: job.id }, "Job received");

      try {
        await handleExecution(payload, ctx);
        logger.info({ jobId: job.id }, "Job completed");
      } catch (err) {
        // Poison NÃO precisa de tratamento especial aqui:
        // `UnprocessablePayloadError extends UnrecoverableError` (§4.1), então
        // o BullMQ NÃO re-tenta mesmo com o `attempts: 7` LIVE do produtor
        // (check `instanceof || err.name` em job.js:486). Sem `job.discard()`.
        logger.error(
          { jobId: job.id, poison: err instanceof UnprocessablePayloadError, err },
          "Job failed (attempt)",
        );
        throw err; // → failed set local; dead_letter authoritativo no failed listener
      }
    },
    {
      connection: { url: config.redis.url } as never,
      // Worker-level RETENTION apenas. `attempts`/`backoff` NÃO são
      // WorkerOptions (vivem em base-job-options; producer-side) — ver §1.
      // Setá-los aqui é silenciosamente ignorado. Retry vem do produtor (attempts:7 LIVE).
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: dispatchFailedRetentionS }, // retenção LOCAL (eviction lazy, não TTL exato)
      // Anti-stalled-storm: limita re-delivery por lock expirado (SIGKILL etc).
      maxStalledCount: 1,
    } as WorkerOptions,
  );

  worker.on("error", (err) => {
    logger.error({ err }, "BullMQ worker error");
  });

  // J3/DEBT-05: canal de observabilidade + sinal dead-letter AUTHORITATIVO.
  // Consistente com condense-worker.ts:64 / eval-worker.ts:71.
  //
  // A dead-letter authoritativa vive no BACKEND (status='dead_letter'). Este
  // listener é o ÚNICO ponto que a escreve — na tentativa FINAL do attempts:7
  // (transiente esgotado) ou em poison salvageável (§b). O `failed` set retido
  // é só retenção LOCAL / forense.
  worker.on("failed", async (job, err) => {
    const poison = err instanceof UnprocessablePayloadError;
    // §8 open #11 (J8 ainda NÃO merged em `main`): classifica abort por NOME
    // (mesmo padrão `err.name ==` do BullMQ em job.js:486). Abort NUNCA vira
    // retry_exhausted e NUNCA escreve dead_letter — é terminal/esperado (J8).
    const aborted = err?.name === "ExecutionAbortError";

    // attempts:7 LIVE. attemptsMade conta tentativas já FEITAS; +1 = a atual.
    // `>= opts.attempts` ⇒ esta é a última.
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    const exhausted = attemptsMade + 1 >= maxAttempts;

    const category: DeadLetterCategory = aborted
      ? "aborted"
      : poison
        ? "poison"
        : exhausted
          ? "retry_exhausted"
          : "transient_attempt";

    logger.error(
      {
        jobId: job?.id,
        attemptsMade,
        maxAttempts,
        failedReason: job?.failedReason ?? err?.message,
        poison,
        aborted,
        exhausted,
        category,
      },
      "Job moved to failed set (local retention)",
    );

    // §a — Sinal dead-letter AUTHORITATIVO ao backend. Dispara quando:
    //   (i) transiente esgotou todas as attempts:7 (exhausted && !poison), OU
    //   (ii) poison salvageável (§b — visibilidade no replay UI).
    // NUNCA para abort (§e / §8 open #11): abort é terminal e dono do J8.
    if (!aborted && (exhausted || poison)) {
      const salvage = poison ? (err as UnprocessablePayloadError) : undefined;
      const data = job?.data as { execution_id?: string; execution_token?: string } | undefined;
      const execId = salvage?.executionId ?? data?.execution_id;
      const execToken = salvage?.executionToken ?? data?.execution_token;
      if (execId && execToken) {
        // ADR-023: forma 2-arg viva de deriveIdempotencyKey (params sha256 é o
        // mutation-tool plan, ainda NÃO landed — não adicionar 3º arg aqui).
        const idemKey = MutationTool.deriveIdempotencyKey(
          { execution_id: execId, organization_id: "", step_index: 0 } as ToolContext,
          "dead-letter",
        );
        // §a2 PRIMARY: updateStatus com meta. Seta status='dead_letter' + action.
        // NÃO usar sendComplete(strategy:'failed') — não acende a replay UI.
        await updateStatus(execId, execToken, "dead_letter", {
          action: "retry_exhausted",
          failedReason: job?.failedReason ?? err?.message,
          attemptsMade,
          idempotencyKey: idemKey,
        }).catch((cbErr) => {
          // Redis/backend down: a dead-letter authoritativa é HTTP (independente
          // do Redis), mas a entrega não é garantida — o cron `bevox.timeout.scan`
          // do backend reconcilia (§4.6b / §8 risk 7).
          logger.warn(
            { cbErr, jobId: job?.id },
            "Failed to write dead_letter status to backend (cron reconciliation backstop)",
          );
        });
      }
    }

    // §4.5/§e — sinal de SLO. Counter rotulado em categorias DISTINTAS que o
    // dashboard NÃO deve conflar.
    recordDeadLetter({ category });
  });

  activeWorker = worker;
  logger.info({ queue: queueName }, "BullMQ consumer started");
  return worker;
}

export async function stopConsumer(): Promise<void> {
  if (activeWorker) {
    logger.info("Stopping BullMQ consumer");
    await activeWorker.close();
    activeWorker = null;
  }
}

export function getActiveWorker(): Worker | null {
  return activeWorker;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- bullmq-consumer`
Expected: PASS — options asserted, listener wired, poison rethrows, dead-letter signal written for poison + final transient, suppressed for non-final + abort, counter labelled correctly.

> **Mock resolution note (verified):** under `vi.mock("bullmq")`, both `execution-handler` and `bullmq-consumer` resolve `bullmq` to the SAME mocked module, so `UnprocessablePayloadError extends UnrecoverableError(mock)` and the listener's `err instanceof UnprocessablePayloadError` works against the mock. The abort test sets `err.name = "ExecutionAbortError"` directly (no class needed) — matching the `err?.name === "ExecutionAbortError"` check in the listener.

- [ ] **Step 5: Commit**

```bash
git add src/integration/bullmq-consumer.ts tests/unit/integration/bullmq-consumer.test.ts
git commit -m "feat(consumer): failed listener writes authoritative dead_letter + retention + abort exclusion (§4.3/§a/§8-11)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Phase 2 gate — typecheck + targeted suite

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exits 0 — the consumer's new imports (`updateStatus`, `recordDeadLetter`/`DeadLetterCategory`, `MutationTool`/`ToolContext`) and the `WorkerOptions` cast compile.

- [ ] **Step 2: Run the Phase 2 suite**

Run: `npm run test:unit -- bullmq-consumer dead-letter-metrics bevox-callback-status-meta`
Expected: PASS — consumer, metric, and status-meta suites green.

- [ ] **Step 3: Commit (no-op if clean)** — if typecheck/tests produced no source changes, skip. Otherwise:

```bash
git add -A
git commit -m "chore: phase 2 gate — typecheck clean + consumer/metric/callback suites green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Doc reconciliation + forensic late-completion log + open gates

### Task 10: Emit `execution.late_completion` forensic log past the run deadline

**Files:**
- Modify: `src/runtime/execution-handler.ts` (above the wrapping `try {` `:1047`; success site, after the `completeSent = true` line added in Task 3)
- Test: none at the unit level (the deadline is wall-clock; the log is fire-and-forget and asserting on it needs the heavy flow harness). Verified by reading the diff + build/typecheck.

> **Spec §4.6b mitigation 3:** the backend cron `bevox.timeout.scan` (2 min) sets `status='timeout'` + human handoff when `dispatched_at + 120000ms < now()`. If the harness completes a run **past its own deadline**, a parallel human handoff *may* have happened. Emit a structured `execution.late_completion` log as a reconciliation/alert signal. The harness's own deadline is `HARNESS_MAX_EXECUTION_TIME_MS` (verified default `120000` in `env.ts:23` on this tree; the op-execution-bounding branch lowers it to `90000` — see Task 14). We approximate the run start from a timestamp captured just above the wrapping `try`.

- [ ] **Step 1: Capture the run start** — in `src/runtime/execution-handler.ts`, on the `let completeSent = false;` line added in Task 3 (just above the wrapping `try {` at `:1047`), add a monotonic start marker right after it. Replace this exact block:

```typescript
      let completeSent = false;
      try {
        await updateStatus(execution_id, execution_token, "running");
```

with:

```typescript
      let completeSent = false;
      const runStartedAt = Date.now();
      try {
        await updateStatus(execution_id, execution_token, "running");
```

- [ ] **Step 2: Emit the late-completion log** — right after the `completeSent = true;` line (added in Task 3, just below the success `sendComplete`), add:

```typescript
        // §4.6b: sinal forense. Se completamos PASSADO nosso próprio deadline,
        // o cron `bevox.timeout.scan` do backend pode já ter feito handoff
        // humano em paralelo (double-handling). Material p/ reconciliação/alerta.
        const runDeadlineMs = getHarnessConfig().harness.maxExecutionTimeMs;
        if (Date.now() - runStartedAt > runDeadlineMs) {
          logger.warn(
            { execution_id, elapsedMs: Date.now() - runStartedAt, deadlineMs: runDeadlineMs },
            "execution.late_completion — completed past run deadline; backend timeout handoff may have occurred",
          );
        }
```

> **Import note (verified):** `getHarnessConfig` is already imported at `:17`; `logger` is in scope. No new imports.

- [ ] **Step 3: Typecheck + handler suite**

Run: `npm run typecheck && npm run test:unit -- execution-handler`
Expected: typecheck exits 0; handler suites green (the happy-path elapsed time in unit tests is well under the deadline, so the new branch is a no-op there).

- [ ] **Step 4: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): emit execution.late_completion forensic log past run deadline (§4.6b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Reconcile `.claude/rules/harness-payload.md` (DEBT-05)

**Files:**
- Modify: `.claude/rules/harness-payload.md:76-77`

- [ ] **Step 1: Rewrite the Validação paragraph** — the file ends with the `## Validação` section (`:74-77`). Replace this exact two-line paragraph (`:76-77`):

```
Worker BullMQ valida via Zod. Falha → loga em `level:50` (fatal) e
descarta (sem canal de erro hoje; v2 vai pra dead-letter).
```

with:

```
Worker BullMQ valida via Zod. Payload improcessável (Zod-inválido ou oversize)
→ `parseExecutionPayload` lança `UnprocessablePayloadError` (estende
`UnrecoverableError`); o handler relança (NÃO retorna silenciosamente) e o worker
o roteia para o `failed` set do BullMQ como RETENÇÃO LOCAL (`removeOnFail.age`,
default 24h — auxílio forense / fallback Redis-down, NÃO a dead-letter
authoritativa). A dead-letter AUTHORITATIVA vive no BACKEND como
`status='dead_letter'`, escrita pelo `worker.on("failed")` na tentativa FINAL do
`attempts:7` (transiente esgotado, `action='retry_exhausted'`) ou em poison
salvageável — via `updateStatus(..., 'dead_letter', meta)` com `Idempotency-Key`.
Abort de wall-clock/cost (J8) é terminal e NUNCA vira dead_letter (classificado
por `err.name === "ExecutionAbortError"`). NÃO usar `sendComplete(strategy:'failed')`
como sinal dead-letter (ele NÃO seta `status='dead_letter'` e não acende a replay
UI de staff). Logging é `logger.error` = Pino level **50 (ERROR)**, não fatal.
NÃO há fila dedicada `bevox.harness.dead-letter` no harness — a dead-letter é o
estado backend; a retenção do `failed` set é só local; uma DLQ dedicada fica
diferida a v2.
```

- [ ] **Step 2: Verify no broken claims remain**

Run: `grep -n "v2 vai pra dead-letter\|sem canal de erro" .claude/rules/harness-payload.md`
Expected: no matches; the old `(fatal)` mischaracterization is gone (the new text says level 50 ERROR explicitly).

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/harness-payload.md
git commit -m "docs(rules): reconcile DEBT-05 — failed set is local; backend status=dead_letter is authoritative (§4.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Reconcile `docs/architecture/fluxo-de-execucao.md`

**Files:**
- Modify: `docs/architecture/fluxo-de-execucao.md:11,310`

- [ ] **Step 1: Fix the `:11` paragraph** — replace this exact sentence:

```
Qualquer falha dentro do bloco principal aciona um boundary de erro: o harness tenta enviar um callback `/complete` com `strategy: "failed"`, atualiza o status da sessão para `"failed"` e relança a exceção para que o BullMQ possa tratar reprocessamento ou DLQ.
```

with:

```
Qualquer falha dentro do bloco principal aciona um boundary de erro: o harness tenta enviar um callback `/complete` com `strategy: "failed"` (com `Idempotency-Key`, suprimido se um `/complete` de sucesso já saiu — guard `completeSent`), atualiza o status da sessão para `"failed"` e relança a exceção. O BullMQ re-tenta conforme o `attempts:7` do produtor (LIVE); esgotado o retry, o `worker.on("failed")` escreve `status='dead_letter'` no backend (sinal authoritativo, acende a replay UI de staff) e retém o job localmente no `failed` set (`removeOnFail.age`) para forense. NÃO há fila DLQ dedicada no harness.
```

- [ ] **Step 2: Fix the `:310` line** — replace this exact line:

```
4. Exceção relançada para o worker BullMQ decidir sobre retry/DLQ.
```

with:

```
4. Exceção relançada para o worker BullMQ. Retry via `attempts:7` do produtor (LIVE); retry esgotado → `status='dead_letter'` no backend (authoritativo) + retenção local no `failed` set. Sem fila DLQ dedicada no harness.
```

- [ ] **Step 3: Verify**

Run: `grep -n "DLQ\|dead_letter\|attempts:7" docs/architecture/fluxo-de-execucao.md`
Expected: the two edited lines now reference `status='dead_letter'` / `attempts:7` and no longer present "DLQ" as a harness-owned queue.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/fluxo-de-execucao.md
git commit -m "docs(arch): reconcile fluxo-de-execucao DLQ wording with backend dead_letter + attempts:7 (§4.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Clarify the `evals.md` "No DLQ" line is scoped to evals

**Files:**
- Modify: `docs/architecture/evals.md:172-173`

- [ ] **Step 1: Scope the line to evals** — replace this exact block (`:172-173`):

```
- Worker job retry policy: 2 attempts, exponential backoff. No DLQ —
  evals are not incidents.
```

with:

```
- Worker job retry policy: 2 attempts, exponential backoff. No DLQ —
  evals are not incidents. (Escopo: APENAS o eval worker. O dispatch worker
  tem caminho de erro distinto — ver `fluxo-de-execucao.md`: retenção local
  no `failed` set + `status='dead_letter'` authoritativo no backend.)
```

- [ ] **Step 2: Verify**

Run: `grep -n "No DLQ\|dispatch worker" docs/architecture/evals.md`
Expected: the "No DLQ" line now carries the eval-only scoping clause.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/evals.md
git commit -m "docs(arch): scope evals 'No DLQ' line to the eval worker only (§4.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Record the open cross-repo / founder gates (no code)

**Files:**
- Modify: `docs/superpowers/specs/2026-06-02-dead-letter-payload-error-path-design.md` (append a §11 "Plan execution gates" subsection at the end)

> These are spec §8 open questions / risks that this plan **cannot close** because they live in the backend, the orchestration-service, or the hub `infra/` repo, or depend on PR #59 / J8. Recording them in the spec keeps the audit honest: the plan ships consumer-side retention + visibility + the authoritative signal, and explicitly flags the dependencies that gate full correctness.

- [ ] **Step 1: Append the gates note** — add this block to the END of `docs/superpowers/specs/2026-06-02-dead-letter-payload-error-path-design.md`:

```markdown
## §11. Plan execution gates (recorded by the implementation plan, 2026-06-03)

The implementation plan ships consumer-side: J3 fail-loudly, the authoritative
`status='dead_letter'` signal (extended `updateStatus(meta)`), local `failed`-set
retention, the 3-category counter, and the defensive abort exclusion. It does NOT
close these dependencies (outside this spec's edit surface):

- **§8 open #5 — backend `/complete` last-write-wins contract.** With `attempts:7`
  LIVE, the boundary `/complete(failed)` + a retry's `/complete(success)` collide on
  `execution_id`. The boundary callback now carries an `Idempotency-Key`; the backend
  MUST treat `/complete` (and `updateStatus(...'dead_letter'...)`) as idempotent /
  last-write-wins per `execution_id`. **Blocking-now; cross-repo (backend).**
- **§8 open #7 — Idempotency-Key threading across all 5 mutation tools.** Only
  `create-appointment` threads a key today; the other 4 duplicate side-effects on
  retry/redelivery. **Blocking-now; owned by the mutation-tool-rollout-idempotency
  plan + PR #59.**
- **§8 open #11 / risk 8 — J8 (op-execution-bounding) merge order.** The plan
  implements the defensive abort classify (`err.name === "ExecutionAbortError"` →
  `category="aborted"`, never `dead_letter`) so the listener is correct regardless of
  merge order. Preferred belt: land J8 before (or with) this listener. Until J8 is
  merged on `main`, the name-based classify is the only protection — keep it.
- **§8 open #8 — `terminationGracePeriodSeconds` ≥ `HARNESS_MAX_EXECUTION_TIME_MS`.**
  Align the hub `infra/` manifest grace period so long jobs are not SIGKILLed
  mid-flight (→ redelivery + duplication without key threading). **Cross-repo (hub).**
  NB: `env.ts:23` shows `HARNESS_MAX_EXECUTION_TIME_MS = 120000` on this tree; the
  op-execution-bounding branch lowers it to `90000` (< the backend `bevox.timeout.scan`
  120s window, §4.6b) — confirm the lower value lands.
- **§8 risk 10 / §d1 — replay dedup.** Staff replay mints a NEW `execution_id`, so
  appointment-mutation idempotency keys do NOT dedup on replay. **GATE: replay of
  appointment mutations stays BLOCKED until the `original_execution_id` lineage lands
  (PR #59).** Send-message replay is safe today via the content-keyed replied-marker.
- **§8 open #6 — concrete alert thresholds / SLI.** Founder/ops own the
  `retry_exhausted` rate (warning vs critical) and `failed_depth` backlog threshold;
  `aborted` MUST NOT be conflated with `retry_exhausted`. **Founder/ops decision.**
- **§8 open #2 / #9 (near-duplicate) — dedicated dead-letter endpoint?** The plan
  extends `/status` (`updateStatus(meta)`). If the backend prefers a dedicated
  `POST /executions/{id}/dead-letter`, swap to a `sendDeadLetter(...)` later. **Backend
  confirmation pending.**
- **§4.6b best-fix — `dispatched_at` absolute deadline.** v2; cross-repo (backend
  stamps the payload); same payload-enrichment family as `original_execution_id`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-02-dead-letter-payload-error-path-design.md
git commit -m "docs(spec): record plan execution gates (open #5/#7/#11/#8/#6, risk 10) for dead-letter path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Final gate — full build + full unit suite

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 2: Full unit suite (NOT integration)**

Run: `npm run test:unit`
Expected: PASS — no regressions. The `RUN_INTEGRATION` integration suite is NOT run here and is NOT a gate.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: exits 0 (or only pre-existing warnings unrelated to the touched files).

- [ ] **Step 4: Confirm the silent discard is gone**

Run: `grep -n "Invalid dispatch payload\|return;" src/runtime/execution-handler.ts | head`
Expected: NO `"Invalid dispatch payload"` log remains; the J3 catch now logs `"Unprocessable dispatch payload (poison) — rethrowing..."` and ends in `throw err` (no `return;` after a parse failure).

- [ ] **Step 5: Final commit (no-op if clean)**

```bash
git add -A
git commit -m "chore: final gate — J3 + DEBT-05 closed; build + unit suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage:**

- §4.1 (`UnprocessablePayloadError extends UnrecoverableError` + `salvageIdToken` + `safeParse` rewrite) → Task 1. ✓
- §4.2 (J3 rethrow, no callback here, salvage on the error) → Task 2. ✓
- §4.2b (double-`/complete`: `completeSent` flag + `.catch()` on post-complete clean-up + `Idempotency-Key` on boundary) → Task 3. ✓
- §4.3 / §a / §a2 (worker retention + async `failed` listener + authoritative `status='dead_letter'` via extended `updateStatus(meta)` on final transient/poison; NO `attempts`/`backoff`; poison non-retryable by type) → Tasks 6 + 8. ✓
- §4.4 (`HARNESS_DISPATCH_FAILED_RETENTION_S`, no `HARNESS_DISPATCH_ATTEMPTS`) → Task 7. ✓
- §4.5 / §e (3-category counter `poison`/`retry_exhausted`/`aborted` + `transient_attempt`; aborts never alert; dashboards must not conflate) → Task 5 + the listener labelling in Task 8. ✓
- §4.6b (forensic `execution.late_completion` log past deadline) → Task 10. ✓
- §4.7 (doc reconciliation: harness-payload, fluxo-de-execucao, evals) → Tasks 11, 12, 13. ✓
- §8 risk 8 / open #11 (J8 not merged → defensive abort classify by `err.name`) → Task 8 (suspenders) + Task 14 (belt: merge-gate recorded). ✓
- §8 open #5/#7/#8/#6/#2/#9, risk 10/§d1 (cross-repo / founder gates) → Task 14 (recorded, not closed). ✓
- §9 DoD Phase 1/2/3 items → mapped across Tasks 1-13; the gates beyond this plan's surface → Task 14. ✓

**Non-goals respected:** no dedicated `bevox.harness.dead-letter` queue (Option C deferred to v2); no producer-side change (`attempts`/`backoff` left to the orchestration-service); no callback with untrusted token (oversize/junk → `salvageIdToken` returns `{}`); no change to Redis dedup or the in-execution boundary beyond the `completeSent` guard (C12 dedup-del at `:1691` preserved). ✓

**2. Placeholder scan:** No "TBD"/"TODO"/"add error handling"/"handle edge cases"/"similar to Task N". Every code step contains full code. The `grep`-based verify steps (Tasks 11-13, 15) include exact commands + expected output. ✓

**3. Type consistency:**
- `UnprocessablePayloadError(message, salvage?)` with `.executionId`/`.executionToken`/`.nonRetryable` — defined Task 1; constructed in Task 8's test; `instanceof`-checked in the listener (Task 8) and the J3 catch (Task 2). Consistent. ✓
- `MutationTool.deriveIdempotencyKey(context, operationName)` — the **live 2-arg static** form used at all four call sites (success `complete-success`, boundary `complete-failed` in Task 3; dead-letter `dead-letter` in Task 8). No 3-arg `params` form is used (that plan has not landed). The `:0:` step segment matches `step_index: 0` in every cast. The expected key in Task 8's test (`harness:11111111-...:0:dead-letter`) matches the live formula `harness:${execution_id}:${step}:${name}` (verified `:127-130`). Consistent. ✓
- `updateStatus(executionId, token, status, meta?)` with `StatusMeta { action, failedReason, attemptsMade, idempotencyKey }` — defined Task 6; called by the listener (Task 8) with all four meta fields; the two existing `updateStatus(id, token, "running")` callers (`:1048`, `:1221`) stay valid (optional `meta`). Consistent. ✓
- `recordDeadLetter({ category })` / `DeadLetterCategory` (`"poison"|"retry_exhausted"|"aborted"|"transient_attempt"`) — defined Task 5; imported + called in Task 8; asserted in Tasks 5 + 8 tests. Consistent. ✓
- `config.harness.dispatchFailedRetentionS` — added Task 7; read in Task 8 (`removeOnFail.age`). Consistent. ✓
- `completeSent` / `runStartedAt` — declared once just above the wrapping `try {` (`:1047`) across Tasks 3 + 10; read at success + boundary + late-completion. Consistent. ✓

**Issues found & fixed inline during review:**
- The OLD plan emitted `sendComplete(strategy:'failed')` from the J3 catch as the "dead-letter" signal and labelled the metric `nonRetryable`/`retryable`. Both contradict the pivot. Rewrote: J3 only rethrows (Task 2), the authoritative signal is `updateStatus(...'dead_letter'...)` from the `failed` listener (Task 8), and the counter has the 3 spec-mandated categories + the `transient_attempt` flakiness bucket (Task 5). (Resolved.)
- Verified `organizationId` is declared at `:843` — AFTER the J3 catch (`:835-841`), so it is NOT in scope inside the J3 catch. Task 2 therefore references no `organizationId` there; it IS in scope at the success/boundary sites (Task 3) and is used there. (Resolved.)
- Verified `updateStatus` has exactly two existing callers, both `(id, token, "running")` with no 4th arg (`:1048`, `:1221`) — confirming the optional `meta` is non-breaking. (Resolved.)
- Verified J8/`ExecutionAbortError` does NOT exist on `main` (no abort path; `runWithTimeout :738` only rejects; boundary `throw err`), so the defensive `err.name === "ExecutionAbortError"` classify (Task 8) is the active protection, not dead code. (Resolved.)
- Verified `UnrecoverableError` is importable from the `bullmq` root and is an `Error` subclass, and the retry short-circuit at `job.js:486` honors both `instanceof` and `err.name == 'UnrecoverableError'` — so the typed-error anti-retry-storm holds under `attempts:7`. (Resolved.)
- Verified the wrapping `try {` (whose catch is the boundary at `:1662`) is at `:1047` (followed by `updateStatus(..., "running")` at `:1048`), so `completeSent`/`runStartedAt` are correctly scoped for the boundary to read. (Resolved.)
