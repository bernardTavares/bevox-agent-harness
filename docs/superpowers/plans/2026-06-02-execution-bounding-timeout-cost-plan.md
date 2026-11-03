# Execution Bounding — Wall-Clock Timeout + Cost-Ceiling Abort (J8 / J9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound a single harness execution by an absolute wall-clock deadline (J8) and an optional cost ceiling (J9), aborting cooperatively between reasoning steps and around the terminal `synthesize`, routing every abort through the existing error boundary as a typed `ExecutionAbortError` — where the boundary treats an abort as a **TERMINAL outcome: it emits `/complete` and ACKs the job (return), it does NOT rethrow** (rethrow would make the producer's `attempts:7` replay a doomed execution; the backend has already handed off to a human at 120s). Only genuinely transient non-abort errors rethrow. All without touching the LLM adapter/gateway/decorator robustness layer.

**Architecture:** Three phases on the cooperative **Option A** design from the spec. Phase 1 ships inert plumbing: a typed `ExecutionAbortError` in a new `src/runtime/errors.ts`, an `AbortController`-aware `runWithTimeout`, three optional `AgentExecutionContext` fields (`deadlineMs?`, `costCeilingCents?`, `costAccumulator?`), a `HARNESS_MAX_COST_USD` env knob exposed via `harness-config.ts`, and an `onUsage` callback that accumulates running cost via `calculateCostCents` using the `meta.model` already flowing in. Phase 2 turns the gates on: derive `deadlineMs`/`costCeilingCents` in the handler, check them at the top of the surface step loop, and wrap the terminal `synthesize` in `runWithTimeout`. Phase 3 discriminates the terminal outcome in the `catch` boundary (`aborted_cost`/`aborted_timeout` vs `failed`), **ACKs the job on any abort (`return`, NOT rethrow) because an abort is a terminal outcome already reported via `/complete`** (rethrow would waste the producer's `attempts:7` re-running a doomed execution the backend already handed off at 120s), retains the dedup key on every abort (defense in depth), and adds the mandatory observability (span attributes + structured `event:"execution.aborted"` log). Only non-abort transient errors clear the dedup key and rethrow. Each phase is independently revertible; with the default env (`HARNESS_MAX_COST_USD=0`, **90s** wall-clock budget — kept below the backend's 120s timeout-scan) the `autonomous_supervised` path stays byte-identical until an org/env configures a ceiling.

**Tech Stack:** Node.js 20, TypeScript 5.9 (ESM/NodeNext — all relative imports use `.js` extensions), Vitest 4, Zod 4, OpenTelemetry spans + Pino logs (the only telemetry primitives; no counters/histograms). `npm run build` = `tsc`; `npm run typecheck` = `tsc --noEmit`; gate tests with `npm run test:unit` (NEVER the `RUN_INTEGRATION` suite). Run a single file with `npm run test:unit -- <path-or-substring>`.

---

## Cross-cutting concerns the reviewer flagged (read before starting)

These five concerns are **not all resolvable inside this repo**. The plan addresses what it can in code and explicitly marks the rest as out-of-scope blockers/gaps so an executing agent does not silently "close" them:

1. **✅ RESOLVED — producer retry config (spec OQ 5).** Confirmed: the producer (bevox-backend)
   enqueues the dispatch with **`attempts: 7` + exponential backoff (~635s total)**, on queue
   **`bevox.execution.dispatch`**, with **`jobId = execution_id`** (BullMQ native jobId dedup). The
   consumer (`src/integration/bullmq-consumer.ts`) does NOT declare `attempts`/`backoff` — retry is
   100% producer-controlled. **This resolution changed the abort architecture:** under `attempts:7`,
   rethrowing an abort would replay a doomed execution 7× while the backend has ALREADY reconciled
   the outcome (a 2-min cron scans `dispatched_at+120000ms` → `status=timeout` → human handoff at
   120s). So **abort is now a TERMINAL outcome: emit `/complete` and ACK the job (return), NOT
   rethrow** (Task 11). Only genuinely transient (non-abort) errors rethrow to let the producer's
   `attempts:7` apply. The dedup key is RETAINED on every abort (defense in depth). This is no longer
   a blocking open question.

2. **No dead-letter queue (CLAUDE.md: "v2 vai pra dead-letter"; `grep dead-letter|DLQ src/` = 0 hits).** This spec converts a silent hang into an abort, but with no DLQ and no retry cap a `wall_clock_timeout` can re-deliver and re-timeout in a loop. The `event:"execution.redelivery"` log (Task 11, §4.11.3) makes redelivery **auditable** but does NOT bound it — true bounding needs DLQ work that is out of scope here. Recorded in the DoD as an open governance item, not closed.

3. **Cost-gate accuracy in streaming is genuinely open (spec risk 2).** `UsageDecorator.completeStream` is pure pass-through (`src/integration/llm/usage-decorator.ts:52-61`), so a streaming execution sub-counts cost and the J9 ceiling can be bypassed. The cost gate is **best-effort only** until a streaming-usage follow-up. Task 4's implementation comment and Task 13's regression note both state this explicitly; do not claim J9 is airtight under streaming.

4. **Orphaned LLM fetches (spec risks 1 & 8).** Option A is cooperative: after a wall-clock or synthesize abort, an in-flight `fetch` keeps running up to the adapter's `AbortSignal.timeout(30s)` cap. Only Option B (signal threaded end-to-end) eliminates this. The founder must accept the cooperative bound for the pilot or fund Option B. The plan implements Option A and Task 9/Task 13 explicitly forbid asserting "synthesize closed structurally".

5. **Cross-spec idempotency coordination (spec §2 invariant).** The parallel idempotency-key spec (`2026-06-02-idempotency-key-full-threading-design.md` §4.4) and this spec both edit the SAME error-path `sendComplete` call-site (`:1674`) and the outcome→`kind` mapping. If they land independently without aligning, the `/complete` idempotency key for an abort can collide with a prior `failed` terminal of the same `execution_id`. **Resolution (recommended): map both `aborted_*` outcomes to the `kind` `failed` in the idempotency table** (an abort *is* a failure for the idempotency contract; the distinct `strategy` string is telemetry only). Task 10 wires the `strategy` discrimination but DOES NOT add a new `/complete` call-site or a new idempotency `kind`; Task 12 records the required action in the sibling spec.

---

## File Structure

**Created:**
- `src/runtime/errors.ts` — `AbortReason` type + `ExecutionAbortError` class. New file so both the handler and (future) consumer can import the type without a cycle through the 1700-line handler.
- `tests/unit/runtime/execution-errors.test.ts` — unit tests for the typed error.

**Modified (Phase 1):**
- `src/runtime/execution-handler.ts` — import `ExecutionAbortError`; harden `runWithTimeout` (`:738-755`) with an optional `AbortController`; accumulate cost in `onUsage` (`:910-919`).
- `src/agents/execution-context.ts` — add `deadlineMs?`, `costCeilingCents?`, `costAccumulator?` to `AgentExecutionContext` (`:113-125`).
- `src/config/env.ts` — add `HARNESS_MAX_COST_USD` (`:23` block).
- `src/config/harness-config.ts` — expose `harness.maxCostUsd` (`:17-21`).
- `tests/unit/integration/llm/usage-decorator.test.ts` — assert `onUsage` receives `meta` and a custom callback sums cost.
- `tests/unit/observability/cost-calculator.test.ts` — add a monotonic-accumulation case.

**Modified (Phase 2):**
- `src/runtime/execution-handler.ts` — derive `deadlineMs`/`costCeilingCents` and thread into `agentContext` (`:972-993`); cooperative gate at the top of the `while` (`:657`); wrap `synthesize` in `runWithTimeout` with `remainingMs` (`:1546-1557`).
- `src/runtime/execution-handler.ts` — `executionPayloadSchema` (`:515-558`) gains optional `max_cost_usd`.
- `tests/unit/runtime/execution-payload.test.ts` — `max_cost_usd` parse cases.
- `tests/unit/runtime/execution-handler.flow.test.ts` — wall-clock, synthesize-timeout, cost-ceiling abort cases (mock `strategy-router`).

**Modified (Phase 3):**
- `src/runtime/execution-handler.ts` — `catch` boundary outcome discrimination + **ACK-on-abort (`return`, not rethrow — abort is terminal)** + dedup-key retention on aborts + span attributes + structured abort log; success path span attribute; `bullmq-consumer.ts` redelivery log.
- `src/integration/bullmq-consumer.ts` — `event:"execution.redelivery"` log keyed on `job.attemptsMade` (§4.11.3 observability hook).
- `.claude/rules/harness-payload.md` — document `max_cost_usd` + `HARNESS_MAX_COST_USD`.
- `skills/bevox-agent-harness-consumer/references/execution-payload.md` — add `max_cost_usd` (optional → minor change).
- `tests/unit/runtime/execution-handler.flow.test.ts` — non-retryable dedup + single-`/complete` + Redis-down boundary + observability assertions.

---

## Phase 1 — Types, budgets and cost accumulation (inert)

### Task 1: Typed `ExecutionAbortError` in a new module

**Files:**
- Create: `src/runtime/errors.ts`
- Test: `tests/unit/runtime/execution-errors.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/unit/runtime/execution-errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

import { ExecutionAbortError, type AbortReason } from "../../../src/runtime/errors.js";

describe("ExecutionAbortError", () => {
  it("is an Error with name ExecutionAbortError", () => {
    const e = new ExecutionAbortError("wall_clock_timeout", "boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ExecutionAbortError");
    expect(e.message).toBe("boom");
  });

  it("carries the typed reason", () => {
    const reason: AbortReason = "cost_ceiling";
    const e = new ExecutionAbortError(reason, "ceiling hit");
    expect(e.reason).toBe("cost_ceiling");
  });

  it("defaults retryable=true (advisory — governs dedup-key retention, not BullMQ)", () => {
    const e = new ExecutionAbortError("wall_clock_timeout", "x");
    expect(e.retryable).toBe(true);
  });

  it("cost_ceiling aborts are constructed non-retryable", () => {
    const e = new ExecutionAbortError("cost_ceiling", "x", false);
    expect(e.retryable).toBe(false);
  });

  it("instanceof discriminates aborts from generic errors at the boundary", () => {
    const abort: unknown = new ExecutionAbortError("phase_timeout", "x");
    const generic: unknown = new Error("network 503");
    expect(abort instanceof ExecutionAbortError).toBe(true);
    expect(generic instanceof ExecutionAbortError).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- execution-errors`
