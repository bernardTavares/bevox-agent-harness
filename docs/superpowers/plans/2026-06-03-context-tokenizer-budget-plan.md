# Context Tokenizer Accuracy (CTX-04) + Convergent Budget Compression (CTX-05) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `words × 1.3` token heuristic with a model-aware BPE encoder (`o200k_base` via `js-tiktoken/lite`, lazy + fail-open) behind the unchanged synchronous `estimateTokens(text): number` seam (CTX-04), make `truncatePromptToBudget` iterative/convergent with a `withinBudget` post-condition invariant (CTX-05), and emit an estimate-vs-actual calibration ratio as an OTel span attribute reusing the existing `onUsage` seam (CTX-04 Option C).

**Architecture:** Three phases on a branch off `main` (compatible with — but NOT assuming — unmerged PR #61). Phase 1 swaps the tokenizer internals; the only shared symbol with #61 is `COMPRESSIBLE_MARKER` (imported, never redefined), and the only modules touched (`tokenizer.ts`, `budget-enforcer.ts`) are exactly the ones #61 leaves intact. Phase 2 wraps the single-pass truncation in a bounded fixed-point loop (`≤6` iterations) and adds an observable `withinBudget` field to `EnforcedContext`. Phase 3 captures the estimated prompt tokens after the gate and emits `context.token_estimate_ratio` + `context.tokenizer_fallback` in the existing `onUsage` callback.

**Tech Stack:** Node.js 20, TypeScript 5.9 (ESM/NodeNext — all relative imports use `.js` extensions; subpath package imports use the bare specifier `js-tiktoken/lite`), Vitest 4. `npm run build` = `tsc && node scripts/copy-skill-manifests.mjs`; `npm run typecheck` = `tsc --noEmit`; **unit gate** = `npm run test:unit` (= `vitest run tests/unit`). Run a single file with `npm run test:unit -- <path-or-substring>`. **NEVER** run the `RUN_INTEGRATION`-gated suite (`npm run test:integration`) — CTX-04/CTX-05 are pure/synchronous and need no DB/Redis/pgvector.

**Branch & coordination:**
- Land on a branch off `main` (e.g. `ctx-tokenizer-budget`). Do **NOT** assume PR #61 (`ctx-builder`) is present.
- **PR #61 interaction (explicit):** #61 rewrites `ContextBuilder.build()` (`Promise.allSettled` + per-layer timeout) and introduces `foldContext(..., { withMarker: true })` which inserts `COMPRESSIBLE_MARKER` between head and tail. #61 **does not touch** `tokenizer.ts` or `budget-enforcer.ts`, and it sets `agentConfig.maxContextTokens: undefined` so the builder's internal `compress()` never runs in prod. This plan touches ONLY `tokenizer.ts` + `budget-enforcer.ts` (+ optional wiring in `execution-handler.ts`). The single shared symbol is `COMPRESSIBLE_MARKER`, which this plan **imports and never redefines**. Either merge order is clean; #61's marker-aware fold inherits accurate counts + convergent compression for free. If you are working in a worktree that already has #61, verify after rebase that `budget-enforcer.ts` still exports `COMPRESSIBLE_MARKER` and that no second definition was introduced.
- **Out of scope (declared in the spec, restated so workers do not scope-creep):**
  - `ContextBuilder.compress()` (`src/context/context-builder.ts:32-64`) is also single-pass but is bypassed in prod under #61 (`maxContextTokens: undefined`); it stays single-pass. Registered as a known second site only.
  - **Model-C is ungated (spec §8 risk 8, the reviewer's highest-impact concern).** `_dispatchModelCImpl` (`src/runtime/execution-handler.ts:189`) calls `runSurfaceAgentLoop` (`:377`) with **no** `enforceBudget` (verified: `enforceBudget` only appears at `:1312`, inside `handleExecution`/ReAct). CTX-04's accurate counting helps any reader of `estimateTokens`, but CTX-05's convergent compression only protects the ReAct path. If the SDR pilot is truly OpenAI Model-C (spec open question 4), CTX-04/CTX-05 deliver only partial value until a one-line `enforceBudget` gate is wired into `_dispatchModelCImpl` before `:377`. **That wiring is explicitly NOT in this plan** (founder must decide open question 4 — recommended follow-up CTX-07). This plan adds a note in code (Task 8) so the gap is discoverable, but does not close it.
  - Headroom for user message + output tokens (spec open question 2 / CTX-06): the user turn is appended **after** the gate (`execution-handler.ts:1356-1360`), so a prompt that "fits" the gate can still overflow once the user turn is added. Accurate counting (CTX-04) makes this gap more visible, not worse. Deferred as CTX-06; **NOT closed here**. Flagged in the self-review gaps.

---

## File Structure

**Modified (Phase 1 — CTX-04 tokenizer):**
- `package.json` + lockfile — add runtime dep `js-tiktoken@^1.0.21` (pure-JS; transitive dep `base64-js`).
- `src/context/tokenizer.ts` — lazy module-level singleton encoder (`getEncoder()` with dynamic `import("js-tiktoken/ranks/o200k_base")`, fire-and-forget), `heuristicTokens` fallback, BPE-backed `estimateTokens` (signature unchanged), new exports `isUsingFallbackTokenizer()` and the test-only `__resetEncoderForTests()` + `__awaitEncoderForTests()`.
- `tests/unit/context/tokenizer.test.ts` — remove the `1.3` pin; add golden `o200k_base` BPE counts (encoder forced ready), keep the 4 generic monotonic/determinism cases, add a fallback-path case (mock the dynamic `import()` to reject).

**Modified (Phase 2 — CTX-05 convergence):**
- `src/context/budget-enforcer.ts` — `MAX_TRUNCATE_ITERATIONS = 6`; rewrite `truncatePromptToBudget` (`:212-245`) as a bounded convergent loop; add `withinBudget: boolean` to `EnforcedContext` (`:80-101`) and set it on all **3** return paths of `enforceBudget` (`:165` under, `:177` warning, `:192` compressed).
- `tests/unit/context/budget-enforcer.test.ts` — update the header comment + `makeWords` note for BPE; keep the 9 existing cases green; add the `withinBudget` tautology, convergence, regression, and termination cases.
- `src/runtime/execution-handler.ts:1329` — (optional, non-load-bearing) one `rootSpan.setAttribute("context.within_budget", enforced.withinBudget)`.

**Modified (Phase 3 — CTX-04 Option C calibration):**
- `src/context/calibration.ts` — **new** pure helper `computeCalibrationRatio(estimated, actual)` (extracted for testability).
- `src/runtime/execution-handler.ts` — `let estimatedPromptTokens = 0;` before `createLLMGateway` (~`:910`); assign `estimatedPromptTokens = enforced.finalTokens` after the gate (~`:1353`); in the existing `onUsage` (`:914-918`) emit `context.token_estimate_ratio` + `context.tokenizer_fallback`.
- `tests/unit/context/calibration.test.ts` — **new** unit test for `computeCalibrationRatio`.

**NOT modified (verified callers — signature unchanged, zero ripple):** the 5 layers (`base-config.layer.ts:14`, `rules.layer.ts:35`, `calendar.layer.ts:102`, `memory.layer.ts:137,178`, `history.layer.ts:76`), `context-builder.ts:60`, `budget-enforcer.ts` internal calls, `src/rag/chunker.ts` (multiple), `src/memory/message-embedding-indexer.ts:90`. **Note (gap not in spec):** `src/rag/chunker.ts:127-128` computes `wordsNeeded ≈ tokens / 1.3` — the inverse of the OLD heuristic. It still compiles and runs (benign RAG chunk-overlap sizing), but the `/ 1.3` inverse becomes semantically stale under BPE. Out of scope to fix here (RAG is CTX-03 territory); flagged in self-review so a reviewer does not mistake it for a regression.

---

## Phase 1 — Tokenizer BPE + fail-open fallback (CTX-04)

### Task 1: Add the `js-tiktoken` dependency

**Files:**
- Modify: `package.json` (+ lockfile)

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install js-tiktoken@^1.0.21
```
Expected: `package.json` gains `"js-tiktoken": "^1.0.21"` under `dependencies`; the lockfile gains `js-tiktoken` + transitive `base64-js`. No other dependency changes.

- [ ] **Step 2: Verify the subpath exports resolve (no source change yet)**

Run:
```bash
node --input-type=module -e "import('js-tiktoken/lite').then(m=>console.log('lite ok:', typeof m.Tiktoken)); import('js-tiktoken/ranks/o200k_base').then(m=>console.log('rank ok:', !!m.default));"
```
Expected: prints `lite ok: function` and `rank ok: true`. This confirms the `/lite` entry (zero embedded ranks) and the single `o200k_base` rank both resolve before we depend on them in code.

- [ ] **Step 3: Verify the build still compiles**

Run: `npm run typecheck`
Expected: exits 0 (the dep is installed but not yet imported, so this only proves the install did not break the tree).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(deps): add js-tiktoken 1.0.21 for model-aware token counting (CTX-04)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Replace `tokenizer.ts` with a lazy BPE singleton + fail-open heuristic

**Files:**
- Modify: `src/context/tokenizer.ts`
- Test: `tests/unit/context/tokenizer.test.ts`

> **Why test-only helpers (`__resetEncoderForTests`, `__awaitEncoderForTests`):** the encoder is a module-level singleton loaded via fire-and-forget dynamic `import()`. Because `estimateTokens` is synchronous and the `import()` resolves on a later microtask, the **first** calls of a process use the heuristic, and the encoder swaps in afterward. To pin **golden BPE counts** we must force the encoder ready (`await` the import) — otherwise we'd silently pin heuristic values (the reviewer's explicit concern). To test the **fallback** we must reset the singleton and mock the `import()` to reject. These helpers are the seam for both. They are prefixed `__` and documented as test-only; production code never calls them.

- [ ] **Step 1: Write the failing test** — replace the ENTIRE contents of `tests/unit/context/tokenizer.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import {
  estimateTokens,
  isUsingFallbackTokenizer,
  __resetEncoderForTests,
  __awaitEncoderForTests,
} from "../../../src/context/tokenizer.js";

// ---------------------------------------------------------------------------
// Generic invariants — true for ANY monotonic, deterministic tokenizer.
// These must hold whether the BPE encoder is warm or the heuristic fallback
// is active, so they do NOT await the encoder.
// ---------------------------------------------------------------------------
describe("estimateTokens — generic invariants (tokenizer-agnostic)", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(estimateTokens("   \n\t  ")).toBe(0);
  });

  it("returns a positive integer for non-empty text", () => {
    const result = estimateTokens("Hello, world!");
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("longer text produces more tokens", () => {
    const short = estimateTokens("Hello");
    const long = estimateTokens("Hello, this is a much longer sentence with many words.");
    expect(long).toBeGreaterThan(short);
  });

  it("is deterministic WITHIN A TICK (no await between calls)", () => {
    // Determinism is per-tick: the encoder only swaps state on a later
    // microtask, so two synchronous calls in the same tick are identical
    // regardless of whether the encoder is warm. Across the warm-up window
    // the SAME input can change value (heuristic -> BPE) exactly once.
    const text = "The quick brown fox jumps over the lazy dog.";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  it("handles multiline markdown sections", () => {
    const section = "## Heading\n- item 1\n- item 2\n- item 3";
    expect(estimateTokens(section)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Golden BPE counts — encoder FORCED READY via __awaitEncoderForTests().
// The expected numbers below are o200k_base (gpt-4o-mini) counts. They are
// pinned from the encoder itself (self-referential) so they cannot silently
// pin heuristic values: the test FIRST asserts the fallback is OFF, then
// asserts BPE properties that the heuristic cannot satisfy.
// ---------------------------------------------------------------------------
describe("estimateTokens — golden BPE counts (o200k_base, encoder ready)", () => {
  beforeAll(async () => {
    __resetEncoderForTests();
    await __awaitEncoderForTests();
  });

  it("the BPE encoder is active (NOT the heuristic fallback)", () => {
    // Guard: if this fails, every golden assertion below would silently be
    // pinning heuristic values. This MUST pass before trusting the counts.
    expect(isUsingFallbackTokenizer()).toBe(false);
    // Warm the encoder by counting once; the import is already resolved.
    estimateTokens("warm");
    expect(isUsingFallbackTokenizer()).toBe(false);
  });

  it("counts dense JSON above its heuristic word-count (structural undercount fixed)", () => {
    // `{"type":"object"}` is ~1 'word' for the heuristic (ceil(1*1.3)=2) but
    // many BPE tokens (dense punctuation). Asserting BPE > heuristic proves we
    // are NOT on the heuristic path AND that the JSON undercount is corrected.
    const json = '{"type":"object","properties":{"id":{"type":"string"}}}';
    const heuristicWords = json.trim().split(/\s+/).filter(Boolean).length;
    const heuristic = Math.ceil(heuristicWords * 1.3);
    expect(estimateTokens(json)).toBeGreaterThan(heuristic);
  });

  it("counts accented PT-BR prose above its heuristic word-count", () => {
    // Accented/agglutinated PT words tokenise above 1.3 tokens/word in o200k.
    const pt = "Olá! Não consigo remarcar a consulta para amanhã à tarde, обрigada.";
    const heuristicWords = pt.trim().split(/\s+/).filter(Boolean).length;
    const heuristic = Math.ceil(heuristicWords * 1.3);
    expect(estimateTokens(pt)).toBeGreaterThan(heuristic);
  });

  it("counts emoji above one token each", () => {
    // A single emoji is 1 'word' (ceil(1*1.3)=2 heuristic) but 3-5 BPE tokens.
    const emoji = "🎉🚀🔥";
    expect(estimateTokens(emoji)).toBeGreaterThanOrEqual(3);
  });

  it("plain ASCII English is stable and small", () => {
    // Sanity anchor: 'hello world' is a tiny, well-known count in o200k.
    const n = estimateTokens("hello world");
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Fallback path — force the dynamic import to reject; assert graceful
// degradation to the words*1.3 heuristic (fail-open, no throw).
// ---------------------------------------------------------------------------
describe("estimateTokens — fail-open fallback when the rank import fails", () => {
  beforeEach(() => {
    __resetEncoderForTests();
    // Make the dynamic import of the rank reject so the encoder never loads.
    vi.doMock("js-tiktoken/ranks/o200k_base", () => {
      throw new Error("simulated rank load failure");
    });
  });

  afterEach(() => {
    vi.doUnmock("js-tiktoken/ranks/o200k_base");
    __resetEncoderForTests();
  });

  it("returns a positive integer via the heuristic and flags the fallback", async () => {
    // First call triggers the import (which will reject on a later microtask).
    expect(estimateTokens("one two three")).toBeGreaterThan(0);
    // Let the rejected import settle, then a subsequent call stays on heuristic.
    await new Promise((r) => setTimeout(r, 0));
    const n = estimateTokens("one two three four five six seven eight nine ten");
    expect(n).toBe(13); // ceil(10 * 1.3) — the legacy heuristic value
    expect(isUsingFallbackTokenizer()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tokenizer`
Expected: FAIL — `isUsingFallbackTokenizer`, `__resetEncoderForTests`, and `__awaitEncoderForTests` are not exported from `tokenizer.js`.

- [ ] **Step 3: Write minimal implementation** — replace the ENTIRE contents of `src/context/tokenizer.ts`:

```typescript
/**
 * Token count — model-aware BPE (o200k_base) with a fail-open heuristic
 * fallback (CTX-04, audit `runtime-gap-audit-2026-06-02.md`).
 *
 * Replaces the `words * 1.3` heuristic (which systematically undercounted
 * PT-BR / dense JSON tool schemas / emoji) with a real BPE encoder, keeping
 * the synchronous signature `estimateTokens(text: string): number` intact so
 * none of the ~9 callers (5 layers, context-builder, budget-enforcer,
 * rag/chunker, message-embedding-indexer) or PR #61's marker-aware fold need
 * to change.
 *
 * IMPORTANT — import via the `js-tiktoken/lite` subpath + ONE rank file,
 * NEVER the default `"js-tiktoken"` entry. The default entry statically
 * imports all 7 rank tables (~5.4 MB) at `import` time; the lazy guard does
 * NOT avoid that cost. `js-tiktoken/lite` embeds no ranks; the single rank is
 * loaded by a dynamic `import()` INSIDE `getEncoder()`, so only 1 vocab loads
 * and only on the first call.
 *
 * The encoder is a module-level lazy SINGLETON: the rank is imported and the
 * BPE map built ONCE per worker process. A load failure -> fall back to the
 * legacy heuristic (fail-open; NOT a bootstrap failure). Because `import()`
 * is async but `estimateTokens` is sync, the load is fired fire-and-forget on
 * the first call and the heuristic serves until the encoder is ready (a
 * warm-up window of a few calls; spec §8 risk 1/2).
 */
import { Tiktoken, type TiktokenBPE } from "js-tiktoken/lite";

let encoder: Tiktoken | null = null;
let encoderLoadFailed = false;
let encoderLoading = false;
/**
 * Test seam only: resolves once the in-flight encoder load settles (either
 * `encoder` is set or `encoderLoadFailed` is true). Production never awaits.
 */
let loadPromise: Promise<void> | null = null;

/**
 * Optional kill-switch. When `HARNESS_BPE_TOKENIZER_ENABLED === "false"`,
 * `getEncoder()` short-circuits to the heuristic without firing the import —
 * useful if the rank ever causes a latency/memory regression in prod.
 */
function bpeDisabled(): boolean {
  return process.env.HARNESS_BPE_TOKENIZER_ENABLED === "false";
}

/**
 * Load/reuse the o200k_base encoder via the lite subpath + ONE rank.
 * Returns null while loading (early calls use the heuristic) and if the load
 * failed. Does NOT block: fires the rank `import()` fire-and-forget once.
 */
function getEncoder(): Tiktoken | null {
  if (encoder) return encoder;
  if (encoderLoadFailed || encoderLoading || bpeDisabled()) return null;
  encoderLoading = true;
  // Dynamic import of the SINGLE rank — does not pull the other 6 vocabs.
  loadPromise = import("js-tiktoken/ranks/o200k_base")
    .then((mod) => {
      encoder = new Tiktoken(mod.default as TiktokenBPE);
    })
    .catch(() => {
      encoderLoadFailed = true; // do not retry on every call
    })
    .finally(() => {
      encoderLoading = false;
    });
  return null; // first call (and any during the load) uses the heuristic
}

/** Legacy fallback: words * 1.3. Conservative for EN/PT (CTX-04 pre-fix). */
function heuristicTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

/**
 * Estimate the number of tokens in a string (integer >= 0).
 * Uses BPE o200k_base (gpt-4o/gpt-4o-mini, OpenAI primary) once the encoder
 * has loaded; falls back to the heuristic while loading or if the load fails.
 *
 * Determinism is PER-TICK: within one synchronous tick this is deterministic
 * (the encoder only swaps state on a microtask). Across the warm-up window the
 * SAME input may change value (heuristic -> BPE) the first time the encoder is
 * ready. Harmless for the gate (each execution counts once); tests that need
 * absolute determinism must force a state first (see `__awaitEncoderForTests`).
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  const enc = getEncoder();
  if (!enc) return heuristicTokens(text);
  try {
    return enc.encode(text).length;
  } catch {
    return heuristicTokens(text); // per-call defensive: never break the caller
  }
}

/** True once the encoder load has definitively failed (heuristic in use). */
export function isUsingFallbackTokenizer(): boolean {
  return encoderLoadFailed;
}

/**
 * TEST ONLY — reset the module-level singleton so a test can re-trigger the
 * load (e.g. after mocking the rank import to reject). Never called in prod.
 */
export function __resetEncoderForTests(): void {
  encoder = null;
  encoderLoadFailed = false;
  encoderLoading = false;
  loadPromise = null;
}

/**
 * TEST ONLY — force the encoder ready and resolve once the load settles, so a
 * test can pin golden BPE counts without racing the warm-up window. Triggers
 * the import (via a throwaway count) then awaits the in-flight promise. Never
 * called in prod.
 */
export async function __awaitEncoderForTests(): Promise<void> {
  estimateTokens("warm-up"); // fires getEncoder() -> sets loadPromise
  if (loadPromise) await loadPromise;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tokenizer`
Expected: PASS — generic invariants green; golden BPE block green with `isUsingFallbackTokenizer() === false`; fallback block green with `=== true` and the legacy `13`.

> **If a golden assertion fails:** do NOT loosen it to match a heuristic number. First confirm `isUsingFallbackTokenizer() === false` in the "encoder is active" test. If that test fails, the `__awaitEncoderForTests()` helper is not resolving the import — fix the helper, not the goldens. The goldens are intentionally **relational** (BPE > heuristic) rather than exact magic numbers precisely so a stale heuristic value cannot pass them.

- [ ] **Step 5: Commit**

```bash
git add src/context/tokenizer.ts tests/unit/context/tokenizer.test.ts
git commit -m "feat(context): model-aware BPE tokenizer with fail-open heuristic (CTX-04)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Phase 1 gate — build + typecheck + full unit suite

**Files:** none (verification only)

> **Why a full-suite gate here:** the tokenizer swap changes counts for ~9 callers at once. The most exposed neighbour is `budget-enforcer.test.ts`, whose `makeWords` helper synthesises inputs assuming `ceil(wordCount * 1.3)` (spec §8 risk 7). Run the whole unit suite now to surface any number-relation drift BEFORE Phase 2 touches the same file.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors. (`Tiktoken` / `TiktokenBPE` resolve from `js-tiktoken/lite`'s `.d.ts`.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS. If `budget-enforcer.test.ts` cases now fail on a numeric relation (e.g. "60 lines exceed 400 budget" no longer holds under BPE), record exactly which cases and how the relation shifted — Phase 2 (Task 4) will re-tune those constants while rewriting the suite. Do NOT patch them in this task; only note them.

- [ ] **Step 4: Commit (only if the build produced tracked changes; otherwise skip)**

```bash
git add -A
git commit -m "chore(context): phase 1 gate — build + unit suite green under BPE tokenizer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Convergent budget compression + invariant (CTX-05)

### Task 4: Add `withinBudget` to `EnforcedContext` and assert the invariant on all 3 paths

**Files:**
- Modify: `src/context/budget-enforcer.ts`
- Test: `tests/unit/context/budget-enforcer.test.ts`

> **This task adds the field + sets it on all 3 return paths but keeps `truncatePromptToBudget` single-pass** so the new tests pin the *contract* (`withinBudget === (finalTokens <= budgetTokens)`) before Task 5 makes the truncation actually converge. The regression case (single-pass leaves `finalTokens > budget`) is added in Task 5 where it can go green.

- [ ] **Step 1: Write the failing test** — replace the ENTIRE contents of `tests/unit/context/budget-enforcer.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";

import {
  enforceBudget,
  estimateToolTokens,
  COMPRESSIBLE_MARKER,
  DEFAULT_GLOBAL_MAX_TOKENS,
  MIN_PROMPT_TOKENS,
  type ToolForBudget,
} from "../../../src/context/budget-enforcer.js";
import {
  estimateTokens,
  __resetEncoderForTests,
  __awaitEncoderForTests,
} from "../../../src/context/tokenizer.js";

/**
 * CTX-04 note: the tokenizer is now BPE (o200k_base), not `ceil(words*1.3)`.
 * To keep counts STABLE across the whole file we force the encoder ready in
 * `beforeAll` (otherwise an early case could run on the heuristic and a later
 * one on BPE — spec §8 risk 7). Inputs are synthesised by word count for
 * convenience; assertions that matter derive their expected value from
 * `estimateTokens(...)` (self-referential) or assert RELATIONS, never raw
 * magic counts.
 */
beforeAll(async () => {
  __resetEncoderForTests();
  await __awaitEncoderForTests();
});

function makeWords(n: number, prefix = "w"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}

function makeTool(name: string, descWords: number): ToolForBudget {
  return { name, description: makeWords(descWords, "d"), parameters: {} };
}

describe("estimateToolTokens", () => {
  it("counts name + description + serialised parameters", () => {
    const tool: ToolForBudget = {
      name: "qualify-opportunity",
      description: makeWords(10, "d"),
      parameters: { type: "object", properties: { framework: { type: "string" } } },
    };
    const tokens = estimateToolTokens(tool);
    expect(tokens).toBeGreaterThan(0);
    const expected = estimateTokens(
      `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`,
    );
    expect(tokens).toBe(expected);
  });

  it("does not throw on a real-world tool schema with nested objects", () => {
    const tool: ToolForBudget = {
      name: "send-message",
      description: "Sends a message to the contact via WhatsApp",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          template: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    };
    expect(() => estimateToolTokens(tool)).not.toThrow();
  });
});

describe("enforceBudget — under-budget path", () => {
  it("returns prompt unchanged and wasCompressed=false when context fits", () => {
    const systemPrompt = makeWords(50, "p");
    const tools = [makeTool("t1", 5), makeTool("t2", 5)];
    const result = enforceBudget({ systemPrompt, tools, maxContextTokens: 5000 });
    expect(result.wasCompressed).toBe(false);
    expect(result.systemPrompt).toBe(systemPrompt);
    expect(result.finalTokens).toBe(result.originalTokens);
    expect(result.budgetTokens).toBe(5000);
    expect(result.warning).toBeUndefined();
    expect(result.withinBudget).toBe(true); // under budget -> within
  });

  it("falls back to DEFAULT_GLOBAL_MAX_TOKENS when maxContextTokens is undefined", () => {
    const systemPrompt = makeWords(20, "p");
    const result = enforceBudget({ systemPrompt, tools: [] });
    expect(result.budgetTokens).toBe(DEFAULT_GLOBAL_MAX_TOKENS);
    expect(result.wasCompressed).toBe(false);
    expect(result.withinBudget).toBe(true);
  });
});

describe("enforceBudget — over-budget path", () => {
  it("compresses the system prompt when total exceeds the budget", () => {
    const lines: string[] = [];
    for (let i = 0; i < 120; i++) lines.push(makeWords(16, `p${i}_`));
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 400 });
    expect(result.wasCompressed).toBe(true);
    expect(result.systemPrompt.length).toBeLessThan(systemPrompt.length);
    expect(result.finalTokens).toBeLessThan(result.originalTokens);
    expect(result.budgetTokens).toBe(400);
    expect(result.warning).toBeUndefined();
  });

  it("preserves the non-compressible head when COMPRESSIBLE_MARKER is present", () => {
    const head = ["## Doctrine", "Always be helpful.", "Always be honest."].join("\n");
    const tail = Array.from({ length: 800 }, (_, i) => `history line ${i}`).join("\n");
    const systemPrompt = `${head}${COMPRESSIBLE_MARKER}${tail}`;
    const result = enforceBudget({
      systemPrompt,
      tools: [],
      maxContextTokens: estimateTokens(head) + 300,
    });
    expect(result.wasCompressed).toBe(true);
    expect(result.systemPrompt.startsWith(head)).toBe(true);
    expect(result.systemPrompt.length).toBeLessThan(systemPrompt.length);
  });
});

describe("enforceBudget — edge cases", () => {
  it("emits a warning (does NOT abort) when tools alone exceed budget", () => {
    const huge = makeTool("huge-tool", 5000);
    const systemPrompt = makeWords(20, "p");
    const result = enforceBudget({ systemPrompt, tools: [huge], maxContextTokens: 500 });
    expect(result.wasCompressed).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("tool definitions alone");
    expect(result.systemPrompt).toBe(systemPrompt);
    // warning-not-abort ships the FULL prompt above budget -> not within.
    expect(result.withinBudget).toBe(false);
  });

  it("never trims below MIN_PROMPT_TOKENS budget headroom", () => {
    const tool = makeTool("t", 800);
    const toolTokens = estimateToolTokens(tool);
    const budget = toolTokens + Math.floor(MIN_PROMPT_TOKENS / 2);
    const systemPrompt = makeWords(1000, "p");
    const result = enforceBudget({ systemPrompt, tools: [tool], maxContextTokens: budget });
    expect(result.warning).toBeDefined();
    expect(result.systemPrompt).toBe(systemPrompt);
  });

  it("handles empty tools array", () => {
    const systemPrompt = makeWords(50, "p");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 5000 });
    expect(result.wasCompressed).toBe(false);
    expect(result.finalTokens).toBe(estimateTokens(systemPrompt));
  });
});

describe("enforceBudget — withinBudget invariant (CTX-05)", () => {
  it("withinBudget is ALWAYS the tautology (finalTokens <= budgetTokens)", () => {
    // Definition of the field. Exercised across under / warning / compressed.
    const cases = [
      enforceBudget({ systemPrompt: makeWords(20, "p"), tools: [], maxContextTokens: 5000 }),
      enforceBudget({
        systemPrompt: makeWords(20, "p"),
        tools: [makeTool("huge", 5000)],
        maxContextTokens: 500,
      }),
      enforceBudget({
        systemPrompt: Array.from({ length: 120 }, (_, i) => makeWords(16, `p${i}_`)).join("\n"),
        tools: [],
        maxContextTokens: 400,
      }),
    ];
    for (const r of cases) {
      expect(r.withinBudget).toBe(r.finalTokens <= r.budgetTokens);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- budget-enforcer`
Expected: FAIL — `EnforcedContext` has no `withinBudget` field (type error in the assertions; at runtime the property is `undefined` so `=== false`/`=== true` fail).

- [ ] **Step 3: Write minimal implementation** — in `src/context/budget-enforcer.ts`, add the `withinBudget` field to the `EnforcedContext` interface. Replace this exact block (currently `:93-100`):

```typescript
  /** True when the helper trimmed the system prompt. */
  wasCompressed: boolean;
  /**
   * Non-fatal warning emitted when the budget cannot be respected
   * (e.g. tools alone exceed it). Caller should log this and proceed —
   * the handler MUST NOT abort the execution (PRD invariant).
   */
  warning?: string;
}
```

with:

```typescript
  /** True when the helper trimmed the system prompt. */
  wasCompressed: boolean;
  /**
   * CTX-05: true when `finalTokens <= budgetTokens`. It is `false` in TWO
   * floor cases where the minimum content already overflows:
   *   (a) marker present and `head` alone >= budget -> returns head;
   *   (b) marker absent and the 3-line floor already exceeds the budget;
   * and in the warning-not-abort path (the full prompt ships above budget).
   * In all those cases the gate did its best and the caller should observe
   * `withinBudget === false` rather than treat it as a regression.
   */
  withinBudget: boolean;
  /**
   * Non-fatal warning emitted when the budget cannot be respected
   * (e.g. tools alone exceed it). Caller should log this and proceed —
   * the handler MUST NOT abort the execution (PRD invariant).
   */
  warning?: string;
}
```

Now set `withinBudget` on all 3 return paths of `enforceBudget`. Replace the under-budget return (currently `:166-172`):

```typescript
    return {
      systemPrompt: input.systemPrompt,
      originalTokens,
      finalTokens: originalTokens,
      budgetTokens,
      wasCompressed: false,
    };
```

with:

```typescript
    return {
      systemPrompt: input.systemPrompt,
      originalTokens,
      finalTokens: originalTokens,
      budgetTokens,
      wasCompressed: false,
      withinBudget: true, // originalTokens <= budgetTokens by the guard above
    };
```

Replace the warning return (currently `:177-184`):

```typescript
    return {
      systemPrompt: input.systemPrompt,
      originalTokens,
      finalTokens: originalTokens,
      budgetTokens,
      wasCompressed: false,
      warning: `tool definitions alone (${toolTokens} tokens) leave <${MIN_PROMPT_TOKENS} for system prompt under budget ${budgetTokens}; proceeding with full prompt`,
    };
```

with:

```typescript
    return {
      systemPrompt: input.systemPrompt,
      originalTokens,
      finalTokens: originalTokens,
      budgetTokens,
      wasCompressed: false,
      // Warning-not-abort ships the full prompt above budget on purpose.
      withinBudget: false,
      warning: `tool definitions alone (${toolTokens} tokens) leave <${MIN_PROMPT_TOKENS} for system prompt under budget ${budgetTokens}; proceeding with full prompt`,
    };
```

Replace the compressed return (currently `:192-198`):

```typescript
  return {
    systemPrompt: truncated,
    originalTokens,
    finalTokens,
    budgetTokens,
    wasCompressed: true,
  };
```

with:

```typescript
  return {
    systemPrompt: truncated,
    originalTokens,
    finalTokens,
    budgetTokens,
    wasCompressed: true,
    withinBudget: finalTokens <= budgetTokens, // CTX-05 observable invariant
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- budget-enforcer`
Expected: PASS — all 9 prior cases green (now with `withinBudget` set) + the tautology case green. (The compressed-path `withinBudget` may still be `false` for tight budgets — that is expected here; Task 5 makes it converge to `true` for compressible prompts.)

> **If the over-budget "compresses" case or the marker-preservation case fails** because the BPE counts shifted the line/budget relations: bump the synthetic sizes (already widened to 120 lines / 800 tail lines vs the old 60/400) until the prompt clearly exceeds the budget while individual lines stay far below it. Do not change the budget numbers in a way that makes the prompt fit (that would skip the compression branch entirely).

- [ ] **Step 5: Commit**

```bash
git add src/context/budget-enforcer.ts tests/unit/context/budget-enforcer.test.ts
git commit -m "feat(context): add observable withinBudget invariant to EnforcedContext (CTX-05)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Make `truncatePromptToBudget` iterative/convergent (≤6 iterations)

**Files:**
- Modify: `src/context/budget-enforcer.ts`
- Test: `tests/unit/context/budget-enforcer.test.ts`

- [ ] **Step 1: Write the failing test** — append these `describe` blocks to the END of `tests/unit/context/budget-enforcer.test.ts` (after the `withinBudget invariant` block, before EOF):

```typescript
describe("truncatePromptToBudget — convergence (CTX-05)", () => {
  it("converges to withinBudget=true for a compressible no-marker prompt", () => {
    // Many short lines (each << budget) with HIGH length variance: short
    // headers interleaved with long lines. Single-pass line-proportional
    // truncation overshoots here; the convergent loop must re-measure and fit.
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(i % 5 === 0 ? "#" : makeWords(20, `x${i}_`));
    }
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 500 });
    expect(result.wasCompressed).toBe(true);
    expect(result.withinBudget).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("converges to withinBudget=true for a compressible marker prompt", () => {
    const head = ["## Doctrine", "Be helpful."].join("\n");
    const tailLines: string[] = [];
    for (let i = 0; i < 400; i++) {
      tailLines.push(i % 4 === 0 ? "-" : makeWords(18, `h${i}_`));
    }
    const systemPrompt = `${head}${COMPRESSIBLE_MARKER}${tailLines.join("\n")}`;
    const budget = estimateTokens(head) + 250;
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: budget });
    expect(result.wasCompressed).toBe(true);
    expect(result.systemPrompt.startsWith(head)).toBe(true); // head intact
    expect(result.withinBudget).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("REGRESSION: a prompt where single-pass leaves finalTokens > budget now fits", () => {
    // Length variance: a few very long lines first, then many short ones.
    // Old single-pass keeps `floor(lines * ratio)` leading lines; because the
    // leading lines are the long ones, the kept slice overshoots the budget.
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(makeWords(60, `long${i}_`));
    for (let i = 0; i < 200; i++) lines.push(makeWords(3, `s${i}_`));
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 400 });
    expect(result.wasCompressed).toBe(true);
    expect(result.withinBudget).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(result.budgetTokens);
  });
});

describe("truncatePromptToBudget — termination (CTX-05)", () => {
  it("terminates with the head floor for a pathological marker prompt (head alone > budget)", () => {
    const head = makeWords(2000, "H"); // head alone far exceeds the budget
    const tail = makeWords(2000, "T");
    const systemPrompt = `${head}${COMPRESSIBLE_MARKER}${tail}`;
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 300 });
    expect(result.wasCompressed).toBe(true);
    // Floor: head returned, tail dropped, marker gone.
    expect(result.systemPrompt).toBe(head);
    expect(result.withinBudget).toBe(false); // floor overflows -> not within
  });

  it("terminates with the 3-line floor for a pathological no-marker prompt", () => {
    // Every individual line is itself bigger than the budget.
    const lines = Array.from({ length: 50 }, (_, i) => makeWords(500, `big${i}_`));
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 200 });
    expect(result.wasCompressed).toBe(true);
    // Floor is 3 leading lines; they still overflow, so not within budget.
    expect(result.systemPrompt.split("\n").length).toBe(3);
    expect(result.withinBudget).toBe(false);
  });

  it("does not spin: bounded by MAX_TRUNCATE_ITERATIONS (returns promptly)", () => {
    // A worst-case convergent prompt; we just assert it returns a finite,
    // sensible result rather than hang (the strict `keep` decrease + the
    // 6-iteration cap both guarantee termination).
    const lines = Array.from({ length: 1000 }, (_, i) =>
      i % 2 === 0 ? "x" : makeWords(30, `v${i}_`),
    );
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 300 });
    expect(result.wasCompressed).toBe(true);
    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.withinBudget).toBe(result.finalTokens <= result.budgetTokens);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- budget-enforcer`
Expected: FAIL — the convergence + regression cases fail (`withinBudget === false` / `finalTokens > budget`) because the current `truncatePromptToBudget` cuts once and never re-measures. (The termination floor cases may already pass; the convergence ones will not.)

- [ ] **Step 3: Write minimal implementation** — in `src/context/budget-enforcer.ts`, add the iteration bound constant immediately **above** the `COMPRESSIBLE_MARKER` declaration (currently `:140`). Insert:

```typescript
/**
 * Hard cap on re-measure iterations in `truncatePromptToBudget`. The `keep`
 * line count decreases strictly each pass (`floor(keep * r)` with `r < 1` and
 * integer `keep` => strictly smaller), so the loop terminates even without a
 * bound; this is an additional guard and a ceiling on BPE re-encode cost
 * (<=6 re-encodes of the tail/prompt per compression).
 */
const MAX_TRUNCATE_ITERATIONS = 6;
```

Then replace the ENTIRE `truncatePromptToBudget` function (currently `:212-245`). Replace this block:

```typescript
function truncatePromptToBudget(prompt: string, budget: number): string {
  const markerIdx = prompt.indexOf(COMPRESSIBLE_MARKER);

  if (markerIdx === -1) {
    // No marker: proportional reduction on whole prompt.
    const promptTokens = estimateTokens(prompt);
    if (promptTokens <= budget) return prompt;
    const ratio = budget / promptTokens;
    const lines = prompt.split("\n");
    const keep = Math.max(3, Math.floor(lines.length * ratio));
    return lines.slice(0, keep).join("\n");
  }

  const head = prompt.slice(0, markerIdx);
  const tail = prompt.slice(markerIdx + COMPRESSIBLE_MARKER.length);
  const headTokens = estimateTokens(head);

  if (headTokens >= budget) {
    // Head alone exceeds budget — return head, drop tail.
    return head;
  }

  const tailBudget = budget - headTokens;
  const tailTokens = estimateTokens(tail);
  if (tailTokens <= tailBudget) {
    return prompt;
  }

  const ratio = tailBudget / tailTokens;
  const tailLines = tail.split("\n");
  const keep = Math.max(1, Math.floor(tailLines.length * ratio));
  const truncatedTail = tailLines.slice(0, keep).join("\n");
  return `${head}${COMPRESSIBLE_MARKER}${truncatedTail}`;
}
```

with:

```typescript
/**
 * Line-based truncation that respects the optional `COMPRESSIBLE_MARKER`,
 * converging to `estimateTokens(result) <= budget` (CTX-05).
 *
 * Each branch cuts lines, RE-MEASURES, and repeats — shrinking `keep` by a
 * multiplicative fixed-point factor `keep * (budget / tokens)` — until the
 * content fits OR only the floor remains. `keep` decreases strictly each pass
 * so the loop terminates; `MAX_TRUNCATE_ITERATIONS` is a hard ceiling.
 *
 * Invariants preserved: with a marker the head is ALWAYS kept intact; the
 * terminal case is a FLOOR — head-only (marker, head >= budget) or 3 lines
 * (no marker). Post-condition: `estimateTokens(result) <= budget` EXCEPT when
 * the floor itself overflows (head alone, or the 3 floor lines), in which case
 * the floor is returned and the caller observes `withinBudget === false`.
 */
function truncatePromptToBudget(prompt: string, budget: number): string {
  const markerIdx = prompt.indexOf(COMPRESSIBLE_MARKER);

  // --- Marker absent: convergent cut over the whole prompt, floor 3 lines.
  if (markerIdx === -1) {
    const lines = prompt.split("\n");
    const promptTokens = estimateTokens(prompt);
    if (promptTokens <= budget) return prompt;
    let keep = Math.max(3, Math.floor(lines.length * (budget / promptTokens)));
    for (let i = 0; i < MAX_TRUNCATE_ITERATIONS; i++) {
      const candidate = lines.slice(0, keep).join("\n");
      const tokens = estimateTokens(candidate);
      if (tokens <= budget || keep <= 3) return candidate; // fits OR floor
      keep = Math.max(3, Math.floor(keep * (budget / tokens)));
    }
    return lines.slice(0, Math.max(3, keep)).join("\n"); // bound terminal
  }

  // --- Marker present: head kept intact, tail converges.
  const head = prompt.slice(0, markerIdx);
  const tail = prompt.slice(markerIdx + COMPRESSIBLE_MARKER.length);
  const headTokens = estimateTokens(head);
  if (headTokens >= budget) return head; // head-only floor

  const tailBudget = budget - headTokens;
  const tailLines = tail.split("\n");
  if (estimateTokens(tail) <= tailBudget) return prompt;

  let keep = Math.max(1, Math.floor(tailLines.length * (tailBudget / estimateTokens(tail))));
  let truncatedTail = tailLines.slice(0, keep).join("\n");
  for (let i = 0; i < MAX_TRUNCATE_ITERATIONS; i++) {
    const tailTokens = estimateTokens(truncatedTail);
    if (tailTokens <= tailBudget || keep <= 1) break; // fits OR 1-line floor
    keep = Math.max(1, Math.floor(keep * (tailBudget / tailTokens)));
    truncatedTail = tailLines.slice(0, keep).join("\n");
  }
  return `${head}${COMPRESSIBLE_MARKER}${truncatedTail}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- budget-enforcer`
Expected: PASS — convergence cases now reach `withinBudget === true` and `finalTokens <= budget`; the regression case fits; the termination cases return the floor with `withinBudget === false`; all 9 prior cases + the tautology stay green.

- [ ] **Step 5: Commit**

```bash
git add src/context/budget-enforcer.ts tests/unit/context/budget-enforcer.test.ts
git commit -m "feat(context): convergent bounded truncatePromptToBudget (CTX-05)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: (Optional) emit `context.within_budget` span attribute

**Files:**
- Modify: `src/runtime/execution-handler.ts:1329`

> **Optional, non-load-bearing.** This adds observability for the new invariant alongside the CTX-02 span attrs. If you skip it, the field is still asserted in tests; this only surfaces it in prod traces. Skipping it does NOT break the plan.

- [ ] **Step 1: Add the attribute** — in `src/runtime/execution-handler.ts`, after the existing CTX-02 span attrs (currently `:1326-1329`). Replace this exact block:

```typescript
        rootSpan.setAttribute("context.compressed", enforced.wasCompressed);
        rootSpan.setAttribute("context.original_tokens", enforced.originalTokens);
        rootSpan.setAttribute("context.final_tokens", enforced.finalTokens);
        rootSpan.setAttribute("context.budget_tokens", enforced.budgetTokens);
```

with:

```typescript
        rootSpan.setAttribute("context.compressed", enforced.wasCompressed);
        rootSpan.setAttribute("context.original_tokens", enforced.originalTokens);
        rootSpan.setAttribute("context.final_tokens", enforced.finalTokens);
        rootSpan.setAttribute("context.budget_tokens", enforced.budgetTokens);
        rootSpan.setAttribute("context.within_budget", enforced.withinBudget);
```

- [ ] **Step 2: Build + typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): emit context.within_budget span attribute (CTX-05)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Calibration telemetry (CTX-04 Option C)

### Task 7: Add the pure `computeCalibrationRatio` helper

**Files:**
- Create: `src/context/calibration.ts`
- Test: `tests/unit/context/calibration.test.ts`

> **Why a separate pure module:** the calibration math must be unit-testable without mocking the whole 800-line handler. Extracting it keeps the handler wiring in Task 8 to a thin call.

- [ ] **Step 1: Write the failing test** — create `tests/unit/context/calibration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

import { computeCalibrationRatio } from "../../../src/context/calibration.js";

describe("computeCalibrationRatio", () => {
  it("returns actual / estimated for valid positive inputs", () => {
    expect(computeCalibrationRatio(100, 130)).toBeCloseTo(1.3, 5);
  });

  it("returns 1 for an exact match", () => {
    expect(computeCalibrationRatio(500, 500)).toBe(1);
  });

  it("returns a ratio < 1 when we OVER-estimated (estimate too high)", () => {
    expect(computeCalibrationRatio(200, 150)).toBeCloseTo(0.75, 5);
  });

  it("returns null when estimated is 0 (no division)", () => {
    expect(computeCalibrationRatio(0, 130)).toBeNull();
  });

  it("returns null when actual is 0 or missing (no signal)", () => {
    expect(computeCalibrationRatio(100, 0)).toBeNull();
    expect(computeCalibrationRatio(100, undefined)).toBeNull();
  });

  it("returns null for negative inputs (defensive)", () => {
    expect(computeCalibrationRatio(-1, 130)).toBeNull();
    expect(computeCalibrationRatio(100, -5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- calibration`
Expected: FAIL — `src/context/calibration.js` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/context/calibration.ts`:

```typescript
/**
 * CTX-04 Option C — token-estimate calibration.
 *
 * Computes the ratio `actual / estimated` between the provider-reported
 * `usage.input_tokens` and our pre-call `estimateTokens` count, so accuracy
 * is observable in prod (emitted as an OTel span attribute by the handler).
 * Pure + side-effect-free for unit testing.
 *
 * Returns `null` when there is no usable signal (estimated <= 0, actual
 * missing/<= 0, or any negative input) so the caller can skip emitting an
 * attribute rather than record a misleading NaN/Infinity.
 */
export function computeCalibrationRatio(
  estimated: number,
  actual: number | undefined,
): number | null {
  if (typeof actual !== "number") return null;
  if (estimated <= 0 || actual <= 0) return null;
  return actual / estimated;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- calibration`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/context/calibration.ts tests/unit/context/calibration.test.ts
git commit -m "feat(context): pure computeCalibrationRatio helper (CTX-04 Option C)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire calibration + tokenizer-fallback telemetry into the handler

**Files:**
- Modify: `src/runtime/execution-handler.ts` (3 edits)

> **The data-flow constraint (verified):** `onUsage` is defined at `:914-918`, BEFORE the gate at `:1312`. The first LLM response is the only one whose `input_tokens` corresponds to the gated prompt (later turns accumulate history), so the ratio is informative, not exact, after turn 1. We capture the estimate by reference: declare `let estimatedPromptTokens = 0;` next to `usageAccumulator` (`:910`), assign it after the gate (`:1353`), and read it inside the closure. We also add a Model-C note at `_dispatchModelCImpl` so the ungated-path gap (spec §8 risk 8) is discoverable.

- [ ] **Step 1: Add imports** — at the top of `src/runtime/execution-handler.ts`, next to the existing `import { enforceBudget } from "../context/budget-enforcer.js";` (currently `:60`), add two imports. After that line, insert:

```typescript
import { computeCalibrationRatio } from "../context/calibration.js";
import { isUsingFallbackTokenizer } from "../context/tokenizer.js";
```

- [ ] **Step 2: Capture the estimate + emit telemetry in `onUsage`** — replace the `usageAccumulator` + gateway block (currently `:910-919`). Replace this exact block:

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
      // CTX-04 Option C: captured AFTER the budget gate (~:1353) by reference;
      // the closure reads it on the first LLM response to compare our estimate
      // against the provider's real `input_tokens`. 0 until the gate runs.
      let estimatedPromptTokens = 0;
      const gateway = createLLMGateway(
        { default_model: defaultModel },
        {
          onUsage: (usage) => {
            usageAccumulator.promptTokens += usage.input_tokens ?? 0;
            usageAccumulator.completionTokens += usage.output_tokens ?? 0;
            // Best-effort calibration telemetry (UsageDecorator already
            // swallows throws). null ratio -> no signal -> skip the attribute.
            const ratio = computeCalibrationRatio(estimatedPromptTokens, usage.input_tokens);
            if (ratio !== null) {
              rootSpan.setAttribute("context.token_estimate_ratio", ratio);
              rootSpan.setAttribute("context.tokenizer_fallback", isUsingFallbackTokenizer());
            }
          },
        },
      );
```

- [ ] **Step 3: Assign the estimate after the gate** — after `agentContext.systemPrompt = enforced.systemPrompt;` (currently `:1353`). Replace this exact line:

```typescript
        agentContext.systemPrompt = enforced.systemPrompt;
```

with:

```typescript
        agentContext.systemPrompt = enforced.systemPrompt;
        // CTX-04 Option C: hand the gated prompt estimate to the onUsage
        // closure (declared ~:910). The first LLM response's input_tokens is
        // the only one matching this prompt; later turns accumulate history,
        // so the emitted ratio is informative, not exact, after turn 1.
        estimatedPromptTokens = enforced.finalTokens;
```

- [ ] **Step 4: Add the Model-C gap note** — at `_dispatchModelCImpl`, immediately above the `runSurfaceAgentLoop(...)` call (currently `:377`). Find the line:

```typescript
      runSurfaceAgentLoop(agentDef, input, agentContext, permittedTools, executeTool),
```

and insert this comment on the line directly above it:

```typescript
      // CTX-05 GAP (spec §8 risk 8 / open question 4): this Model-C path is
      // NOT gated by enforceBudget (unlike the ReAct path at ~:1312). Accurate
      // counting (CTX-04) helps any estimateTokens reader, but convergent
      // compression only protects ReAct. Wiring enforceBudget here is a
      // deliberate follow-up (CTX-07); founder decides if the Model-C pilot
      // makes it urgent. Do NOT silently add the gate without that decision.
      runSurfaceAgentLoop(agentDef, input, agentContext, permittedTools, executeTool),
```

- [ ] **Step 5: Build + typecheck**

Run: `npm run typecheck`
Expected: exits 0 — `rootSpan` is in scope (the whole block is inside `async (rootSpan) => {` at `:850`); `estimatedPromptTokens` is captured by the closure.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): emit token_estimate_ratio + tokenizer_fallback telemetry (CTX-04 Option C)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Final gate — build + typecheck + full unit suite

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: exits 0, no errors (the `__`-prefixed test helpers and unused-import rules pass).

- [ ] **Step 4: Full unit suite**

Run: `npm run test:unit`
Expected: PASS — tokenizer (golden BPE + fallback), budget-enforcer (9 + invariant + convergence + termination), calibration, and all unrelated suites green. **Do NOT run `npm run test:integration`** (no DB/Redis needed; CTX-04/CTX-05 are pure).

- [ ] **Step 5: Manual hot-path review (no command — checklist)**

Confirm by reading `src/context/tokenizer.ts`:
- import is `from "js-tiktoken/lite"` (NOT `"js-tiktoken"`) — the default entry embeds all 7 ranks (~5.4 MB).
- the rank is loaded via `import("js-tiktoken/ranks/o200k_base")` inside `getEncoder()`, guarded by `encoderLoading` so it fires once.
- there is NO `new Tiktoken(...)` per call — it is constructed once inside the `.then()`.

- [ ] **Step 6: Commit (only if the build produced tracked changes; otherwise skip)**

```bash
git add -A
git commit -m "chore(context): final gate — build, typecheck, lint, unit suite green (CTX-04/CTX-05)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- §4.1 / §4.1.1 (BPE tokenizer, lazy singleton, fail-open, `/lite` + single rank, `isUsingFallbackTokenizer`) → Task 2. Dep add → Task 1. ✓
- §4.1.2 (Option C telemetry — capture estimate, emit `context.token_estimate_ratio` + `context.tokenizer_fallback`) → Tasks 7 + 8. ✓
- §4.2 (convergent `truncatePromptToBudget`, `MAX_TRUNCATE_ITERATIONS = 6`, head-preserving, floor terminals) → Task 5. ✓
- §4.2.1 (`EnforcedContext.withinBudget` on all 3 return paths) → Task 4. ✓
- §5 Phase 1 test plan (remove 1.3 pin; golden BPE with encoder awaited; 4 generic cases; fallback via mocked reject) → Task 2. **Reviewer concern addressed:** goldens are pinned with the encoder forced ready via `__awaitEncoderForTests()` AND a guard test asserts `isUsingFallbackTokenizer() === false` before trusting them, so heuristic values cannot be silently pinned. ✓
- §5 Phase 2 test plan (tautology always; convergence -> true for compressible; do NOT assert `finalTokens <= budget` for floor cases; regression; termination ≤6) → Tasks 4 + 5. Spec §8 risk 9 honored: invariant tests condition on `withinBudget`, never assert `finalTokens <= budget` for the pathological floor cases. ✓
- §5 Phase 3 (`computeCalibrationRatio` pure + test) → Task 7. ✓
- §6 testing strategy (new tests under `tests/**`; do not extend the dead co-located `src/context/tokenizer.test.ts`; no integration gating needed) → all new/modified tests under `tests/unit/context/`. ✓
- §7 rollback / feature flag (`HARNESS_BPE_TOKENIZER_ENABLED`) → implemented as `bpeDisabled()` in Task 2. ✓
- §8 risk 1/2 (import cost, warm-up window) → Task 2 docstring + Task 9 Step 5 checklist. ✓
- §8 risk 7 (test-constant drift under BPE) → Task 3 surfaces it; Task 4/5 re-tune sizes (60→120 lines, 400→800 tail) + force encoder ready in `beforeAll`. ✓
- §8 risk 8 + open question 4 (Model-C ungated) → explicitly out of scope; documented in the branch-coordination block AND surfaced in code via the Task 8 Step 4 comment. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows complete code. ✓

**3. Type consistency:** `estimateTokens(text: string): number` unchanged across all tasks. `isUsingFallbackTokenizer()`, `__resetEncoderForTests()`, `__awaitEncoderForTests()` declared in Task 2 and consumed identically in Tasks 4/5 tests and Task 8. `EnforcedContext.withinBudget: boolean` declared in Task 4 and read in Task 6. `computeCalibrationRatio(estimated: number, actual: number | undefined): number | null` declared in Task 7 and called with `(estimatedPromptTokens, usage.input_tokens)` in Task 8. `MAX_TRUNCATE_ITERATIONS` defined once in Task 5. ✓