Expected: FAIL — `Cannot find module '../../../src/runtime/errors.js'`.

- [ ] **Step 3: Write minimal implementation** — create `src/runtime/errors.ts`:

```typescript
/**
 * J8/J9 — erros tipados de bounding de execução (wall-clock + cost ceiling).
 *
 * Lançados pelo `execution-handler` quando uma execução cruza o deadline
 * absoluto de wall-clock ou o teto de custo. Caem no MESMO `catch` boundary
 * que já trata falhas (failed `/complete` + dedup clear + rethrow) — sem
 * caminho de erro novo. Ficam num módulo dedicado para que o handler e o
 * consumer possam importar o tipo sem ciclo através do handler de ~1700 linhas.
 */

export type AbortReason = "wall_clock_timeout" | "cost_ceiling" | "phase_timeout";

export class ExecutionAbortError extends Error {
  constructor(
    /** Causa do abort — vira `execution.abort.reason` no span + log estruturado. */
    readonly reason: AbortReason,
    message: string,
    /**
     * ⚠️ ADVISORY, NÃO um kill-switch de retry do BullMQ. O consumer
     * (`bullmq-consumer.ts:28`) faz `throw err` incondicional e NÃO inspeciona
     * este campo; o `Worker` não declara `attempts`/`backoff` (`:17-34`). O
     * mecanismo real de "não re-abortar deterministicamente" é a RETENÇÃO da
     * dedup key (cost_ceiling NÃO limpa a key → re-deliver bate no `SET NX` →
     * return silencioso). Este campo só decide se a dedup key é limpa. Leia-o
     * mentalmente como `clearsDedupKey`. Default `true` (transiente, ex.:
     * wall_clock_timeout pode ser re-tentado).
     */
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = "ExecutionAbortError";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- execution-errors`
Expected: PASS — all 5 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/errors.ts tests/unit/runtime/execution-errors.test.ts
git commit -m "feat(runtime): typed ExecutionAbortError for J8/J9 bounding

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Harden `runWithTimeout` to abort an optional controller

**Files:**
- Modify: `src/runtime/execution-handler.ts:738-755`
- Test: `tests/unit/runtime/execution-handler.flow.test.ts` (no change here — covered indirectly; a direct unit test for the helper would require exporting it, which we avoid to keep the surface minimal. Verified via Phase 2 synthesize-timeout test.)

> **Why no dedicated test yet:** `runWithTimeout` is a private module-level helper, not exported. Adding/keeping it private is the established pattern. Its new branch (calling `controller.abort()`) is exercised end-to-end by the synthesize-timeout test in Task 8. This task is a pure refactor that must keep existing callers (`:376`, `:1059`, `:1088`, `:1529`) compiling unchanged (the new param is optional).

- [ ] **Step 1: Write the implementation** — in `src/runtime/execution-handler.ts`, first add the import. The file imports from sibling runtime modules near the top; add this with the other `../` imports (anywhere in the import block is fine — place it right after the `getHarnessConfig` import at `:17`):

```typescript
import { ExecutionAbortError } from "./errors.js";
```

Then replace the `runWithTimeout` helper (currently `:738-755`). Replace this exact block:

```typescript
function runWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${label} exceeded ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
```

with:

```typescript
/**
 * Promise-timeout wrapper. J8: no estouro, dispara `controller?.abort()` para
 * sinalizar trabalho COOPERATIVO (loop entre steps observa o deadline e para);
 * trabalho não-cooperativo (um `fetch` LLM in-flight) NÃO é cancelado por aqui
 * — fica bounded pelo `AbortSignal.timeout(30s)` self-imposto do adapter. O
 * `controller` é opcional: callers legados (`:376`, `:1059`, `:1088`, `:1529`)
 * continuam compilando sem mudança. Rejeita com `ExecutionAbortError("phase_timeout")`
 * para que o boundary discrimine exhaustion de falha genérica.
 */
function runWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  controller?: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(new ExecutionAbortError("phase_timeout", `Timeout: ${label} exceeded ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: exits 0. All 4 existing `runWithTimeout(...)` callers compile unchanged (the 4th arg is optional). The thrown type changed from `Error` to `ExecutionAbortError` (a subclass of `Error`) — no caller's `catch (err)` typing breaks because the boundary catches `unknown`.

- [ ] **Step 3: Run the existing flow suite (regression guard)**

Run: `npm run test:unit -- execution-handler.flow`
Expected: PASS — the existing error-boundary test (`:204`) still sees a `failed` strategy for a non-abort throw; phase-timeout is not yet triggered by any test.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): runWithTimeout aborts optional controller + throws ExecutionAbortError (J8-c)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add `deadlineMs?`, `costCeilingCents?`, `costAccumulator?` to `AgentExecutionContext`

**Files:**
- Modify: `src/agents/execution-context.ts:113-125`
- Test: none (type-only additive change; exercised by Task 4 + Phase 2 flow tests).

> **Why no isolated test:** these are optional interface fields with no runtime behavior on their own. A test that only constructs the type would assert nothing meaningful. They are covered by the cost-accumulation test (Task 4) and the abort tests (Phase 2). This keeps Phase 1 inert and safe.

- [ ] **Step 1: Write the implementation** — in `src/agents/execution-context.ts`, append the three fields to the `AgentExecutionContext` interface, immediately after the `usageAccumulator?` field (currently the last field, `:124`). Replace this exact block:

```typescript
  usageAccumulator?: { promptTokens: number; completionTokens: number };
}
```

with:

```typescript
  usageAccumulator?: { promptTokens: number; completionTokens: number };

  /**
   * J8 — deadline absoluto de wall-clock (epoch ms). Derivado de
   * `devStartTs + maxExecutionTimeMs` no handler. O surface loop checa
   * `Date.now() >= deadlineMs` no topo de cada step e aborta. Opcional:
   * callers de teste que não o setam preservam o comportamento atual.
   */
  deadlineMs?: number;

  /**
   * J9 — teto de custo em centavos USD (resolvido de `payload.max_cost_usd`
   * OU `env.HARNESS_MAX_COST_USD`). Quando definido, o loop aborta assim que
   * `costAccumulator.costCents` o cruzar. `undefined` = sem teto (legacy).
   */
  costCeilingCents?: number;

  /**
   * J9 — acumulador per-execução de custo corrente (centavos USD). Mutável
   * por referência, espelha `usageAccumulator`: o `onUsage` callback soma via
   * `calculateCostCents` usando o `meta` model/provider. Lido no loop e no
   * span/log de telemetria.
   */
  costAccumulator?: { costCents: number };
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: exits 0. Additive optional fields cannot break existing constructions of `AgentExecutionContext`.

- [ ] **Step 3: Commit**

```bash
git add src/agents/execution-context.ts
git commit -m "feat(agents): add deadlineMs/costCeilingCents/costAccumulator to AgentExecutionContext (J8/J9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Accumulate running cost in `onUsage`

**Files:**
- Modify: `src/runtime/execution-handler.ts:910-919`
- Test: `tests/unit/integration/llm/usage-decorator.test.ts`, `tests/unit/observability/cost-calculator.test.ts`

> **What this proves:** the `UsageCallback` already receives `meta: { model, provider, latencyMs }` (`usage-decorator.ts:28`). A custom callback that sums `calculateCostCents(meta.model, ...)` produces a monotonic running cost. We assert that behavior at the decorator level (where `onUsage` is actually called) plus a monotonic-accumulation case at the calculator level. The handler wiring is then a one-block change verified by build + the Phase 2 cost-ceiling test.
>
> **STREAMING GAP (reviewer concern 3):** `UsageDecorator.completeStream` is pass-through (`:52-61`) and never calls `onUsage`, so streaming executions sub-count cost — the J9 ceiling is best-effort under streaming until the streaming-usage follow-up. Do NOT claim J9 is airtight for streaming.

- [ ] **Step 1: Write the failing test** — append this `describe` block to the END of `tests/unit/integration/llm/usage-decorator.test.ts` (the file already defines `buildResponse` and a `FakeGateway`; reuse `buildResponse`):

```typescript
import { calculateCostCents } from "../../../../src/observability/cost-calculator.js";

describe("UsageDecorator drives a cost accumulator via meta.model (J9)", () => {
  it("a cost-summing onUsage callback receives meta and accumulates monotonically", async () => {
    const costAccumulator = { costCents: 0 };
    const inner = new FakeGateway([
      buildResponse({
        model: "gpt-4o-mini",
        usage: { input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 },
      }),
      buildResponse({
        model: "gpt-4o-mini",
        usage: { input_tokens: 0, output_tokens: 1_000_000, total_tokens: 1_000_000 },
      }),
    ]);
    const decorated = new UsageDecorator(inner, (usage, meta) => {
      // mirrors the handler's onUsage (§4.5): cost via the REAL model reported
      costAccumulator.costCents += calculateCostCents(
        meta.model,
        usage.input_tokens ?? 0,
        usage.output_tokens ?? 0,
      );
    });

    await decorated.complete({} as never);
    // gpt-4o-mini prompt=15c/1M → ceil(15) = 15
    expect(costAccumulator.costCents).toBe(15);

    await decorated.complete({} as never);
    // + completion=60c/1M → ceil(60) = 60 → 75 total (monotonic)
    expect(costAccumulator.costCents).toBe(75);
  });

  it("unknown model contributes 0 — ceiling never trips for it (gap §8)", async () => {
    const costAccumulator = { costCents: 0 };
    const inner = new FakeGateway([
      buildResponse({
        model: "some-unpriced-model",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
      }),
    ]);
    const decorated = new UsageDecorator(inner, (usage, meta) => {
      costAccumulator.costCents += calculateCostCents(
        meta.model,
        usage.input_tokens ?? 0,
        usage.output_tokens ?? 0,
      );
    });
    await decorated.complete({} as never);
    expect(costAccumulator.costCents).toBe(0);
  });
});
```

Then append this case to the END of the `describe("calculateCostCents", ...)` block in `tests/unit/observability/cost-calculator.test.ts`:

```typescript
  it("summing per-call results is monotonic and matches arithmetic (accumulation)", () => {
    // 3 calls of 1M prompt tokens at gpt-4o-mini (15c/1M each) → 15 + 15 + 15 = 45
    let acc = 0;
    for (let i = 0; i < 3; i++) {
      acc += calculateCostCents("gpt-4o-mini", 1_000_000, 0);
    }
    expect(acc).toBe(45);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- usage-decorator cost-calculator`
Expected: the `usage-decorator` cost cases FAIL only if the test import path is wrong; in practice they PASS already because `UsageDecorator` + `calculateCostCents` exist — this is a **contract guard** for the handler wiring that follows. The `cost-calculator` accumulation case PASSES immediately (pure arithmetic). If any fail, fix the test before wiring the handler. (This mirrors the spec's "Phase 1 is inert" intent — the library pieces already work; we are pinning the contract the handler will rely on.)

- [ ] **Step 3: Write minimal implementation** — in `src/runtime/execution-handler.ts`, first confirm `calculateCostCents` is imported. Search the import block; if absent, add (with the other `../observability` imports):

```typescript
import { calculateCostCents } from "../observability/cost-calculator.js";
```

Then replace the `usageAccumulator` + `createLLMGateway` block (`:910-919`). Replace this exact block:

```typescript
      const usageAccumulator = { promptTokens: 0, completionTokens: 0 };
      const gateway = createLLMGateway(
        { default_model: defaultModel },
        {
          onUsage: (usage) => {
            usageAccumulator.promptTokens += usage.input_tokens ?? 0;
            usageAccumulator.completionTokens += usage.output_tokens ?? 0;
          },
        },
      );
```

with:

```typescript
      const usageAccumulator = { promptTokens: 0, completionTokens: 0 };
      // J9 — acumulador de custo corrente (centavos USD). Espelha o padrão
      // by-reference do usageAccumulator. Threaded no agentContext (Task 7)
      // e lido pelo cost gate (Task 6) + telemetria (Task 11).
      const costAccumulator = { costCents: 0 };
      const gateway = createLLMGateway(
        { default_model: defaultModel },
        {
          onUsage: (usage, meta) => {
            usageAccumulator.promptTokens += usage.input_tokens ?? 0;
            usageAccumulator.completionTokens += usage.output_tokens ?? 0;
            // J9 — custo via o model EFETIVAMENTE usado (pós-failover) reportado
            // pelo adapter. Modelos sem pricing → 0 (teto não dispara, gap §8).
            // ⚠️ Math.ceil por-chamada (cost-calculator.ts:53) over-conta ao
            // somar — fail-safe (gate dispara cedo), aceitável p/ teto de
            // segurança. Streaming sub-conta (completeStream pass-through, §8).
            costAccumulator.costCents += calculateCostCents(
              meta.model,
              usage.input_tokens ?? 0,
              usage.output_tokens ?? 0,
              logger,
            );
          },
        },
      );
```

- [ ] **Step 4: Run test to verify it passes + build**

Run: `npm run build && npm run test:unit -- usage-decorator cost-calculator`
Expected: build exits 0 (`costAccumulator` is currently unused beyond construction — TS does not error on an unused `const` that is assigned to; if `noUnusedLocals` flags it, Task 7 consumes it next phase, but to keep Phase 1 building, the accumulator is referenced inside `onUsage`, so it is used). Tests PASS.

> **If `npm run build` errors `'costAccumulator' is declared but its value is never read`:** that means `noUnusedLocals` is on AND the closure reference does not count. It DOES count (the `onUsage` arrow reads/writes `costAccumulator.costCents`), so this should not fire. If it somehow does, do NOT add a throwaway reference — proceed to Task 7 in the same branch which threads it into `agentContext`, then re-run build. Phase 1's commit boundary tolerates this only if build is green; if not, fold Task 7's threading into this commit.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts tests/unit/integration/llm/usage-decorator.test.ts tests/unit/observability/cost-calculator.test.ts
git commit -m "feat(runtime): accumulate running cost in onUsage via meta.model (J9-a)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add `HARNESS_MAX_COST_USD` env knob + expose in harness-config

**Files:**
- Modify: `src/config/env.ts` (the `HARNESS_MAX_EXECUTION_TIME_MS` block, `:23`)
- Modify: `src/config/harness-config.ts:17-21`
- Test: none directly (Zod default is covered by the build + the Phase 2 `max_cost_usd` parse test; a dedicated env test would require resetting the cached env singleton, which is out of proportion for a `z.coerce.number().min(0).default(0)`).

- [ ] **Step 1: Write the implementation** — in `src/config/env.ts`, add the knob immediately after the `HARNESS_MAX_EXECUTION_TIME_MS` line (`:23`). Replace this exact line:

```typescript
    HARNESS_MAX_EXECUTION_TIME_MS: z.coerce.number().default(120000),
```

with:

```typescript
    HARNESS_MAX_EXECUTION_TIME_MS: z.coerce.number().default(120000),
    // J9 — teto de custo default (USD) por execução. 0 = sem teto (legacy /
    // retrocompat). Override por-execução via payload.max_cost_usd tem
    // precedência. Resolvido em centavos no handler (Task 7).
    HARNESS_MAX_COST_USD: z.coerce.number().min(0).default(0),
```

Then in `src/config/harness-config.ts`, expose it in the `harness` block (`:17-21`). Replace this exact block:

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
      maxCostUsd: env.HARNESS_MAX_COST_USD, // J9 — default org-wide cost ceiling (USD)
      queueName: env.HARNESS_QUEUE_NAME,
    },
```

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: exits 0. `getHarnessConfig()` return type widens with `maxCostUsd: number`; no consumer breaks.

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts src/config/harness-config.ts
git commit -m "feat(config): HARNESS_MAX_COST_USD env knob exposed via harness-config (J9-b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Phase 1 gate — build + targeted suite

**Files:** none (verification only)

- [ ] **Step 1: Build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: both exit 0, no TypeScript errors.

- [ ] **Step 2: Run the Phase 1 suite**

Run: `npm run test:unit -- execution-errors usage-decorator cost-calculator execution-handler.flow`
Expected: PASS — typed error, cost accumulation, and the existing flow regression suite all green. No abort behavior is active yet (inert phase).

- [ ] **Step 3: Commit (no-op if clean)**

```bash
git add -A
git commit -m "chore: phase 1 gate — inert bounding plumbing, build + suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Phase 2 — Abort gates (deadline + cost) + synthesize timeout

### Task 7: Add `max_cost_usd` to the payload schema + derive budgets into `agentContext`

**Files:**
- Modify: `src/runtime/execution-handler.ts` (schema `:515-558`; budget derivation + `agentContext` build `:937`/`:972-993`)
- Test: `tests/unit/runtime/execution-payload.test.ts`

- [ ] **Step 1: Write the failing test** — append this `describe` block to the END of `tests/unit/runtime/execution-payload.test.ts` (the file imports `executionPayloadSchema` and defines `base()` returning a payload WITHOUT `organization_id`; add a valid org id locally):

```typescript
describe("max_cost_usd (J9 optional per-execution ceiling)", () => {
  const ORG = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";
  const withOrg = (over: Record<string, unknown> = {}) => ({
    ...base(),
    organization_id: ORG,
    ...over,
  });

  it("accepts a positive max_cost_usd", () => {
    const parsed = executionPayloadSchema.parse(withOrg({ max_cost_usd: 1.5 }));
    expect(parsed.max_cost_usd).toBe(1.5);
  });

  it("absent → undefined (falls back to env default)", () => {
    const parsed = executionPayloadSchema.parse(withOrg());
    expect(parsed.max_cost_usd).toBeUndefined();
  });

  it("rejects a negative max_cost_usd", () => {
    expect(() => executionPayloadSchema.parse(withOrg({ max_cost_usd: -1 }))).toThrow();
  });

  it("rejects zero (use absence/env=0 for 'no ceiling', not an explicit 0 override)", () => {
    expect(() => executionPayloadSchema.parse(withOrg({ max_cost_usd: 0 }))).toThrow();
  });

  it("rejects an absurd ceiling above the 1000 USD cap", () => {
    expect(() => executionPayloadSchema.parse(withOrg({ max_cost_usd: 5000 }))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- execution-payload`
Expected: FAIL — `max_cost_usd` is not declared; `.passthrough()` lets it through untyped so `parsed.max_cost_usd` is `unknown`/present (the positive case may pass by passthrough) but the negative/zero/cap cases FAIL because no validation rejects them.

- [ ] **Step 3: Write minimal implementation** — in `src/runtime/execution-handler.ts`, add the field to `executionPayloadSchema`. Replace this exact line (the `execution_mode` line at `:556`, the last field before `.passthrough()`):

```typescript
    execution_mode: ExecutionModeSchema.optional().default("autonomous_supervised"),
  })
  .passthrough();
```

with:

```typescript
    execution_mode: ExecutionModeSchema.optional().default("autonomous_supervised"),
    // J9 (runtime-gap): teto de custo por-execução em USD, enviado pelo
    // bevox-backend quando a org/plano impõe limite. Opcional; quando ausente,
    // cai no default env HARNESS_MAX_COST_USD (ou sem teto se env=0). Positivo
    // e ≤ 1000 USD (sanidade). Use ausência (não 0 explícito) para "sem teto".
    max_cost_usd: z.number().positive().max(1000).optional(),
  })
  .passthrough();
```

Now derive the budgets in the handler. The handler already calls `const env_ = getEnv();` at `:937`. Add the derivation immediately after that line. Find this exact line (`:937`):

```typescript
      const env_ = getEnv();
```

and insert AFTER it:

```typescript
      // J8 — deadline absoluto de wall-clock (budget INTEIRO, não re-slice).
      const deadlineMs = devStartTs + config.harness.maxExecutionTimeMs;
      // J9 — teto: payload override (USD) > default env (USD). Resolvido em
      // centavos; ausente/0 ⇒ undefined ⇒ sem teto (legacy byte-idêntico).
      const ceilingUsd = payload.max_cost_usd ?? env_.HARNESS_MAX_COST_USD;
      const costCeilingCents =
        ceilingUsd && ceilingUsd > 0 ? Math.ceil(ceilingUsd * 100) : undefined;
```

Then thread the three fields into the `agentContext` literal (`:972-993`). Replace this exact block:

```typescript
        streamCallback,
        systemPrompt: composedSystemPrompt,
        executionMode: payload.execution_mode,
        usageAccumulator,
      };
```

with:

```typescript
        streamCallback,
        systemPrompt: composedSystemPrompt,
        executionMode: payload.execution_mode,
        usageAccumulator,
        costAccumulator, // J9
        deadlineMs, // J8
        costCeilingCents, // J9
      };
```

- [ ] **Step 4: Run test to verify it passes + build**

Run: `npm run build && npm run test:unit -- execution-payload`
Expected: build exits 0 (`deadlineMs`/`costCeilingCents`/`costAccumulator` now consumed via `agentContext` → no unused-local risk); the 5 `max_cost_usd` cases PASS (positive accepted; negative/zero/>1000 rejected; absent → undefined).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts tests/unit/runtime/execution-payload.test.ts
git commit -m "feat(runtime): parse max_cost_usd + derive deadline/ceiling into agentContext (J8/J9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Cooperative deadline + cost gate at the top of the surface step loop

**Files:**
- Modify: `src/runtime/execution-handler.ts:657` (top of the `while` in `runSurfaceAgentLoop`)
- Test: `tests/unit/runtime/execution-handler.flow.test.ts`

> **Test seam:** the flow test registers a `StubSurfaceAgent` with `reasoning: { default: "direct" }`, so the loop builds whatever `strategyRouter.build` returns. We mock the `strategy-router` module to return a controllable fake engine: one whose `shouldContinue` stays `true` and whose `step` either (a) sleeps past the injected deadline (wall-clock) or (b) drives `costAccumulator.costCents` past the ceiling (cost). We also mock `harness-config` to inject a tiny `maxExecutionTimeMs`. Both mocks use `vi.hoisted` like the existing callback/gateway mocks.

- [ ] **Step 1: Write the failing test** — at the TOP of `tests/unit/runtime/execution-handler.flow.test.ts`, add two hoisted mocks alongside the existing `callbackMock`/`gatewayMock` (after the `gatewayMock` declaration at `:30`):

```typescript
const routerMock = vi.hoisted(() => ({
  strategyRouter: { build: vi.fn() },
}));
const configMock = vi.hoisted(() => ({
  maxExecutionTimeMs: 120000,
  maxCostUsd: 0,
}));
```

Then add these two `vi.mock` calls next to the existing ones (after the `llm-gateway` mock at `:41`):

```typescript
vi.mock("../../../src/reasoning/strategy-router", () => ({
  strategyRouter: routerMock.strategyRouter,
}));
vi.mock("../../../src/config/harness-config", async () => {
  const actual = await vi.importActual<typeof import("../../../src/config/harness-config")>(
    "../../../src/config/harness-config",
  );
  return {
    ...actual,
    getHarnessConfig: () => ({
      ...actual.getHarnessConfig(),
      harness: {
        ...actual.getHarnessConfig().harness,
        maxExecutionTimeMs: configMock.maxExecutionTimeMs,
        maxCostUsd: configMock.maxCostUsd,
      },
    }),
  };
});
```

> **NOTE on the config mock:** `execution-handler.ts` reads `const config = getHarnessConfig();` at MODULE LOAD (`:62`), so the mock MUST be registered before the handler import (it is — `vi.mock` is hoisted above the `import { handleExecution }` line). The handler's module-level `config` will be the mocked value. Tests mutate `configMock.maxExecutionTimeMs` in `beforeEach`/per-test; because `config` is captured once at import, set the value you need via the mock factory default and rely on `deadlineMs = devStartTs + config.harness.maxExecutionTimeMs` recomputing per-call (it does — `devStartTs` is per-execution). Keep `configMock.maxExecutionTimeMs` SMALL only for the abort tests by setting it before `handleExecution` runs; since `config` is frozen at import, instead pass the small budget through `getEnv`-independent path: the deadline uses `config.harness.maxExecutionTimeMs`, captured once. To make it controllable per-test WITHOUT re-importing, the mock factory reads `configMock.maxExecutionTimeMs` LAZILY inside `getHarnessConfig()` — but `config` at `:62` calls it ONCE. Therefore: set `configMock.maxExecutionTimeMs` in the test file's top-level scope BEFORE the suite runs for the abort cases, OR reset modules. The robust approach is `vi.resetModules()` + dynamic import per abort test. Use the helper below.

Add this helper near the top of the `describe("handleExecution", ...)` body (after the `ctx()` helper, ~:160), which re-imports the handler with a fresh small budget:

```typescript
  async function handleWithBudget(
    payload: Record<string, unknown>,
    opts: { maxExecutionTimeMs?: number; maxCostUsd?: number },
  ): Promise<{ handle: typeof handleExecution; run: Promise<void> }> {
    configMock.maxExecutionTimeMs = opts.maxExecutionTimeMs ?? 120000;
    configMock.maxCostUsd = opts.maxCostUsd ?? 0;
    vi.resetModules();
    const mod = await import("../../../src/runtime/execution-handler.js");
    return { handle: mod.handleExecution, run: mod.handleExecution(payload, ctx()) };
  }
```

In `beforeEach`, reset the router mock to a default direct-style engine (single step, then stop) so the existing passing tests keep working. Add to the existing `beforeEach` body (after `gatewayMock.createLLMGateway.mockReturnValue(gateway);` at `:141`):

```typescript
    routerMock.strategyRouter.build.mockReset();
    routerMock.strategyRouter.build.mockImplementation(() => {
      let stepped = false;
      return {
        strategy: "direct" as const,
        async plan() {
          return { goal: "g", steps: [], estimatedComplexity: "low" as const };
        },
        async step() {
          stepped = true;
          return { stepIndex: 0, success: true, durationMs: 1 };
        },
        async observe(stepResult: { stepIndex: number; success: boolean; durationMs: number }) {
          return { stepIndex: 0, summary: "ok", success: true, raw: stepResult, stopSignal: true };
        },
        async shouldContinue() {
          return !stepped; // run exactly one step then stop
        },
        async synthesize() {
          return {
            answer: "done",
            observations: [],
            totalSteps: 1,
            strategy: "direct" as const,
            escalated: false,
            retriesUsed: 0,
          };
        },
      };
    });
    configMock.maxExecutionTimeMs = 120000;
    configMock.maxCostUsd = 0;
```

Now append the three abort cases to the END of the `describe("handleExecution", ...)` block (just before its closing `});`):

```typescript
  it("aborts on wall-clock deadline (J8) → /complete sent + handler ACKs (terminal, dedup RETAINED)", async () => {
    // Engine that never stops and sleeps past the tiny budget each step.
    routerMock.strategyRouter.build.mockImplementation(() => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        await new Promise((r) => setTimeout(r, 30));
        return { stepIndex: 0, success: true, durationMs: 30 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: 0, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true; // never voluntarily stops → deadline must abort
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: 0,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));

    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const dedupKey = `harness:dedup:${VALID_UUID}`;
    const { run } = await handleWithBudget(basePayload(), { maxExecutionTimeMs: 20 });
    // Abort is TERMINAL: the handler ACKs (resolves WITHOUT rethrowing) so
    // BullMQ marks the job success → zero of the producer's attempts:7 are spent.
    await expect(run).resolves.toBeUndefined();

    // Terminal /complete emitted (backend does not see a stall).
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).toBe("aborted_timeout");
    // Abort RETAINS the dedup key (terminal; any same-id re-deliver hits SET NX).
    expect(await redis.get(dedupKey)).not.toBeNull();
  });

  it("aborts on cost ceiling (J9) AFTER the offending step, no extra step, handler ACKs, dedup RETAINED", async () => {
    let steps = 0;
    routerMock.strategyRouter.build.mockImplementation((_agent, agentContext) => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        steps += 1;
        // Drive the running cost past the ceiling on the FIRST step.
        if (agentContext.costAccumulator) agentContext.costAccumulator.costCents += 200;
        return { stepIndex: steps - 1, success: true, durationMs: 1 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: sr.stepIndex, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true;
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: steps,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));

    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const dedupKey = `harness:dedup:${VALID_UUID}`;
    // ceiling 1 USD = 100 cents; the first step pushes cost to 200c.
    const { run } = await handleWithBudget(basePayload({ max_cost_usd: 1 }), {
      maxExecutionTimeMs: 120000,
    });
    // Abort is TERMINAL: the handler ACKs (resolves WITHOUT rethrowing) → no
    // wasted producer retry.
    await expect(run).resolves.toBeUndefined();

    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(last.strategy).toBe("aborted_cost");
    // The gate runs at the TOP of the loop: step 1 runs (pushes cost), the loop
    // re-enters, the gate trips, no step 2. So exactly 1 step executed.
    expect(steps).toBe(1);
    // cost_ceiling is terminal → dedup key RETAINED (re-deliver absorbed by SET NX).
    expect(await redis.get(dedupKey)).not.toBeNull();
  });

  it("synthesize timeout (J8-b) routes to the failure boundary", async () => {
    routerMock.strategyRouter.build.mockImplementation(() => {
      let stepped = false;
      return {
        strategy: "direct" as const,
        async plan() {
          return { goal: "g", steps: [], estimatedComplexity: "low" as const };
        },
        async step() {
          stepped = true;
          return { stepIndex: 0, success: true, durationMs: 1 };
        },
        async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
          return { stepIndex: 0, summary: "ok", success: true, raw: sr, stopSignal: true };
        },
        async shouldContinue() {
          return !stepped; // one quick step, then exit loop → reach synthesize
        },
        async synthesize() {
          await new Promise((r) => setTimeout(r, 50)); // hang past the remaining budget
          return {
            answer: "late",
            observations: [],
            totalSteps: 1,
            strategy: "direct" as const,
            escalated: false,
            retriesUsed: 0,
          };
        },
      };
    });

    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const { run } = await handleWithBudget(basePayload(), { maxExecutionTimeMs: 30 });
    // phase_timeout from the synthesize wrapper is an abort → handler ACKs
    // (resolves WITHOUT rethrowing), emitting one /complete.
    await expect(run).resolves.toBeUndefined();
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    const last = callbackMock.sendComplete.mock.calls.at(-1)?.[2] as { strategy: string };
    // phase_timeout from the synthesize wrapper → aborted_timeout.
    expect(last.strategy).toBe("aborted_timeout");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- execution-handler.flow`
Expected: FAIL — `aborted_timeout`/`aborted_cost` strategies are not produced (the boundary still emits `failed`), the cost gate does not exist (no abort → the wall-clock case may hang then `failed`), and the cost case runs more than 1 step. (The synthesize-timeout case also fails because the wrapper is not yet applied — added in Task 9; expect `failed` not `aborted_timeout` until Task 9 + Task 10 land. These three tests go green progressively across Tasks 8/9/10; that is acceptable in TDD — they pin the target.)

- [ ] **Step 3: Write minimal implementation** — in `src/runtime/execution-handler.ts`, add the gate at the TOP of the `while` in `runSurfaceAgentLoop` (`:657`). Replace this exact line:

```typescript
  while (await engine.shouldContinue(allObservations, plan, agentContext)) {
    // Execute one step (wrapped in span)
```

with:

```typescript
  while (await engine.shouldContinue(allObservations, plan, agentContext)) {
    // J8 — deadline de wall-clock (cooperativo, checado ENTRE steps).
    if (agentContext.deadlineMs != null && Date.now() >= agentContext.deadlineMs) {
      throw new ExecutionAbortError(
        "wall_clock_timeout",
        `Execution exceeded wall-clock budget (deadline=${agentContext.deadlineMs})`,
      );
    }
    // J9 — teto de custo (determinístico ⇒ non-retryable). Checado ANTES do
    // próximo step: se o step anterior já cruzou o teto, aborta sem novo gasto.
    if (
      agentContext.costCeilingCents != null &&
      (agentContext.costAccumulator?.costCents ?? 0) >= agentContext.costCeilingCents
    ) {
      throw new ExecutionAbortError(
        "cost_ceiling",
        `Cost ceiling reached: ${agentContext.costAccumulator?.costCents}c >= ${agentContext.costCeilingCents}c`,
        /* retryable */ false,
      );
    }

    // Execute one step (wrapped in span)
```

> **Escalation interaction:** the two `continue` statements in the escalation branches (`:706`, `:723`) jump back to the `while` head, so the gate re-checks on every re-entry — no extra wiring needed. The checks sit OUTSIDE the step span, before any LLM spend.

- [ ] **Step 4: Run test to verify it passes (partial — wall-clock + cost)**

Run: `npm run test:unit -- execution-handler.flow`
Expected: the wall-clock case and the cost-ceiling case now reach the `catch` boundary, BUT until Task 11 the boundary still rethrows (no ACK-on-abort yet) and emits `strategy: "failed"` (discrimination + ACK land in Task 11), and the synthesize-timeout case still hangs/`failed` (Task 9). So: the `steps === 1` assertion in the cost case PASSES now; the `resolves.toBeUndefined()` + `strategy === "aborted_*"` + dedup-retained assertions still FAIL until Task 11 (the boundary still throws and clears the key). This is expected TDD progression — do NOT change the test expectations. Proceed to Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts tests/unit/runtime/execution-handler.flow.test.ts
git commit -m "feat(runtime): cooperative deadline + cost gate at top of surface step loop (J8-a/J9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Wrap the terminal `synthesize` in `runWithTimeout`

**Files:**
- Modify: `src/runtime/execution-handler.ts:1546-1557`
- Test: `tests/unit/runtime/execution-handler.flow.test.ts` (the synthesize-timeout case from Task 8 finalizes here, modulo the `aborted_timeout` label from Task 10)

> **HONEST LIMIT (reviewer concern 4):** this wrapper does NOT pass an `AbortController` — `synthesize` is a single terminal call with no step boundary to check cooperatively. So on timeout the handler Promise rejects and routes to the boundary, but the INNER `synthesize` fetch stays orphaned until the adapter's `AbortSignal.timeout(30s)` cap. If `remainingMs < 30s`, the wrapper wins; otherwise the adapter cap is the orphan ceiling. Do NOT claim "synthesize closed structurally" — only Option B does that.

- [ ] **Step 1: Write the implementation** — in `src/runtime/execution-handler.ts`, replace the synthesize block (`:1546-1557`). Replace this exact block:

```typescript
        // 11. Synthesize final response
        const engine = strategyRouter.build(agentDef, agentContext);
        const finalPlan = {
          goal: input,
          steps: [{ index: 0, description: "surface-execution" }],
          estimatedComplexity: "medium" as const,
        };
        const agentResponse: AgentResponse = await engine.synthesize(
          observations,
          finalPlan,
          agentContext,
        );
```

with:

```typescript
        // 11. Synthesize final response — agora bounded pelo deadline restante
        // (J8-b: fecha o buraco do synthesize não-bounded). reject-wrapper SEM
        // AbortController (chamada terminal única, sem step boundary): no
        // estouro o JOB é bounded, mas o fetch interno fica órfão até o
        // AbortSignal.timeout(30s) do adapter (risco §8.8 — NÃO é fix estrutural).
        const engine = strategyRouter.build(agentDef, agentContext);
        const finalPlan = {
          goal: input,
          steps: [{ index: 0, description: "surface-execution" }],
          estimatedComplexity: "medium" as const,
        };
        const remainingMs = Math.max(1, deadlineMs - Date.now());
        const agentResponse: AgentResponse = await runWithTimeout(
          engine.synthesize(observations, finalPlan, agentContext),
          remainingMs,
          `Synthesize(${agentName})`,
        );
```

> **`deadlineMs` scope:** it is declared in Task 7 right after `const env_ = getEnv();` (`:937`), which is inside the same `withSpan` async callback as the synthesize block (`:1553`) — so it is in scope here. `agentName` is already in scope (used at `:1539`).

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: exits 0. `runWithTimeout` accepts the 3-arg form (no controller); `deadlineMs` and `agentName` are in scope.

- [ ] **Step 3: Run the flow suite**

Run: `npm run test:unit -- execution-handler.flow`
Expected: the synthesize-timeout case now REJECTS (the wrapper fires), reaching the boundary — but `strategy` is still `failed` until Task 10. Wall-clock + cost cases unchanged from Task 8. Do NOT adjust expectations. Proceed to Task 10.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): bound terminal synthesize via runWithTimeout(remainingMs) (J8-b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Phase 2 gate — build + abort suite (still pre-discrimination)

**Files:** none (verification only)

- [ ] **Step 1: Build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 2: Confirm aborts REACH the boundary, even though it still rethrows + labels are still `failed`**

Run: `npm run test:unit -- execution-handler.flow`
Expected: the three abort cases (`aborts on wall-clock`, `aborts on cost ceiling`, `synthesize timeout`) currently FAIL on the `resolves.toBeUndefined()` (the boundary still rethrows — ACK-on-abort lands in Task 11), the `strategy === "aborted_*"`, and the dedup-retention assertions (all land in Phase 3 Task 11). The `steps === 1` assertion PASSES. This confirms Phase 2 logic (gates + synthesize bound) is wired; the boundary discrimination + ACK-terminal is Phase 3. Record this expected-partial state; do NOT weaken the tests.

> **Do NOT commit a green gate here** — Phase 2 intentionally leaves the three abort assertions red until Task 11 discriminates the outcome AND switches the boundary to ACK-on-abort. The next commit (Task 11) turns them green. This is the one cross-phase test that spans the boundary work.

---

## Phase 3 — Boundary discrimination, non-retryable guard, observability, governance

### Task 11: Boundary `catch` — discriminate outcome, ACK aborts (return, not rethrow), emit telemetry

**Files:**
- Modify: `src/runtime/execution-handler.ts` (catch boundary) + success path span attr
- Test: `tests/unit/runtime/execution-handler.flow.test.ts`

> This closes the three Phase 2 abort tests AND adds the mandatory §4.11 observability + the
> **§4.10 terminal-abort semantics** + the Redis-down edge case. The boundary stays the SINGLE
> emitter of the terminal error `/complete` (no double-complete). It does NOT add a new idempotency
> `kind` — per reviewer concern 5, `aborted_*` map to the same error `/complete` call-site (the
> sibling idempotency spec maps them to `kind: failed`).
>
> **THE CORE CHANGE (J8 fix): abort is TERMINAL → ACK (return), NOT rethrow.** The original boundary
> re-threw **unconditionally**, so every abort was replayed by the producer's `attempts:7` — 7 doomed
> re-runs while the backend had already handed off to a human at 120s (its 2-min cron scans
> `dispatched_at+120000ms` → `status=timeout`). The fix: after emitting `/complete`, `if (abort)
> return;` — ACK the job so BullMQ marks it success (zero retries). Retain the dedup key on aborts
> (defense in depth: any unexpected same-id re-delivery hits `SET NX` → silent return). Only non-abort
> (transient) errors clear the dedup key and rethrow, letting `attempts:7` apply.

- [ ] **Step 1: Write the failing test** — append these cases to the END of the `describe("handleExecution", ...)` block in `tests/unit/runtime/execution-handler.flow.test.ts` (the Task 8 abort cases already assert `aborted_timeout`/`aborted_cost` + dedup behavior, so they go green here; add the single-complete + Redis-down + observability guards):

```typescript
  it("emits exactly ONE /complete on a cost-ceiling abort (no double-complete)", async () => {
    routerMock.strategyRouter.build.mockImplementation((_agent, agentContext) => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        if (agentContext.costAccumulator) agentContext.costAccumulator.costCents += 500;
        return { stepIndex: 0, success: true, durationMs: 1 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: 0, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true;
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: 1,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const { run } = await handleWithBudget(basePayload({ max_cost_usd: 1 }), {
      maxExecutionTimeMs: 120000,
    });
    // Terminal abort → handler ACKs (resolves), exactly ONE /complete.
    await expect(run).resolves.toBeUndefined();
    expect(callbackMock.sendComplete).toHaveBeenCalledTimes(1);
  });

  it("cost_ceiling re-deliver is absorbed by SET NX (silent return, no second /complete)", async () => {
    routerMock.strategyRouter.build.mockImplementation((_agent, agentContext) => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        if (agentContext.costAccumulator) agentContext.costAccumulator.costCents += 500;
        return { stepIndex: 0, success: true, durationMs: 1 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: 0, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true;
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: 1,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    const { handle } = await handleWithBudget(basePayload({ max_cost_usd: 1 }), {
      maxExecutionTimeMs: 120000,
    });
    // first delivery: abort → handler ACKs (resolves), RETAINS the dedup key.
    await expect(handle(basePayload({ max_cost_usd: 1 }), ctx())).resolves.toBeUndefined();
    callbackMock.sendComplete.mockClear();
    // re-delivery of the SAME execution_id: SET NX returns null → silent return
    await handle(basePayload({ max_cost_usd: 1 }), ctx());
    expect(callbackMock.sendComplete).not.toHaveBeenCalled();
  });

  it("Redis-down in the abort boundary still emits the terminal /complete (no stall)", async () => {
    routerMock.strategyRouter.build.mockImplementation(() => ({
      strategy: "direct" as const,
      async plan() {
        return { goal: "g", steps: [], estimatedComplexity: "low" as const };
      },
      async step() {
        await new Promise((r) => setTimeout(r, 30));
        return { stepIndex: 0, success: true, durationMs: 30 };
      },
      async observe(sr: { stepIndex: number; success: boolean; durationMs: number }) {
        return { stepIndex: 0, summary: "x", success: true, raw: sr };
      },
      async shouldContinue() {
        return true;
      },
      async synthesize() {
        return {
          answer: "",
          observations: [],
          totalSteps: 0,
          strategy: "direct" as const,
          escalated: false,
          retriesUsed: 0,
        };
      },
    }));
    agentRegistry.register(new StubMessageAnalyzer());
    agentRegistry.register(new StubSurfaceAgent());
    // Make redis.del reject to simulate Redis-down during cleanup.
    const delSpy = vi.spyOn(redis, "del").mockRejectedValue(new Error("redis down"));
    const { run } = await handleWithBudget(basePayload(), { maxExecutionTimeMs: 20 });
    // Abort is TERMINAL: the handler ACKs (resolves WITHOUT rethrowing). The
    // abort path does NOT call redis.del (it returns first; the key is retained
    // by design), so Redis-down is inert for aborts. (If del were reached on a
    // transient error, its rejection is swallowed by .catch.)
    await expect(run).resolves.toBeUndefined();
    // Terminal /complete still went out (sendComplete does not depend on Redis).
    expect(callbackMock.sendComplete).toHaveBeenCalledOnce();
    delSpy.mockRestore();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- execution-handler.flow`
Expected: FAIL — the boundary still rethrows on abort (so `resolves.toBeUndefined()` fails) and emits `failed` (so `aborted_*` assertions fail), the cost abort still CLEARS the dedup key (so the re-deliver test sees a second `/complete`), and there is no span/log discrimination.

- [ ] **Step 3: Write minimal implementation** — in `src/runtime/execution-handler.ts`, rewrite the `catch` boundary (`:1662-1698`). Replace this exact block:

```typescript
      } catch (err) {
        logger.error({ execution_id, err }, "Execution failed");
        devBus?.emitEvent({
          kind: "execution.completed",
          executionId: execution_id,
          ts: Date.now(),
          durationMs: Date.now() - devStartTs,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });

        // Error boundary: attempt /complete with status=failed, swallow callback errors
        await sendComplete(
          execution_id,
          execution_token,
          buildCompletePayload({ responseText: "", sentiment: "neutral", strategy: "failed" }),
        ).catch((callbackErr) => {
          logger.warn({ callbackErr }, "Failed to send error /complete callback");
        });

        await sessionStore.update(execution_id, { status: "failed" }).catch(() => {});

        // C12 fix (auditoria 2026-06-02): a dedup key fica viva por 1h (set
        // NX EX 3600 acima). Se o BullMQ re-tentar o mesmo execution_id após
        // este throw, o `SET NX` retorna null e o handler faz return silencioso
        // (linha :754) — uma execução que FALHOU pode NUNCA ser re-executada.
        // Solução: deletar a dedup key antes do rethrow para que retries
        // legítimos possam reprocessar. Erros de Redis (down, timeout) são
        // engolidos — o throw original prevalece e o BullMQ tenta de novo.
        await ctx.redis.del(dedupKey).catch((delErr) => {
          logger.warn(
            { execution_id, delErr },
            "Failed to clear dedup key in error path; retries may be blocked until TTL expires",
          );
        });

        throw err;
      } finally {
```

with:

```typescript
      } catch (err) {
        logger.error({ execution_id, err }, "Execution failed");

        // J8/J9 — discrimina exhaustion de falha genérica. abort !== undefined
        // ⇒ wall_clock_timeout/cost_ceiling/phase_timeout. strategy distinto é
        // SÓ telemetria; pro contrato de idempotência os aborts mapeiam pro
        // mesmo desfecho de erro (spec irmã §4.4 ⇒ kind:"failed"). NÃO há novo
        // call-site de /complete: o boundary continua o ÚNICO emissor terminal.
        const abort = err instanceof ExecutionAbortError ? err : undefined;
        const strategy = abort
          ? abort.reason === "cost_ceiling"
            ? "aborted_cost"
            : "aborted_timeout"
          : "failed";

        devBus?.emitEvent({
          kind: "execution.completed",
          executionId: execution_id,
          ts: Date.now(),
          durationMs: Date.now() - devStartTs,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });

        // §4.11 — telemetria obrigatória (sem isto o abort fecha CEGO). O
        // harness não tem counters; usamos span attrs + 1 log estruturado.
        rootSpan.setAttribute("execution.outcome", strategy);
        rootSpan.setAttribute("execution.duration_ms", Date.now() - devStartTs);
        rootSpan.setAttribute("execution.cost_cents", costAccumulator.costCents);
        if (abort) {
          rootSpan.setAttribute("execution.abort.reason", abort.reason);
          // Log estruturado dedicado — plataformas alertam sobre RATE deste
          // event (substituto do counter). SEM PII (regra harness-llm.md).
          logger.warn(
            {
              event: "execution.aborted",
              execution_id,
              reason: abort.reason,
              cost_cents: costAccumulator.costCents,
              ceiling_cents: costCeilingCents ?? null,
              duration_ms: Date.now() - devStartTs,
              deadline_ms: deadlineMs,
            },
            "Execution aborted (bounding gate)",
          );
        }

        // Error boundary: attempt /complete with the discriminated strategy,
        // swallow callback errors. Único emissor terminal — sem double-complete.
        await sendComplete(
          execution_id,
          execution_token,
          buildCompletePayload({ responseText: "", sentiment: "neutral", strategy }),
        ).catch((callbackErr) => {
          logger.warn({ callbackErr }, "Failed to send error /complete callback");
        });

        await sessionStore.update(execution_id, { status: "failed" }).catch(() => {});

        // J8 — ABORT é desfecho TERMINAL, não transiente. Um abort de
        // wall-clock/cost já emitiu /complete (acima) ⇒ o backend conciliou o
        // desfecho. Re-tentar via BullMQ (attempts:7 do producer) só re-roda
        // uma execução condenada a re-abortar. Logo:
        //   • ACK do job (RETURN, sem rethrow) ⇒ BullMQ marca success ⇒ ZERO
        //     retries. O replay por staff cunha um novo execution_id de
        //     qualquer forma — não dependemos de re-entrega da MESMA id.
        //   • RETER a dedup key (NÃO limpar) ⇒ qualquer re-entrega da mesma id
        //     bate no SET NX ⇒ return silencioso (§4.10), defesa em profundidade.
        // Erro NÃO-abort (genuinamente transiente, ex.: backend unreachable):
        // limpa a dedup key e RETHROW ⇒ attempts:7 do producer ainda aplica.
        if (abort) {
          return;
        }

        // C12 fix: erro transiente ⇒ limpar a dedup key permite retry legítimo
        // com o MESMO execution_id (o SET NX subsequente re-adquire a key).
        await ctx.redis.del(dedupKey).catch((delErr) => {
          logger.warn(
            { execution_id, delErr },
            "Failed to clear dedup key in error path; retries may be blocked until TTL expires",
          );
        });

        throw err;
      } finally {
```

Then add the SUCCESS-path span attributes. Find the success `/complete` block (`:1572-1584`) and insert the attribute calls immediately AFTER the closing `);` of the `withSpan("execution.callback.complete", ...)` call (i.e., right after `:1584`). Find this exact line (the closing of that `withSpan`):

```typescript
        );

        // 13b. Post-execution hooks (eval sampling, etc.). Hooks run
```

and replace it with:

```typescript
        );

        // §4.11 — outcome dimension no caminho de sucesso (consultável pelo
        // OTEL p/ agregar taxa de abort por org/causa sem parsear string).
        rootSpan.setAttribute("execution.outcome", "ok");
        rootSpan.setAttribute("execution.cost_cents", costAccumulator.costCents);

        // 13b. Post-execution hooks (eval sampling, etc.). Hooks run
```

> **Scope check:** `rootSpan` is the `withSpan("execution.handle", ..., async (rootSpan) => {...})` callback param (`:850`); the entire try/catch lives inside it, so `rootSpan` is in scope in BOTH the success block and the catch. `costAccumulator` (Task 4, `:910`), `costCeilingCents`/`deadlineMs` (Task 7, after `:937`) are all declared inside the same callback before the try. Confirmed in scope.

- [ ] **Step 4: Run test to verify it passes + build**

Run: `npm run build && npm run test:unit -- execution-handler.flow`
Expected: build exits 0; ALL flow cases PASS — the three Task 8/9 abort cases now **ACK (resolve, not reject)** and see `aborted_timeout`/`aborted_cost`, every abort RETAINS the dedup key, the re-deliver is absorbed, the single-complete + Redis-down guards pass, and every pre-existing test (including the `failed` generic-error boundary — a plain `Error` is `abort === undefined` → `strategy = "failed"` → dedup cleared → **rethrow** so the producer's `attempts:7` can retry a transient error) is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts tests/unit/runtime/execution-handler.flow.test.ts
git commit -m "feat(runtime): discriminate abort outcome + ACK terminal abort (no rethrow) + telemetry (J8/J9 §4.10/§4.11)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Redelivery-depth observability hook in the consumer (§4.11.3)

**Files:**
- Modify: `src/integration/bullmq-consumer.ts`
- Test: none (the consumer's `job` plumbing is BullMQ runtime; a unit test would mock the entire `Worker`. Verified by build + reading the diff. The redelivery log is a fire-and-forget observability line, not load-bearing logic.)

> **Reviewer concerns 1 & 2:** concern 1 (producer `attempts`) is RESOLVED — `attempts:7` (spec OQ 5). With the ACK-terminal design (Task 11) aborts no longer re-deliver, so the retry-loop vector is removed for aborts; only transient non-abort errors can re-deliver (bounded to 7 by the producer's backoff). This log does NOT bound that (no DLQ exists), but makes any re-delivery (an unexpected same-id replay, or a transient-error retry) AUDITABLE so an alert can fire. True bounding of transient-error retries needs DLQ — out of scope (v2). Recorded in the DoD as open.

- [ ] **Step 1: Read the current consumer processor** to find the exact `handleExecution(job.data, ...)` call site.

Run: `grep -n "job\|handleExecution\|attemptsMade\|new Worker\|throw err" src/integration/bullmq-consumer.ts`
Expected: shows the processor function receiving `job`, the `handleExecution(...)` call, and the `throw err` at `:28`. Note the exact variable name for the job (likely `job`) and the surrounding `try`.

- [ ] **Step 2: Write the implementation** — in `src/integration/bullmq-consumer.ts`, inside the processor, BEFORE the `await handleExecution(...)` call, add a redelivery log guarded on `job.attemptsMade > 0`. Insert this at the start of the processor body (adapt the `job` var name to what Step 1 found; using `job`):

```typescript
    // §4.11.3 — re-delivery é INVISÍVEL hoje (cost_ceiling re-entregue é
    // absorvido silenciosamente pela dedup key; sem DLQ — CLAUDE.md "v2").
    // Logar attemptsMade torna o retry-loop AUDITÁVEL p/ alerta. NÃO bounda
    // o loop (isso exige DLQ + attempts do producer — fora de escopo).
    if (job.attemptsMade > 0) {
      logger.warn(
        {
          event: "execution.redelivery",
          execution_id: (job.data as { execution_id?: string } | undefined)?.execution_id,
          attemptsMade: job.attemptsMade,
        },
        "BullMQ re-delivered execution (no DLQ / no retry cap — see §4.11.3)",
      );
    }
```

> **`logger` import:** confirm the consumer already has a Pino `logger` in scope (it logs at `level:50` on Zod failure per CLAUDE.md). If the local logger var has a different name, adapt. If there is NO logger imported, add `import { createLogger } from "../config/logger.js";` and `const logger = createLogger();` at module top, matching the handler's pattern.

- [ ] **Step 3: Build to verify it compiles**

Run: `npm run build`
Expected: exits 0. `job.attemptsMade` is a standard BullMQ `Job` field (number).

- [ ] **Step 4: PRODUCER-CONFIG — ✅ RESOLVED (spec OQ 5).** Confirmed: the producer (bevox-backend)
  enqueues with **`attempts:7` + exponential backoff (~635s)**, queue `bevox.execution.dispatch`,
  `jobId=execution_id`. The consumer does NOT declare `attempts`/`backoff` (retry is
  producer-controlled). **This resolution drives the ACK-terminal design (Task 11):** since aborts
  ACK (return, not rethrow), none of the 7 attempts are spent on a doomed execution; only transient
  non-abort errors rethrow and benefit from `attempts:7`. The `execution.redelivery` log below stays
  useful for auditing transient-error re-deliveries (and any unexpected same-id replay). No longer a
  blocker.

Run: `grep -rn "attempts\|backoff" src/integration/bullmq-consumer.ts`
Expected: NO `attempts`/`backoff` declared on the `Worker` (confirms retry is producer-controlled,
consistent with the OQ 5 resolution).

- [ ] **Step 5: Commit**

```bash
git add src/integration/bullmq-consumer.ts
git commit -m "feat(consumer): auditable execution.redelivery log keyed on attemptsMade (§4.11.3)

Producer retry config RESOLVED (spec OQ 5): dispatch uses attempts:7 + exponential
backoff (~635s), queue bevox.execution.dispatch, jobId=execution_id. Aborts ACK
(terminal, no rethrow) so retries are spent only on transient non-abort errors.
This log makes redelivery auditable. No DLQ exists (v2) → retry-loop bounding of
transient errors is a v2 governance item.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Document `max_cost_usd` + `HARNESS_MAX_COST_USD` in the rule + reference files

**Files:**
- Modify: `.claude/rules/harness-payload.md`
- Modify: `skills/bevox-agent-harness-consumer/references/execution-payload.md`

- [ ] **Step 1: Confirm the reference file exists and find its field list.**

Run: `grep -n "execution_mode\|account_denied_tools\|Campos obrigatórios\|max_cost_usd" skills/bevox-agent-harness-consumer/references/execution-payload.md`
Expected: shows the existing optional/obligatory field list and NO `max_cost_usd` yet. If the file path differs, locate it: `ls skills/bevox-agent-harness-consumer/references/`.

- [ ] **Step 2: Add the field to the reference doc** — append a bullet to the optional-fields section of `skills/bevox-agent-harness-consumer/references/execution-payload.md` (place it after the `account_denied_tools` / `stream` entries; adapt heading to the file's structure). Insert:

```markdown
- `max_cost_usd: z.number().positive().max(1000).optional()` (J9 / runtime-gap
  J8-J9): teto de custo por-execução em USD. Quando ausente, cai no default
  `HARNESS_MAX_COST_USD` do env (0 = sem teto). Quando o custo acumulado
  (centavos, via `calculateCostCents` no `onUsage`) cruza o teto, o surface
  loop aborta com `ExecutionAbortError("cost_ceiling")` → `/complete` com
  `strategy:"aborted_cost"`. Opcional → minor change (regra "Ao adicionar
  campo novo"). Best-effort em streaming (usage não somado — gap conhecido).
```

- [ ] **Step 3: Add a status note to `.claude/rules/harness-payload.md`** — under the "Status de implementação (auditoria 2026-06-02)" section, append a bullet (after the `accountDeniedTools` entry):

```markdown
- `max_cost_usd` (teto de custo J9) + `HARNESS_MAX_COST_USD` (default env):
  **LANDED** (plano execution-bounding, 2026-06-02). Payload override (USD) >
  default env. Abort cooperativo no surface loop + `synthesize` bounded por
  `runWithTimeout`. Desfechos `strategy:"aborted_cost"`/`"aborted_timeout"`
  emitidos pelo ÚNICO call-site de erro (sem double-complete). **Abort é
  TERMINAL:** o handler emite `/complete` e faz ACK (return), NÃO rethrow — o
  producer enfileira com `attempts:7` + backoff exponencial (~635s) e re-tentar
  só re-roda execução condenada (o backend já fez human handoff aos 120s via
  timeout-scan em `dispatched_at+120000ms`). Só erros não-abort transientes
  re-lançam (e usam os `attempts:7`). Dedup key retida em todos os aborts
  (defesa em profundidade). `HARNESS_MAX_EXECUTION_TIME_MS` default baixado p/
  90000 (< 120000 do backend). **Aberto (cross-system):** (a) replay manual
  cunha novo `execution_id` → Idempotency-Key não deduplica → mutação de
  calendário duplicada (fix = lineage `original_execution_id`, PR #59; gate
  replay de mutações até lá); (b) sem DLQ (v2) p/ bound do retry-loop de erros
  transientes; (c) alinhamento de relógio ideal = backend carimbar
  `dispatched_at` no payload (cross-repo, v2).
```

- [ ] **Step 4: Verify the edits landed and reference nothing stale**

Run: `grep -n "max_cost_usd\|HARNESS_MAX_COST_USD\|aborted_cost\|aborted_timeout" .claude/rules/harness-payload.md skills/bevox-agent-harness-consumer/references/execution-payload.md`
Expected: matches in BOTH files; the new `max_cost_usd` field is documented and the status note records the LANDED state + the producer/DLQ open items.

- [ ] **Step 5: Commit**

```bash
git add .claude/rules/harness-payload.md skills/bevox-agent-harness-consumer/references/execution-payload.md
git commit -m "docs: document max_cost_usd payload field + HARNESS_MAX_COST_USD knob (J9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Final gate — full build, typecheck, unit suite, governance follow-ups

**Files:** none (verification + governance handoff)

- [ ] **Step 1: Full build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: both exit 0, no TypeScript errors.

- [ ] **Step 2: Full unit suite (NEVER the integration suite as a gate)**

Run: `npm run test:unit`
Expected: PASS — no regressions. The `RUN_INTEGRATION=1` integration tests are skipped by default (`describe.skipIf(!RUN)`); that is expected and CORRECT — do NOT run them as a gate.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: exits 0 (or only pre-existing warnings unrelated to the touched files).

- [ ] **Step 4: Regression spot-check — `autonomous_supervised` without a ceiling is byte-identical**

Run: `npm run test:unit -- execution-handler.flow`
Expected: the pre-existing "runs full pipeline → router → surface → complete callback" test PASSES unchanged — with `HARNESS_MAX_COST_USD=0` (mock default) and no `max_cost_usd`, `costCeilingCents` is `undefined` so the cost gate never trips, and a fast happy-path execution finishes well within the default 90s budget so the wall-clock gate never trips. Confirms no behavior change on the happy path.

- [ ] **Step 5: Governance follow-ups (out-of-repo — RECORD, do not block code).** These are not code commits; capture them so the reviewer's concerns are tracked:
  - **Producer retry config (concern 1): ✅ RESOLVED** — backend enqueues with `attempts:7` +
    exponential backoff (~635s), queue `bevox.execution.dispatch`, `jobId=execution_id`. This drove
    the ACK-terminal abort design (aborts ACK/return so the 7 attempts are not wasted on a doomed
    execution). No longer blocking.
  - **Backend clock coupling (cross-system):** the backend timeout-scan reconciles
    `dispatched_at+120000ms` (2-min cron → human handoff). `HARNESS_MAX_EXECUTION_TIME_MS` is now
    defaulted 90000 (< 120000) for margin. The robust fix is the backend stamping `dispatched_at`
    into the dispatch payload so the harness derives its deadline from the producer's clock (covers
    queue time + host clock skew) — cross-repo, recommended v2.
  - **Manual-replay idempotency lineage (cross-system, BLOCKS mutation replay):** staff manual
    replay mints a NEW `execution_id`, so the `execution_id`-derived Idempotency-Key does NOT dedup
    against the original → possible DUPLICATE calendar mutations. Recommended fix: an
    `original_execution_id` lineage payload field + derive keys from
    `original_execution_id ?? execution_id` (belongs in `2026-06-02-idempotency-key-full-threading-design.md` /
    PR #59). Until it lands, gate replay of appointment mutations.
  - **DLQ + retry cap (concern 2):** no DLQ exists; the `execution.redelivery` log is auditable but
    unbounded for transient-error retries. File as a v2 governance item.
  - **Cross-spec idempotency (concern 5):** confirm the sibling `2026-06-02-idempotency-key-full-threading-design.md` §4.4 maps `aborted_cost`/`aborted_timeout` to `kind: "failed"` (recommended) so the abort `/complete` key does not collide with a prior `failed` terminal. This plan deliberately added NO new `/complete` call-site and NO new idempotency `kind` to avoid the collision.
  - **SLO/alerts (§4.11.3):** define abort-rate (`aborted_timeout/total` < ~1% / 30d, burn-rate alert), cost-abort (alert on any sustained `aborted_cost`), and redelivery-depth (alert on `attemptsMade` crossing a threshold) in the hub `infra/` + runbook. Use the `bevox-knowledge-contribute` skill for the contract note on `aborted_*` `strategy` values.
  - **Streaming cost gap (concern 3):** track a follow-up for streaming-usage accumulation so J9 is enforceable under `STREAM_ENABLED`.

- [ ] **Step 6: Final commit (no-op if clean)**

```bash
git add -A
git commit -m "chore: final gate — J8/J9 bounding landed (Option A), build + unit suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage:**

- §4.3 `ExecutionAbortError` + `AbortReason` (typed, `retryable` advisory) → Task 1. ✓
- §4.3 `runWithTimeout` aborts optional `AbortController` → Task 2. ✓
- §4.4 `AgentExecutionContext.deadlineMs?/costCeilingCents?/costAccumulator?` → Task 3. ✓
- §4.5 `onUsage` accumulates cost via `meta.model` + `calculateCostCents` (+ over-count + streaming caveats) → Task 4. ✓
- §4.9 `HARNESS_MAX_COST_USD` env + `harness-config.maxCostUsd` → Task 5. ✓
- §4.9 `max_cost_usd` payload field → Task 7. ✓
- §4.6 derive `deadlineMs`/`costCeilingCents` + thread into `agentContext` → Task 7. ✓
- §4.7 cooperative deadline + cost gate at top of `while` (escalation `continue` re-checks) → Task 8. ✓
- §4.8 wrap `synthesize` in `runWithTimeout(remainingMs)` (honest no-AbortController limit) → Task 9. ✓
- §4.10 boundary discriminate outcome + **ACK terminal abort (return, not rethrow)** + dedup retention on aborts (single `/complete`) → Task 11. ✓
- §4.11 span attrs (`execution.outcome`/`abort.reason`/`cost_cents`/`duration_ms`) on catch AND success + structured `event:"execution.aborted"` log → Task 11. ✓
- §4.11.3 redelivery-depth log (`event:"execution.redelivery"` on `attemptsMade`) → Task 12. ✓
- §6 testing: cost accumulation (Task 4), `max_cost_usd` parse (Task 7), wall-clock/synthesize/cost-ceiling abort + single-complete + Redis-down + re-deliver-absorbed (Tasks 8/9/11) — all unit tier, never integration. ✓
- §5 Phase 3 docs: `harness-payload.md` + `execution-payload.md` (`max_cost_usd`) → Task 13. ✓
- §7 migration/rollback: Phase 1 inert (default env), Phase 2 gates, Phase 3 discrimination — each revertible → reflected in phase structure + Task 14 Step 4 byte-identical regression. ✓
- Non-goals respected: no `AbortSignal` threaded into `LLMRequestOptions`/adapters/decorators (Option B); no `UsageTracker` instantiation; no `execution_usage` persistence; no phase-budget re-slice. ✓

**Reviewer's 5 concerns:**
1. Producer retry config → ✅ RESOLVED (`attempts:7` + backoff ~635s). Drove the ACK-terminal abort design (Task 11): aborts ACK/return so no attempt is wasted on a doomed execution. Recorded in cross-cutting §1 + Task 12 Step 4 + DoD. ✓
2. No DLQ / unbounded retry-loop → mostly removed by ACK-terminal (aborts no longer re-deliver); residual is transient-error retries, made auditable not bounded by Task 12; recorded as open in §2 + Task 14 Step 5. ✓
3. Streaming cost sub-count → Task 4 implementation comment + Task 13 doc caveat + Task 14 Step 5 follow-up. ✓
4. Orphaned LLM fetches (Option A cooperative bound) → honest limits in Task 2/Task 9 comments; "do not claim structurally closed" in Task 9 + concern §4. ✓
5. Cross-spec idempotency collision → Task 11 adds NO new `/complete` call-site / NO new `kind`; recommendation (map `aborted_*` → `kind:failed`) recorded in §1 concern 5 + Task 14 Step 5. ✓

**2. Placeholder scan:** No "TBD"/"TODO"/"add error handling"/"similar to Task N". Every code step has full code. The few read/grep steps (Task 12 Steps 1/4, Task 13 Step 1) include exact commands + expected output + the adaptation to apply. The one deliberate cross-phase red state (Task 8/9 abort labels staying `failed` until Task 11) is explicitly documented with "do NOT weaken the tests" so it is not mistaken for a placeholder. ✓

**3. Type consistency:**
- `ExecutionAbortError(reason: AbortReason, message: string, retryable = true)` — defined Task 1; thrown in `runWithTimeout` (Task 2, `phase_timeout`), the loop (Task 8, `wall_clock_timeout` / `cost_ceiling`); read in the boundary (Task 11, `err instanceof ExecutionAbortError` → `abort.reason`). NOTE: with the ACK-terminal semantics, ALL aborts ACK/return regardless of `reason`/`retryable`; the `retryable` field is now advisory (telemetry) and does NOT govern the rethrow path (the discriminant is `abort === undefined`). Consistent. ✓
- `costAccumulator: { costCents: number }` — declared Task 4 (`:910`), threaded into context Task 7, mutated by tests via `agentContext.costAccumulator.costCents`, read by gate Task 8 (`agentContext.costAccumulator?.costCents`) and telemetry Task 11 (`costAccumulator.costCents`). Consistent. ✓
- `deadlineMs: number` / `costCeilingCents: number | undefined` — derived Task 7 after `:937`, in scope at the loop (Task 8 reads `agentContext.deadlineMs`/`agentContext.costCeilingCents`), synthesize (Task 9 reads `deadlineMs`), and boundary (Task 11 reads `deadlineMs`/`costCeilingCents`). Consistent. ✓
- `strategy: "aborted_cost" | "aborted_timeout" | "failed"` — string passed to `buildCompletePayload({ strategy })`; the test mock and the real `buildCompletePayload` both accept `strategy?: string`. Consistent. ✓
- `runWithTimeout(promise, ms, label, controller?)` — 4th arg optional; Task 9 calls the 3-arg form; existing callers (`:376`/`:1059`/`:1088`/`:1529`) unchanged. Consistent. ✓
- `harness.maxCostUsd: number` (Task 5) vs `HARNESS_MAX_COST_USD` env (Task 5) vs `payload.max_cost_usd` (Task 7) — handler resolves `payload.max_cost_usd ?? env_.HARNESS_MAX_COST_USD` (Task 7) and `config.harness.maxExecutionTimeMs` for the deadline. Consistent. ✓

**Issues found & fixed inline during review:**
- The spec offered "`execution-handler.ts` OR a new `errors.ts`" for the error type. Verifying the codebase showed NO `src/runtime/errors.ts` exists; I chose the new file (cleaner, lets the consumer import the type without a cycle through the 1700-line handler) and made Task 1 create it. (Resolved.)
- Verified `const config = getHarnessConfig()` is MODULE-LEVEL (`:62`), so a tiny `maxExecutionTimeMs` cannot be injected by mutating a mock after import — Task 8's `handleWithBudget` helper uses `vi.resetModules()` + dynamic re-import to pick up the per-test budget. (Resolved.)
- Verified `LLMResponse.usage.input_tokens` is non-optional `number`; the spec's `?? 0` is harmless defensive code and is kept verbatim so the handler block matches the spec exactly. (Resolved.)
- Verified the three abort flow-tests span Tasks 8→9→11 (gate → synthesize bound → discrimination). Rather than write throwaway intermediate expectations, the tests pin the FINAL target and the plan documents the expected-partial-red state at each intermediate gate (Task 8 Step 4, Task 10 Step 2) with explicit "do not weaken" guards. (Resolved.)
- Verified `rootSpan` (callback param `:850`), `costAccumulator` (`:910`), `deadlineMs`/`costCeilingCents` (after `:937`) are ALL in scope in both the success block and the catch — the §4.11 attributes compile without re-plumbing. (Resolved.)
