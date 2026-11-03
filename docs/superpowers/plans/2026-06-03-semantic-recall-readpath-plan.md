# Semantic-Recall Read Path — Wiring `getSemanticRecall()` into the MemoryLayer at Build Time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the dead read-path edge `getSemanticRecall()` → `MemoryLayerOptions.semanticRecall` so the recall branch in `MemoryLayer.build()` (`src/context/layers/memory.layer.ts:138-162`) becomes reachable in production — landed inert behind three independent flags (`CONTEXT_BUILDER_ENABLED`, `contactId != null`, `MEMORY_SEMANTIC_RECALL_ENABLED`), via a single construction site that is byte-identical to PR #61's recall edge so a main-first land and the later #61 merge converge idempotently.

**Architecture:** This plan **branches from `main`** and is **compatible with — but does NOT assume —** PR #61 (`origin/ctx-builder`, CTX-01). The recall edge itself (`semanticRecall: deps.memory?.semanticRecall ?? getSemanticRecall()`) is identical to #61's `builder-factory.ts:43`. The honest discovery from the design's adversarial review (§8 risk 6): #61 **rewrote** the orphan `ContextBuilder` of `main` (added `BuiltContext.blocks`, per-layer `layerTimeoutMs` + `Promise.race`, optional `contactId`). The `main` builder (`src/context/context-builder.ts`) **precedes** that rewrite. Therefore a main-first land that reuses `foldContext`/gating **must port the builder rewrite first** — this is materially "land the bulk of CTX-01", not "wire one fingerwidth edge". **Task 0 is a hard decision gate** that detects #61 presence and routes to Path A (wait/verify) or Path B (port-then-wire). Latency safety is non-negotiable: the per-layer timeout (`Promise.race`, default 800ms) is **ported in Path B** because the recall `embed()` is a real network call on the hot path with no ceiling in `main`.

**Tech Stack:** Node.js 20, TypeScript 5.9 (ESM/NodeNext — all relative imports use `.js` extensions), Vitest 4. `npm run build` = `tsc`; unit gate = `npm run test:unit`; **NEVER** run the `RUN_INTEGRATION=1` suite as part of the gate. New tests live under `tests/**` ONLY (vitest `include` is `tests/**/*.test.ts`; co-located `src/**/*.test.ts` files are NOT run by the unit gate). Conventional commits; commit messages end with the `Co-Authored-By` trailer shown in each task.

**Branch & coordination:**
- Run this in its own git worktree on branch `semantic-recall-readpath`, branched from `main`.
- **Compatibility with PR #61 (`origin/ctx-builder`) is load-bearing, not optional.** The ONLY edge this plan shares with #61 is the recall line in `createContextBuilder` — kept **byte-identical** so the merge is a structural no-op (resolve conflicts preferring #61's form). Everything else this plan creates (`builder-factory.ts`, `context-wiring.ts`, the builder rewrite, the env flags) is **also** created by #61 with the same names/defaults; on merge, prefer #61's copies. Do NOT add a knob passthrough (`semanticRecallTopK/MinScore/ExcludeRecent`) to `memoryOpts` — #61 does NOT have it (verified in `origin/ctx-builder` per spec §10), and it would be a functional no-op (the `...deps.memory` spread already copies those fields) that creates a merge diff.
- **Open question §8.1 is a project-management decision this plan cannot resolve alone.** Task 0 surfaces it explicitly. If #61 has a near-term merge, **Path A is strictly better** (zero divergence risk) and Path B should NOT be pursued.

---

## Reviewer concerns — disposition (read before starting)

Each remaining reviewer concern is addressed at a specific task or explicitly deferred. None is silently dropped.

1. **Hot-path latency/availability of recall (cache-miss embed + DB lookup + HNSW, no per-layer timeout in `main`).** ADDRESSED in **Task 3** (Path B ports #61's `layerTimeoutMs` + `Promise.race` into the builder) and gated in **Task 6 Step 4** (a `Promise.race` regression test). **EXPLICITLY DEFERRED:** the 800ms default is **unvalidated against the actual embedding provider P99** — see "Operational gates before flip" §A. Recall-on remains a hot-path hazard until that validation lands. The plan delivers the mechanism (timeout) but does NOT certify the default.
2. **`minScore` filtered AFTER `LIMIT topK` (`semantic-recall.ts:112-118`) can return 0–2 items at default topK=5/minScore=0.6.** EXPLICITLY OUT OF SCOPE (touches `recall()`, a stated non-goal). Recorded as a product decision in **"Unresolved product decisions" §C item 1**; **Task 8 Step 1** files it as a tracked follow-up rather than fixing it. The plan does NOT claim "recall complete and correct" without this calibration.
3. **`minScore=0.6` default unvalidated against real PT-BR SDR embeddings; compounds with post-LIMIT truncation.** EXPLICITLY DEFERRED to operational validation — "Operational gates before flip" §A item 2. Not fixable in code here; it is a calibration-against-data task.
4. **Double-compression even with the `globalMaxTokens` sentinel — needs confirming against #61's own call sites (CTX-01 review, not this plan).** ADDRESSED for this plan in **Task 4** (call `createContextBuilder` with `globalMaxTokens: Number.POSITIVE_INFINITY` so `?? 8000` is never reached) + **Task 4 Step 1** test asserting no internal compression at the sentinel. **FLAGGED FOR #61's REVIEW** in §C item 2: #61's `createContextBuilder` propagates `options.globalMaxTokens`, which arrives `undefined` from its call sites → #61 likely ALSO hits `?? 8000`. This plan files that as a CTX-01 review item; it is NOT this plan's job to fix #61.
5. **History/recall de-dup: `excludeRecent` (messages, `recency_rank`) vs History window (turns/tokens/budget-fit) are not commensurable; "keep aligned" is not mechanically enforceable.** EXPLICITLY DEFERRED — "Operational gates before flip" §A item 3 mandates an empirical measurement (how many messages History actually includes vs `excludeRecent`) before enabling. The plan does NOT pretend alignment is automatic; **Task 8 Step 1** records the measurement as a pre-flip gate.
6. **Scope/estimate honesty: main-first is "port CTX-01 + wire recall" (~6–9h), materially overlapping #61.** ADDRESSED head-on by **Task 0** (decision gate) and the honest Phase structure: Path B is labelled "port CTX-01 + wire recall", not "thin wire". Estimate stated as ~6–9h for Path B; ~2–3h for Path A.
7. **Pilot path (§8.2): if the SDR pilot runs via Model-C/`composeSystemPrompt` rather than the ContextBuilder, recall wired only into the builder will NOT fire for the pilot.** ADDRESSED by **Task 7** (a NON-CODE confirmation task that resolves which path the SDR pilot uses) gating **Task 5** (Model-C gating is implemented ONLY if Task 7 confirms Model-C goes through the builder; otherwise the plan records that the pilot needs separate wiring into `composeSystemPrompt`, which is OUT OF SCOPE here). The plan does NOT promise recall in the pilot without that confirmation.

### Operational gates before flipping `MEMORY_SEMANTIC_RECALL_ENABLED=true` in prod (§A)
These are NOT code tasks in this plan — they are pre-flip validations recorded so "done" is honest:
1. Validate the 800ms `CONTEXT_BUILDER_LAYER_TIMEOUT_MS` default against the embedding provider's measured P99 (concern 1).
2. Calibrate `MEMORY_SEMANTIC_RECALL_MIN_SCORE=0.6` against real PT-BR SDR embeddings (concerns 2/3).
3. Empirically measure History-layer message inclusion vs `excludeRecent=10` to confirm no overlap/gap (concern 5).

### Unresolved product decisions (§C)
1. Post-`LIMIT` `minScore` filtering (concern 2) — accept-as-is OR move the filter into SQL (`WHERE 1 - (embedding <=> q) >= minScore` before `LIMIT`), a 1-line change to `recall()` that relaxes the "do not touch `recall()`" non-goal. **Filed, not decided here.**
2. #61's own `globalMaxTokens` double-compression (concern 4) — **flagged for the CTX-01 review**, not owned by this plan.

---

## File Structure

**Decision artifact (Task 0):** no file change — a routing gate that determines whether Phase B runs.

**Created (Phase B — only if #61 NOT merged):**
- `src/context/builder-factory.ts` — `createContextBuilder(deps, options)`; the single construction site holding the recall edge. Responsibility: assemble the 4 layers (BaseConfig, Rules, Memory, History), inject `getSemanticRecall()` into `MemoryLayer`, construct the builder with the `globalMaxTokens` sentinel.
- `src/runtime/context-wiring.ts` — `buildContextInput(...)` (maps handler vars → `ContextInput`) + `foldContext(built, doctrineTail, opts)` (folds `built.blocks` + doctrine into the final system prompt with the compressible marker). Depends on `BuiltContext.blocks` (added in Task 2).

**Modified (Phase B — only if #61 NOT merged):**
- `src/context/types.ts` — add `blocks: ContextBlock[]` to `BuiltContext`; make `ContextInput.contactId` optional.
- `src/context/context-builder.ts` — port the #61 rewrite: per-layer `layerTimeoutMs` + `Promise.race`, populate `blocks` in `assemble()`, accept `layerTimeoutMs` option.
- `src/config/env.ts` — add `CONTEXT_BUILDER_ENABLED` (enum true/false, default false) + `CONTEXT_BUILDER_LAYER_TIMEOUT_MS` (default 800). Same names/defaults as #61 (`ctx-builder env.ts:173,178`).
- `src/runtime/execution-handler.ts` — gate the surface path (and Model-C path ONLY if Task 7 confirms) on `CONTEXT_BUILDER_ENABLED && contactId != null`; fallback to `composeSystemPrompt` + `enforceBudget` on any error or when the flag is off.

**Created (Phase C — both paths, the durable artifact):**
- `tests/unit/context/builder-factory.test.ts` — the construction site reads the getter, degrades to `undefined`, no spurious knob injection, sentinel disables internal compression.
- `tests/unit/context/memory-layer.recall.test.ts` — render / truncate / skip / fail-open on the recall branch.

**Modified (Phase C):**
- `tests/integration/memory/semantic-recall.integration.test.ts` — EXTEND with an end-to-end MemoryLayer-via-builder case (RUN_INTEGRATION-gated; NOT part of the unit gate).

---

## Phase A — Decision gate + #61-presence detection

### Task 0: Resolve open question §8.1 and detect #61 (decision gate, NO code)

**Files:** none (decision + branch routing only).

> **Why this is a task, not a preamble.** The design's adversarial review (§8 risk 6, §8.1) establishes that "main-first" ⇒ porting the bulk of CTX-01, NOT a thin wire. The effort delta between Path A (wait for/verify #61) and Path B (port + wire) is large and the choice is a genuine PM decision. This task forces it before any code.

- [ ] **Step 1: Detect whether #61's builder rewrite is present in the working tree**

Run:
```bash
git merge-base --is-ancestor origin/ctx-builder HEAD 2>/dev/null && echo "CTX-BUILDER MERGED" || echo "CTX-BUILDER NOT MERGED"
test -f src/context/builder-factory.ts && echo "builder-factory PRESENT" || echo "builder-factory ABSENT"
test -f src/runtime/context-wiring.ts && echo "context-wiring PRESENT" || echo "context-wiring ABSENT"
grep -q "blocks" src/context/types.ts && echo "BuiltContext.blocks PRESENT" || echo "BuiltContext.blocks ABSENT"
```
Expected on a clean branch from current `main`: `CTX-BUILDER NOT MERGED`, `builder-factory ABSENT`, `context-wiring ABSENT`, `BuiltContext.blocks ABSENT`.

- [ ] **Step 2: Route**

- **If ALL of `builder-factory PRESENT` + `context-wiring PRESENT` + `BuiltContext.blocks PRESENT` (i.e. #61 is in the tree):** take **Path A**. Skip Phase B entirely. Phase B Task 1 collapses to "verify the edge already exists" (see Task 1 Step A). Proceed directly to Phase C tests (Tasks 6, 8) + the Task 7 pilot-path confirmation. **Estimate: ~2–3h.**
- **If `BuiltContext.blocks ABSENT` (i.e. #61 is NOT in the tree):** take **Path B**. **Confirm with the founder that #61 has NO near-term merge** — if #61 will merge soon, STOP and prefer Path A (the design §4.5/§8.1 recommendation: Path B is only worthwhile when #61 is blocked). If proceeding, Phase B = "**port CTX-01 + wire recall**" (NOT "thin wire"). **Estimate: ~6–9h.**

- [ ] **Step 3: Record the decision in the commit history (lightweight marker)**

Run (substitute the chosen path):
```bash
git commit --allow-empty -m "chore(ctx-03): decision gate — taking Path <A|B> (see plan Task 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: an empty commit recording which path was chosen and why (#61 presence + founder confirmation for Path B).

---

## Phase B — (Path B only) Port the #61 ContextBuilder rewrite, then wire recall

> **SKIP THIS ENTIRE PHASE on Path A.** On Path A, `src/context/builder-factory.ts`, `src/runtime/context-wiring.ts`, the `BuiltContext.blocks` field, the `layerTimeoutMs` builder logic, and the env flags ALL already exist from #61. Verify the recall edge (Task 1 Step A) and move to Phase C.

### Task 1: Create (or verify) the construction site with the recall edge

**Files:**
- Create: `src/context/builder-factory.ts`
- Test: covered by `tests/unit/context/builder-factory.test.ts` (Task 6 — this task's behavior is asserted there; this task ships the source so Task 6 can go red→green if executed out of order, but the canonical TDD pair is Task 6).

> **Path A short-circuit (Task 1 Step A).** If #61 is present, do NOT create the file. Instead verify the edge is byte-identical to what this plan expects:
> ```bash
> grep -n "deps.memory?.semanticRecall ?? getSemanticRecall()" src/context/builder-factory.ts
> ```
> Expected: exactly one match. Confirm there is NO `semanticRecallTopK`/`MinScore`/`ExcludeRecent` reassignment in `memoryOpts` (it would be a no-op divergence). Then skip the rest of Task 1 and Tasks 2–5; go to Phase C.

- [ ] **Step 1 (Path B): Create `src/context/builder-factory.ts`**

```typescript
/**
 * CTX-01/CTX-03 — runtime construction site for the 5-layer ContextBuilder.
 *
 * This is the single place that reads the D.3 semantic-recall registry
 * (`getSemanticRecall()`) and injects it into the MemoryLayer, making the
 * dead recall branch in `memory.layer.ts:138-162` reachable in production.
 *
 * The recall edge below (`?? getSemanticRecall()`) is BYTE-IDENTICAL to PR #61
 * (`origin/ctx-builder` builder-factory.ts:43). Keeping it identical makes a
 * main-first land and the later #61 merge converge idempotently — resolve any
 * merge conflict preferring #61's copy.
 *
 * NOTE: do NOT add a knob passthrough (semanticRecallTopK/MinScore/ExcludeRecent)
 * to `memoryOpts`. #61 does not have it; the `...deps.memory` spread already
 * copies those fields; and the env knobs reach RagSemanticRecall via its
 * bootstrap-constructed `defaults` (stages.ts:481-487), not via MemoryLayer
 * options. Adding the passthrough would be a functional no-op that creates a
 * merge diff (spec §4.4 correction).
 */

import type { Pool } from "pg";

import { ContactFactsRepository } from "../memory/contact-facts.repository.js";
import { getSemanticRecall } from "../memory/registry.js";
import { BaseConfigLayer } from "./layers/base-config.layer.js";
import { HistoryLayer } from "./layers/history.layer.js";
import { MemoryLayer, type MemoryLayerOptions } from "./layers/memory.layer.js";
import { RulesLayer } from "./layers/rules.layer.js";
import { ContextBuilder } from "./context-builder.js";

export interface ContextBuilderDeps {
  db: Pool;
  /** Optional overrides — tests/fakes pass `semanticRecall`/`factsRepo` here. */
  memory?: MemoryLayerOptions;
}

export interface CreateContextBuilderOptions {
  /**
   * Per-layer timeout (ms). MUST be passed in production so a slow embedding
   * provider cannot hang the turn (spec §8 risk 1). Forwarded to ContextBuilder.
   */
  layerTimeoutMs?: number;
  /**
   * Internal-compression ceiling. Pass `Number.POSITIVE_INFINITY` to DISABLE
   * internal compression so the single budget gate is enforceBudget / the
   * marker-aware fold — NOT the builder's `?? 8000` fallback (spec §4.1
   * correction / §8 risk 4). Leaving this undefined would hit `?? 8000`.
   */
  globalMaxTokens?: number;
}

export function createContextBuilder(
  deps: ContextBuilderDeps,
  options: CreateContextBuilderOptions = {},
): ContextBuilder {
  const memoryOpts: MemoryLayerOptions = {
    // spread FIRST: explicit defaults below only fill what the caller omitted
    ...deps.memory,
    factsRepo: deps.memory?.factsRepo ?? new ContactFactsRepository(deps.db),
    // CTX-03 dead edge — reads the process-singleton populated at bootstrap.
    // IDENTICAL to #61 builder-factory.ts:43.
    semanticRecall: deps.memory?.semanticRecall ?? getSemanticRecall(),
  };

  const layers = [
    new BaseConfigLayer(),
    new RulesLayer(deps.db),
    new MemoryLayer(deps.db, memoryOpts), // ← recall read path now reachable
    new HistoryLayer(deps.db),
  ];

  return new ContextBuilder(layers, {
    layerTimeoutMs: options.layerTimeoutMs,
    globalMaxTokens: options.globalMaxTokens,
  });
}
```

> **Verify the layer constructor signatures before relying on them** (they are stable on `main` but `HistoryLayer` takes options): run `grep -n "constructor" src/context/layers/history.layer.ts`. `HistoryLayer`'s constructor is `(db, opts?)` — calling `new HistoryLayer(deps.db)` is valid (opts default). If your `main` differs, pass the same args the existing `context-builder.integration.test.ts` uses.

- [ ] **Step 2 (Path B): Build to verify it compiles against the NOT-yet-ported builder**

Run: `npm run build`
Expected: FAIL — `new ContextBuilder(layers, { layerTimeoutMs, globalMaxTokens })` is rejected because `ContextBuilderOptions` on `main` only has `globalMaxTokens` (no `layerTimeoutMs`). This failure is EXPECTED; Task 2 + Task 3 port the builder. (If you prefer green-at-every-commit, do Tasks 2+3 first, then return — but the file above is the target shape.)

- [ ] **Step 3 (Path B): Commit (will be green after Task 3)** — defer the commit; commit `builder-factory.ts` together with the builder rewrite in Task 3 Step 5 so the tree compiles. Mark this task done and proceed to Task 2.

---

### Task 2: (Path B) Add `BuiltContext.blocks` + make `ContextInput.contactId` optional

**Files:**
- Modify: `src/context/types.ts`

> **Why:** #61's `foldContext` reads `built.blocks` — a field that does NOT exist in `main`'s `BuiltContext` (verified: `types.ts:33-38` has only `systemPrompt/totalTokens/layersUsed/compressed`). And #61 relaxed `contactId` to optional. Both are prerequisites for reusing #61's wiring shape.

- [ ] **Step 1: Edit `src/context/types.ts`** — replace the `BuiltContext` interface (lines 33-38):

```typescript
export interface BuiltContext {
  systemPrompt: string;
  totalTokens: number;
  layersUsed: string[];
  compressed: boolean;
  /**
   * #61/CTX-01 — the assembled per-layer blocks (post-compression). The
   * marker-aware fold (`foldContext`) reads these to re-emit sections with
   * the compressible marker. Absent in pre-#61 `main`; added here so the
   * fold can consume it. (spec §8 risk 6)
   */
  blocks: ContextBlock[];
}
```

Then make `contactId` optional in `ContextInput` (line 4). Replace:

```typescript
  contactId: bigint;
```

with:

```typescript
  // #61/CTX-01 relaxed this to optional (recall/memory simply skip when absent).
  // The execution-handler gates the builder on `contactId != null` anyway.
  contactId?: bigint;
```

- [ ] **Step 2: Build to verify the surface of the change**

Run: `npm run build`
Expected: FAIL — `assemble()` in `context-builder.ts` returns a `BuiltContext` without `blocks`, and `memory.layer.ts` / other layers read `input.contactId` as `bigint` in SQL params. The `blocks`-missing error is the one Task 3 fixes; the `contactId` optionality is tolerated by the existing layers because they pass it straight into `db.query` params (Postgres accepts `undefined` → NULL, and the builder only runs when `contactId != null`). If TypeScript complains about `contactId` being possibly-undefined in a layer, leave the layer as-is — it is only invoked through the builder behind the `contactId != null` gate; cast at the call site in Task 4, not in the layer. Proceed to Task 3 (do not commit yet).

---

### Task 3: (Path B) Port the builder rewrite — `layerTimeoutMs` + `Promise.race` + populate `blocks`

**Files:**
- Modify: `src/context/context-builder.ts`

> **Why this is mandatory, not optional (spec §8 risk 1).** The recall `embed()` is `await`ed inside `MemoryLayer.build()` with NO timeout (`memory.layer.ts:140`), and `main`'s builder does a bare `Promise.all` (`context-builder.ts:19`). A slow/hung embedding provider would hang the whole turn. `budgetOk` only guards tokens, NOT latency, and the `CachingEmbedder` only helps on cache HITS — the recall query is the last user message, typically NEW → cache MISS → a real provider network call every turn. So Path B MUST port #61's `Promise.race(layer.build, timeout)`.

- [ ] **Step 1: Replace the ENTIRE contents of `src/context/context-builder.ts`**

```typescript
import { estimateTokens } from "./tokenizer.js";
import type { ContextInput, ContextBlock, ContextLayer, BuiltContext } from "./types.js";

interface ContextBuilderOptions {
  /** default 8000 (overridden by agentConfig.maxContextTokens, or by the
   *  POSITIVE_INFINITY sentinel from createContextBuilder to disable internal
   *  compression — spec §4.1 / §8 risk 4). */
  globalMaxTokens?: number;
  /**
   * Per-layer timeout (ms). When a layer's build() exceeds this, the builder
   * substitutes an empty block for that layer rather than hanging the turn.
   * Ported from #61 (ctx-builder context-builder.ts:60,65,104) — protects the
   * recall hot path against a slow embedding provider (spec §8 risk 1).
   * Default 800ms. NOTE: 800ms is UNVALIDATED against the embedding provider
   * P99 — see plan §A operational gate 1.
   */
  layerTimeoutMs?: number;
}

export class ContextBuilder {
  private readonly layers: ContextLayer[];
  private readonly globalMaxTokens: number;
  private readonly layerTimeoutMs: number;

  constructor(layers: ContextLayer[], options: ContextBuilderOptions = {}) {
    this.layers = [...layers].sort((a, b) => a.priority - b.priority);
    this.globalMaxTokens = options.globalMaxTokens ?? 8000;
    this.layerTimeoutMs = options.layerTimeoutMs ?? 800;
  }

  async build(input: ContextInput): Promise<BuiltContext> {
    // Each layer runs behind a per-layer timeout so a slow dependency (e.g. the
    // recall embedding provider) cannot hang the whole turn (spec §8 risk 1).
    const blocks = await Promise.all(
      this.layers.map((layer) => this.buildLayerWithTimeout(layer, input)),
    );

    const limit = input.agentConfig.maxContextTokens ?? this.globalMaxTokens;
    const totalTokens = blocks.reduce((sum, b) => sum + b.tokenEstimate, 0);

    if (totalTokens <= limit) {
      return this.assemble(blocks, false);
    }

    const compressed = this.compress(blocks, limit);
    return this.assemble(compressed, true);
  }

  private async buildLayerWithTimeout(
    layer: ContextLayer,
    input: ContextInput,
  ): Promise<ContextBlock> {
    const emptyBlock: ContextBlock = {
      section: "",
      content: "",
      tokenEstimate: 0,
      priority: layer.priority,
      compressible: layer.compressible,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<ContextBlock>([
        layer.build(input),
        new Promise<ContextBlock>((resolve) => {
          timer = setTimeout(() => resolve(emptyBlock), this.layerTimeoutMs);
        }),
      ]);
    } catch {
      // A layer that throws must not kill the build (fail-open, mirrors the
      // recall try/catch in memory.layer.ts:159-161).
      return emptyBlock;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private compress(blocks: ContextBlock[], limit: number): ContextBlock[] {
    const result = blocks.map((b) => ({ ...b }));

    for (let i = result.length - 1; i >= 0; i--) {
      const current = result.reduce((sum, b) => sum + b.tokenEstimate, 0);
      if (current <= limit) break;

      const block = result[i];
      if (!block.compressible) continue;

      const nonCompressibleTokens = result
        .filter((b) => !b.compressible)
        .reduce((sum, b) => sum + b.tokenEstimate, 0);
      const compressibleBudget = limit - nonCompressibleTokens;
      const compressibleTotal = result
        .filter((b) => b.compressible)
        .reduce((sum, b) => sum + b.tokenEstimate, 0);

      if (compressibleTotal <= compressibleBudget) break;

      const ratio = compressibleBudget / compressibleTotal;
      const lines = block.content.split("\n");
      const keepLines = Math.max(3, Math.floor(lines.length * ratio));
      block.content = lines.slice(0, keepLines).join("\n");
      block.tokenEstimate = estimateTokens(block.section + "\n" + block.content);
    }

    return result;
  }

  private assemble(blocks: ContextBlock[], compressed: boolean): BuiltContext {
    const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
    // Drop empty blocks (timed-out / empty layers) from the rendered prompt,
    // but keep them out of `blocks` too so the fold doesn't emit blank sections.
    const nonEmpty = sorted.filter((b) => b.section.length > 0 || b.content.length > 0);
    const systemPrompt = nonEmpty.map((b) => `${b.section}\n${b.content}`).join("\n\n");
    return {
      systemPrompt,
      totalTokens: sorted.reduce((sum, b) => sum + b.tokenEstimate, 0),
      layersUsed: nonEmpty.map((b) => b.section),
      compressed,
      blocks: nonEmpty,
    };
  }
}
```

- [ ] **Step 2: Verify the existing co-located builder test still reflects reality** — `src/context/context-builder.test.ts` exists on `main` and is NOT run by the unit gate (vitest include is `tests/**`). It is still useful as a reference. Read it:

Run: `grep -n "assemble\|globalMaxTokens\|blocks\|layerTimeout" src/context/context-builder.test.ts`
Expected: it constructs `new ContextBuilder([...], { globalMaxTokens })` and asserts on `systemPrompt/totalTokens/layersUsed/compressed`. Those assertions still hold (the new fields are additive). Do NOT edit this file (it is not on the gate and editing co-located tests is out of convention); if a Path-B reviewer wants it green, that is a separate cleanup.

- [ ] **Step 3: Build to verify the builder + factory now compile together**

Run: `npm run build`
Expected: exits 0. `builder-factory.ts` (Task 1) now compiles (the `layerTimeoutMs` option exists), and `assemble()` returns `blocks`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exits 0 (or, if `typecheck` is an alias of `build`, the same clean result).

- [ ] **Step 5: Commit the builder rewrite + factory together (compiles as a unit)**

```bash
git add src/context/types.ts src/context/context-builder.ts src/context/builder-factory.ts
git commit -m "feat(context): port #61 ContextBuilder rewrite (blocks + per-layer timeout) + recall construction site (CTX-01/CTX-03 Path B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: (Path B) Add `context-wiring.ts` + the env flags

**Files:**
- Create: `src/runtime/context-wiring.ts`
- Modify: `src/config/env.ts`

> **Double-compression mitigation lives here (spec §4.1 / §8 risk 4, reviewer concern 4).** `buildContextInput` leaves `agentConfig.maxContextTokens` undefined; that ALONE does NOT disable internal compression (the builder falls back to `?? 8000`). The single budget gate is guaranteed by passing `globalMaxTokens: Number.POSITIVE_INFINITY` to `createContextBuilder` at the call site (Task 5), so `?? 8000` is never reached. `tokenBudget` in `ContextInput` continues to control ONLY the recall SKIP, not compression.

- [ ] **Step 1: Create `src/runtime/context-wiring.ts`**

```typescript
/**
 * CTX-01 wiring helpers (Path B port of #61 `context-wiring.ts`).
 *
 * `buildContextInput` maps execution-handler locals into a `ContextInput`.
 * `foldContext` folds the builder's `blocks` + a doctrine tail into the final
 * system prompt, marking compressible sections so a downstream budget pass can
 * identify them.
 *
 * IMPORTANT (spec §4.1 / §8 risk 4): leaving `maxContextTokens` undefined here
 * does NOT disable the builder's internal compression. The single budget gate
 * is enforced by passing `globalMaxTokens: Number.POSITIVE_INFINITY` to
 * `createContextBuilder` at the call site (execution-handler) — NOT here.
 */

import type { ContextInput, BuiltContext } from "../context/types.js";

/** Marker prepended to compressible sections so a later budget pass can find them. */
export const COMPRESSIBLE_MARKER = "<!--compressible-->";

export interface BuildContextInputArgs {
  executionId: string;
  organizationId: string;
  contactId?: bigint;
  conversationKey: string;
  systemPrompt: string;
  dispatchPayload: Record<string, unknown>;
  /** Last user message verbatim — the recall query (spec §4.1). */
  userMessage?: string;
  /** Token budget HINT — controls only the recall skip, not compression. */
  tokenBudget?: number;
}

export function buildContextInput(args: BuildContextInputArgs): ContextInput {
  return {
    executionId: args.executionId,
    organizationId: args.organizationId,
    contactId: args.contactId,
    conversationKey: args.conversationKey,
    agentConfig: {
      systemPrompt: args.systemPrompt,
      // Intentionally undefined: the single budget gate is the INFINITY
      // sentinel passed to createContextBuilder, not this field.
      maxContextTokens: undefined,
    },
    dispatchPayload: args.dispatchPayload,
    userMessage: args.userMessage,
    tokenBudget: args.tokenBudget,
  };
}

export interface FoldContextOptions {
  /** When true, prefix compressible blocks with COMPRESSIBLE_MARKER. */
  withMarker?: boolean;
}

export function foldContext(
  built: BuiltContext,
  doctrineTail: string,
  opts: FoldContextOptions = {},
): string {
  const sections = built.blocks
    .filter((b) => b.section.length > 0 || b.content.length > 0)
    .map((b) => {
      const body = `${b.section}\n${b.content}`;
      return opts.withMarker && b.compressible ? `${COMPRESSIBLE_MARKER}\n${body}` : body;
    });
  const head = sections.join("\n\n");
  return doctrineTail.length > 0 ? `${head}\n\n${doctrineTail}` : head;
}
```

> **Path A note:** if #61 is present, `context-wiring.ts` already exists with `buildContextInput`/`foldContext`/`COMPRESSIBLE_MARKER`. Do NOT recreate it — reuse it and confirm the call site passes the `globalMaxTokens` sentinel.

- [ ] **Step 2: Add the env flags** — in `src/config/env.ts`, add the two flags inside the `z.object({...})` immediately after the `SDR_SPEED_TO_CONTACT_FASTPATH` line (line 168, the last field before the closing `})` at line 169). Insert:

```typescript
    // CTX-01/CTX-03 — runtime ContextBuilder instantiation + recall read path.
    // Default OFF: landing this wire is inert until explicitly enabled.
    // Same names/defaults as #61 (ctx-builder env.ts:173,178) for merge idempotency.
    CONTEXT_BUILDER_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Per-layer timeout ceiling (ms). Protects the recall hot path against a
    // slow embedding provider (spec §8 risk 1). 800ms is UNVALIDATED against the
    // provider P99 — see plan §A operational gate 1 before flipping recall ON.
    CONTEXT_BUILDER_LAYER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(800),
```

- [ ] **Step 3: Build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: exits 0. The env additions parse; `context-wiring.ts` compiles against `BuiltContext.blocks` (added in Task 2).

- [ ] **Step 4: Commit**

```bash
git add src/runtime/context-wiring.ts src/config/env.ts
git commit -m "feat(context): context-wiring (buildContextInput/foldContext) + CONTEXT_BUILDER_* env flags (CTX-01 Path B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: (Path B) Gate the surface path on the three flags

**Files:**
- Modify: `src/runtime/execution-handler.ts`

> **The recall edge is reached ONLY when the builder runs.** This gates the surface path on `CONTEXT_BUILDER_ENABLED && contactId != null`. Any error in the builder path falls back to `composeSystemPrompt` (`:933`/`:1266`) + `enforceBudget` (`:1312`) — the status quo. **Do NOT add `getSemanticRecall` to the handler imports** — the read stays encapsulated in `createContextBuilder` (matches #61; the `:45` import keeps only `getCondenseQueue, getMessageIndexer`).
>
> **Model-C gating is CONDITIONAL on Task 7.** Implement Model-C gating in this task ONLY if Task 7 confirms the SDR pilot's Model-C path actually flows through the ContextBuilder. If Task 7 finds the pilot uses `composeSystemPrompt` and bypasses the builder, do NOT wire Model-C here — instead record (Task 8) that pilot recall requires separate `composeSystemPrompt` wiring, which is OUT OF SCOPE.

- [ ] **Step 1: Locate the surface composeSystemPrompt site and the doctrine tail**

Run:
```bash
grep -n "composeSystemPrompt\|enforceBudget\|getEnv\|doctrine" src/runtime/execution-handler.ts | sed -n '1,40p'
```
Expected: the surface composition is at `:1266` (`agentContext.systemPrompt = composeSystemPrompt(...)`) and the budget enforcement at `:1312`. Read the surrounding ~40 lines to confirm the in-scope variable names for `executionId`, `organizationId`, `contactId`, `conversationKey`, the raw system prompt, the dispatch payload, the last user message, and the doctrine tail string. Use the EXACT local names found there in Step 2 (they differ between the Model-C and main scopes — see the mutation-tool plan's site inventory for precedent).

- [ ] **Step 2: Wrap the surface composition in the gate** — immediately BEFORE the existing `agentContext.systemPrompt = composeSystemPrompt(...)` at `:1266`, insert the builder branch. Replace the existing single assignment block:

```typescript
            agentContext.systemPrompt = composeSystemPrompt(
```

with the gated form (keep the original `composeSystemPrompt(...)` call intact as the `else`/fallback body — adjust the trailing args to match what is already there):

```typescript
            const envCtx = getEnv();
            let contextBuilt = false;
            if (envCtx.CONTEXT_BUILDER_ENABLED && agentContext.contactId != null) {
              try {
                const contextInput = buildContextInput({
                  executionId: agentContext.executionId,
                  organizationId: agentContext.organizationId,
                  contactId: agentContext.contactId,
                  conversationKey: agentContext.conversationKey,
                  systemPrompt: rawSystemPrompt,
                  dispatchPayload: payload as Record<string, unknown>,
                  userMessage: lastUserMessage,
                  tokenBudget: undefined,
                });
                const builder = createContextBuilder(
                  { db: agentContext.db as unknown as import("pg").Pool },
                  {
                    layerTimeoutMs: envCtx.CONTEXT_BUILDER_LAYER_TIMEOUT_MS,
                    // INFINITY sentinel: disables the builder's internal `?? 8000`
                    // compression so enforceBudget is the single gate (§8 risk 4).
                    globalMaxTokens: Number.POSITIVE_INFINITY,
                  },
                );
                const built = await builder.build(contextInput);
                agentContext.systemPrompt = foldContext(built, doctrineTail, { withMarker: true });
                contextBuilt = true;
              } catch (ctxErr) {
                logger.warn({ ctxErr }, "ContextBuilder failed — falling back to composeSystemPrompt");
              }
            }
            if (!contextBuilt)
              agentContext.systemPrompt = composeSystemPrompt(
```

> **Adjust to the real locals.** `rawSystemPrompt`, `lastUserMessage`, `doctrineTail`, and the way `agentContext.db` is typed all depend on the exact code at `:1266` (Step 1). The mutation-tool plan documents that `organizationId` is in scope at the main path (`:843` const) and as a function param in Model-C — reuse those. If `lastUserMessage` is not already computed in scope, derive it the same way #61 does: `payload.messages?.filter((m) => m.role === "user").map((m) => m.content).at(-1)`. If `doctrineTail` is not a single local, pass `""` (the fold tolerates an empty tail) and leave the doctrine in the raw system prompt as today.

- [ ] **Step 3: Add the imports** — at the top of `src/runtime/execution-handler.ts`, add (do NOT touch the `:45` registry import — `getSemanticRecall` is read inside the factory, not here):

```typescript
import { createContextBuilder } from "../context/builder-factory.js";
import { buildContextInput, foldContext } from "./context-wiring.js";
```

- [ ] **Step 4: Build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: exits 0. If TS objects to `agentContext.db` being passed where a `pg.Pool` is expected, narrow it with the existing pattern used elsewhere in the handler (the file already passes `db` into repositories — mirror that cast rather than inventing a new one).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): gate ContextBuilder (+recall read path) on CONTEXT_BUILDER_ENABLED && contactId (CTX-03 Path B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — Tests (both paths) + follow-ups

### Task 6: Unit test — the construction site reads the getter, degrades, no double-compression

**Files:**
- Test: `tests/unit/context/builder-factory.test.ts` (NEW — under `tests/**` so the unit gate runs it)

> **This is the canonical TDD pair for Task 1.** On Path A the source already exists; on Path B it was shipped in Task 1/3. Either way: write the test, run it RED if the edge is wrong, confirm GREEN.

- [ ] **Step 1: Write the failing test** — create `tests/unit/context/builder-factory.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";

import { createContextBuilder } from "../../../src/context/builder-factory.js";
import {
  setSemanticRecall,
  resetMemoryRegistryForTests,
} from "../../../src/memory/registry.js";
import type {
  SemanticRecall,
  RecalledMessage,
} from "../../../src/memory/semantic-recall.js";
import type { ContextInput } from "../../../src/context/types.js";

// A fake recall that returns one fixed hit and records that it was called.
function makeFakeRecall(hits: RecalledMessage[]): SemanticRecall & { calls: number } {
  return {
    calls: 0,
    async recall() {
      (this as { calls: number }).calls += 1;
      return hits;
    },
  } as SemanticRecall & { calls: number };
}

// Fake pg Pool: profile query returns one row, facts query returns none.
function makeDb() {
  return {
    query: vi
      .fn()
      // contact_profiles
      .mockResolvedValueOnce({ rows: [{ full_name: "Maria Souza", total_interactions: 1 }] })
      // contact_facts
      .mockResolvedValueOnce({ rows: [] }),
  };
}

const baseInput: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 99n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {},
  userMessage: "preciso remarcar meu horario",
};

const fixedHit: RecalledMessage = {
  messageId: "m-1",
  role: "user",
  content: "queria agendar para sexta",
  score: 0.82,
  messageAt: new Date("2026-04-01T10:00:00Z"),
};

describe("createContextBuilder — CTX-03 recall edge", () => {
  afterEach(() => {
    resetMemoryRegistryForTests();
  });

  it("reads getSemanticRecall() from the registry and the recall block renders", async () => {
    const fake = makeFakeRecall([fixedHit]);
    setSemanticRecall(fake);
    const builder = createContextBuilder(
      { db: makeDb() as never },
      { globalMaxTokens: Number.POSITIVE_INFINITY, layerTimeoutMs: 5000 },
    );
    const built = await builder.build(baseInput);
    expect(fake.calls).toBe(1);
    expect(built.systemPrompt).toContain("### Memorias semanticamente relevantes");
    expect(built.systemPrompt).toContain("queria agendar para sexta");
  });

  it("degrades to undefined recall (no block, NO throw) when the registry is unset", async () => {
    resetMemoryRegistryForTests(); // ensure no recall registered
    const builder = createContextBuilder(
      { db: makeDb() as never },
      { globalMaxTokens: Number.POSITIVE_INFINITY, layerTimeoutMs: 5000 },
    );
    const built = await builder.build(baseInput);
    expect(built.systemPrompt).not.toContain("### Memorias semanticamente relevantes");
  });

  it("prefers an explicit deps.memory.semanticRecall over the registry", async () => {
    const registryFake = makeFakeRecall([fixedHit]);
    setSemanticRecall(registryFake);
    const overrideFake = makeFakeRecall([{ ...fixedHit, content: "OVERRIDE HIT" }]);
    const builder = createContextBuilder(
      { db: makeDb() as never, memory: { semanticRecall: overrideFake } },
      { globalMaxTokens: Number.POSITIVE_INFINITY, layerTimeoutMs: 5000 },
    );
    const built = await builder.build(baseInput);
    expect(overrideFake.calls).toBe(1);
    expect(registryFake.calls).toBe(0); // `?? getSemanticRecall()` short-circuits
    expect(built.systemPrompt).toContain("OVERRIDE HIT");
  });

  it("does NOT compress internally at the INFINITY sentinel (single budget gate is external)", async () => {
    const fake = makeFakeRecall([fixedHit]);
    setSemanticRecall(fake);
    const builder = createContextBuilder(
      { db: makeDb() as never },
      { globalMaxTokens: Number.POSITIVE_INFINITY, layerTimeoutMs: 5000 },
    );
    const built = await builder.build(baseInput);
    // With the sentinel, the builder never crosses its limit → never compresses.
    expect(built.compressed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the unit gate (scoped) to verify it fails (Path A) or passes (Path B)**

Run: `npm run test:unit -- builder-factory`
Expected:
- **Path A / Path B with source present:** PASS — the edge exists.
- **If the source is missing or the edge is wrong** (e.g. someone added the spurious knob passthrough that broke the `??` short-circuit): FAIL. Fix the source to match Task 1's exact edge, then re-run.

- [ ] **Step 3: Confirm the `?? getSemanticRecall()` short-circuit is byte-identical to #61**

Run: `grep -n "deps.memory?.semanticRecall ?? getSemanticRecall()" src/context/builder-factory.ts`
Expected: exactly one match, with NO `semanticRecallTopK`/`MinScore`/`ExcludeRecent` reassignment anywhere in `memoryOpts`.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/context/builder-factory.test.ts
git commit -m "test(context): builder-factory reads recall registry, degrades, no double-compress (CTX-03)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Confirm the SDR pilot path (NO code — gates Model-C wiring)

**Files:** none (investigation + decision).

> **Reviewer concern 7 / spec §8.2 (potentially decisive).** The audit says `composeSystemPrompt` — NOT the ContextBuilder — receives the first real SDR job. If the SDR pilot runs via Model-C/`composeSystemPrompt` and that bypasses the builder, recall wired ONLY into the builder will NOT fire for the pilot, defeating the purpose. This task resolves which path the pilot uses BEFORE promising recall in the pilot.

- [ ] **Step 1: Trace the Model-C dispatch and whether it ever reaches the builder**

Run:
```bash
grep -n "_dispatchModelC\|composeSystemPrompt\|createContextBuilder\|Model-C\|model_c\|modelC" src/runtime/execution-handler.ts
grep -rn "composeSystemPrompt" src/sdr/ src/runtime/
```
Expected: identify whether the Model-C dispatch sets `agentContext.systemPrompt` exclusively via `composeSystemPrompt` (`:239`/`:933`) and never calls `createContextBuilder`.

- [ ] **Step 2: Decide and record**

- **If Model-C flows through (or can be gated through) the ContextBuilder:** extend Task 5's gate to the Model-C composition site (the `:239`/`:933` `composeSystemPrompt` assignments), mirroring the surface branch. Then the pilot gets recall via the builder.
- **If the SDR pilot uses `composeSystemPrompt` and bypasses the builder:** do NOT force Model-C through the builder in this plan. Record in Task 8 that **pilot recall requires separate wiring into `composeSystemPrompt` (`src/sdr/compose.ts:59`), which is OUT OF SCOPE for CTX-03** and must be a follow-up. The plan then honestly delivers "recall reachable when the builder runs", NOT "recall in the SDR pilot".

- [ ] **Step 3: Commit the decision marker**

```bash
git commit --allow-empty -m "chore(ctx-03): pilot-path confirmation — recall <reaches|does NOT reach> the SDR pilot via the builder (plan Task 7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Unit test — MemoryLayer recall branch (render / truncate / skip / fail-open) + record deferrals

**Files:**
- Test: `tests/unit/context/memory-layer.recall.test.ts` (NEW — under `tests/**`)

> This pins the recall branch behavior of `MemoryLayer.build()` (`memory.layer.ts:138-162`) WITHOUT a DB or a real embedder — a stub `SemanticRecall` and a fake `pg` Pool. It is the unit complement to the integration test (Task 9).

- [ ] **Step 1: Write the failing test** — create `tests/unit/context/memory-layer.recall.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

import { MemoryLayer } from "../../../src/context/layers/memory.layer.js";
import type {
  SemanticRecall,
  RecalledMessage,
} from "../../../src/memory/semantic-recall.js";
import type { ContextInput } from "../../../src/context/types.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 99n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {},
  userMessage: "preciso remarcar meu horario",
};

// profile row present, facts empty — so the recall section is the variable part.
function makeDb() {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ full_name: "Maria Souza", total_interactions: 1 }] })
      .mockResolvedValueOnce({ rows: [] }),
  };
}

function recallReturning(hits: RecalledMessage[]): SemanticRecall {
  return { recall: async () => hits };
}

const hit = (content: string): RecalledMessage => ({
  messageId: "m-1",
  role: "user",
  content,
  score: 0.81,
  messageAt: new Date("2026-04-01T10:00:00Z"),
});

describe("MemoryLayer recall branch (CTX-03)", () => {
  it("renders the recall section when recall returns hits", async () => {
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: recallReturning([hit("queria agendar para sexta")]),
    });
    const block = await layer.build(input);
    expect(block.content).toContain("### Memorias semanticamente relevantes");
    expect(block.content).toContain("queria agendar para sexta");
  });

  it("truncates a recalled body longer than recallContentTruncate (default 200)", async () => {
    const long = "x".repeat(250);
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: recallReturning([hit(long)]),
    });
    const block = await layer.build(input);
    expect(block.content).toContain("x".repeat(200) + "...");
    expect(block.content).not.toContain("x".repeat(201));
  });

  it("honors a custom recallContentTruncate", async () => {
    const long = "y".repeat(50);
    const layer = new MemoryLayer(makeDb() as never, {
      semanticRecall: recallReturning([hit(long)]),
      recallContentTruncate: 10,
    });
    const block = await layer.build(input);
    expect(block.content).toContain("y".repeat(10) + "...");
  });

  it("skips recall entirely when userMessage is absent", async () => {
    const fake = recallReturning([hit("should not appear")]);
    const spy = vi.spyOn(fake, "recall");
    const layer = new MemoryLayer(makeDb() as never, { semanticRecall: fake });
    const noMsg: ContextInput = { ...input, userMessage: undefined };
    const block = await layer.build(noMsg);
    expect(spy).not.toHaveBeenCalled();
    expect(block.content).not.toContain("### Memorias semanticamente relevantes");
  });

  it("skips recall when the token budget is too tight (budgetOk=false)", async () => {
    const fake = recallReturning([hit("should not appear")]);
    const spy = vi.spyOn(fake, "recall");
    const layer = new MemoryLayer(makeDb() as never, { semanticRecall: fake });
    // tiny budget → estimateTokens(lines) >= tokenBudget - 200 → skip
    const tight: ContextInput = { ...input, tokenBudget: 10 };
    const block = await layer.build(tight);
    expect(spy).not.toHaveBeenCalled();
    expect(block.content).not.toContain("### Memorias semanticamente relevantes");
  });

  it("fail-open: recall that throws does NOT block the profile/facts block", async () => {
    const throwing: SemanticRecall = {
      recall: async () => {
        throw new Error("embedder down");
      },
    };
    const layer = new MemoryLayer(makeDb() as never, { semanticRecall: throwing });
    const block = await layer.build(input);
    expect(block.content).toContain("Maria Souza"); // profile still rendered
    expect(block.content).not.toContain("### Memorias semanticamente relevantes");
  });
});
```

- [ ] **Step 2: Run the unit gate (scoped) to verify it passes**

Run: `npm run test:unit -- memory-layer.recall`
Expected: PASS — these assert the EXISTING `memory.layer.ts:138-162` branch (no source change needed; the branch already exists on `main`, this test just exercises it for the first time). If any FAIL, it reveals a real bug in the existing branch — debug per superpowers:systematic-debugging, do NOT paper over.

- [ ] **Step 3: Record the deferred concerns as a tracked follow-up note in the test file header**

Append this comment block at the TOP of `tests/unit/context/memory-layer.recall.test.ts` (after the imports), so the deferrals are discoverable next to the code that exercises recall:

```typescript
/*
 * DEFERRED (NOT covered here — see plan §A/§C):
 *  - minScore filtered AFTER `LIMIT topK` (semantic-recall.ts:112-118) can
 *    return < topK items at default topK=5/minScore=0.6. Product decision:
 *    accept-as-is OR move the filter into SQL. Filed, not fixed (touches
 *    recall(), a non-goal). [reviewer concern 2 / §C item 1]
 *  - minScore=0.6 unvalidated against real PT-BR SDR embeddings. Calibrate
 *    against data before flipping ON. [reviewer concern 3 / §A gate 2]
 *  - excludeRecent (messages) vs History window (turns/tokens) are not
 *    commensurable; measure empirically before enabling. [concern 5 / §A gate 3]
 *  - 800ms layer timeout default unvalidated vs embedding provider P99.
 *    [concern 1 / §A gate 1]
 */
```

- [ ] **Step 4: Commit**

```bash
git add tests/unit/context/memory-layer.recall.test.ts
git commit -m "test(context): MemoryLayer recall branch render/truncate/skip/fail-open + record deferrals (CTX-03)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Extend the integration test — end-to-end recall via the MemoryLayer (RUN_INTEGRATION only)

**Files:**
- Modify: `tests/integration/memory/semantic-recall.integration.test.ts`

> **This is the end-to-end test the audit implies.** It seeds real `message_embeddings`, registers the recall via `setSemanticRecall`, builds a `MemoryLayer`, and asserts the recall block appears with recency-exclusion honored and below-`minScore` filtered. It is gated `describe.skipIf(!RUN)` — **NEVER part of the unit gate** (`postgres:16-alpine` in CI lacks pgvector; only the `bevox-postgres` image works, per CLAUDE.md).

- [ ] **Step 1: Add the imports** — at the top of `tests/integration/memory/semantic-recall.integration.test.ts`, add:

```typescript
import { MemoryLayer } from "../../../src/context/layers/memory.layer.js";
import {
  setSemanticRecall,
  resetMemoryRegistryForTests,
} from "../../../src/memory/registry.js";
import type { ContextInput } from "../../../src/context/types.js";
```

- [ ] **Step 2: Append a new `it(...)` inside the existing `describe.skipIf(!RUN)(...)` block** — after the existing recall test (before the closing `});` of the describe), add:

```typescript
  it("MemoryLayer renders a recall block via the registry, honoring recency-exclusion", async () => {
    const embedder = makeStubEmbedder();
    const indexer = new MessageEmbeddingIndexer(pool, embedder);

    // 12 messages alternating topics; the 4 most-recent are "endereco" (odd i).
    const baseDate = new Date("2024-02-01T00:00:00Z");
    const messages = [];
    for (let i = 0; i < 12; i++) {
      const topic = i % 2 === 0 ? "agendamento sexta" : "endereco do consultorio";
      messages.push({
        messageId: `mm${i}`,
        role: "user" as const,
        content: `historico ${i}: ${topic}`,
        messageAt: new Date(baseDate.getTime() + i * 60_000),
      });
    }
    const idx = await indexer.index(1, 7n, messages);
    expect(idx.indexed).toBe(12);

    // Register recall in the process singleton, exactly as bootstrap does.
    const recall = new RagSemanticRecall(pool, embedder, {
      topK: 5,
      minScore: 0.5,
      excludeRecent: 4,
    });
    setSemanticRecall(recall);

    // Build a MemoryLayer wired with the registry recall (the CTX-03 read path).
    const { getSemanticRecall } = await import("../../../src/memory/registry.js");
    const layer = new MemoryLayer(pool, { semanticRecall: getSemanticRecall() });

    const input: ContextInput = {
      executionId: "int-e1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 7n,
      conversationKey: "int-c1",
      agentConfig: { systemPrompt: "" },
      dispatchPayload: {},
      userMessage: "preciso remarcar o horario", // → "agendamento" direction
    };

    const block = await layer.build(input);

    // Recall block present, only "agendamento" hits, recency-excluded recents absent.
    expect(block.content).toContain("### Memorias semanticamente relevantes");
    expect(block.content).toContain("agendamento");
    expect(block.content).not.toContain("endereco do consultorio");

    resetMemoryRegistryForTests();
  }, 120_000);
```

> **Note on tenant id:** the seed uses `indexer.index(1, 7n, ...)` (integer account id `1`, matching the existing test's seeded `accounts` row), while the SQL `organization_id` filter receives a UUID string. This mirrors the EXACT shape of the pre-existing passing test in this file (which seeds `accounts (id=1)` and queries with the UUID `018f3a2b-...`). If the existing test's pattern changed on your branch, match whatever it currently does — do not invent a new tenant scheme.

- [ ] **Step 3: Confirm it is gated and does NOT run in the unit gate**

Run: `npm run test:unit -- semantic-recall.integration`
Expected: the file is either skipped (`describe.skipIf(!RUN)`) or not collected. Either way, ZERO failures and NO Postgres connection attempt. **Do NOT run `RUN_INTEGRATION=1`** as part of this plan's gate.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/memory/semantic-recall.integration.test.ts
git commit -m "test(memory): end-to-end MemoryLayer recall via registry + recency-exclusion (CTX-03, RUN_INTEGRATION)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Final gate — build, typecheck, unit suite, regression checks

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Unit gate (the ONLY test gate — never RUN_INTEGRATION)**

Run: `npm run test:unit`
Expected: PASS — `builder-factory` + `memory-layer.recall` green; no regressions. Integration files are skipped (`RUN_INTEGRATION` unset).

- [ ] **Step 4: Regression — defaults keep the wire inert**

Run:
```bash
grep -n "CONTEXT_BUILDER_ENABLED" src/config/env.ts
grep -n "MEMORY_SEMANTIC_RECALL_ENABLED" src/config/env.ts
```
Expected: both default to `"false"`. Confirm by inspection that with both off: (a) the handler's builder branch is not entered (`CONTEXT_BUILDER_ENABLED=false`), so the status-quo `composeSystemPrompt` + `enforceBudget` path is byte-identical; and (b) even if the builder ran, `getSemanticRecall()` returns `undefined` (registry unset when `MEMORY_SEMANTIC_RECALL_ENABLED=false`) → no recall block, no `message_embeddings` query.

- [ ] **Step 5: Confirm `getSemanticRecall` now has a production consumer (CTX-03 closed)**

Run: `grep -rn "getSemanticRecall" src/`
Expected: at least TWO matches — the definition (`registry.ts:31`) AND the call inside `src/context/builder-factory.ts`. (On `main` before this plan, the grep returned only the definition.)

- [ ] **Step 6: Confirm the recall edge is byte-identical to #61 (merge idempotency)**

Run: `grep -c "deps.memory?.semanticRecall ?? getSemanticRecall()" src/context/builder-factory.ts`
Expected: `1`. No knob-passthrough divergence.

- [ ] **Step 7: Final commit (no-op if clean)**

```bash
git add -A
git commit -m "chore(ctx-03): final gate — recall read path connected, inert by default, #61-idempotent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage (each section → task):**
- §3 goal "single construction site reading `getSemanticRecall()`" → Task 1. ✓
- §3 goal "pass env knobs" — spec §4.4 CORRECTION says the passthrough is a redundant no-op and must NOT be added (env knobs reach `RagSemanticRecall` via bootstrap `defaults`); plan honors this in Task 1's comment + Task 6 Step 3 guard. ✓ (Intentionally NOT a knob-passthrough task — matching the spec's correction.)
- §3 goal "recall OFF by default" → Task 4 (flag default false) + Task 10 Step 4. ✓
- §3 goal "fail-open preserved" → Task 8 fail-open test (existing branch, unchanged). ✓
- §3 goal "converge with #61" → byte-identical edge (Task 1) + same env names/defaults (Task 4) + Task 10 Step 6 guard. ✓
- §3 goal "define the recall contract (§4.1)" → fixed in plan prose (no new retrieval code, per non-goal); contract values asserted via Task 8 (truncate=200, skip, render). ✓
- §3 non-goal "do NOT implement all of CTX-01" — HONESTLY qualified: Path B DOES port the bulk of CTX-01 (Task 2/3/4), labelled as such (spec §4.4 Contras revistos / §8 risk 6). ✓
- §3 non-goal "do NOT alter `recall()`" → respected; the post-LIMIT minScore issue is filed, not fixed (Task 8 Step 3 / §C item 1). ✓
- §3 non-goal "do NOT rewrite `MemoryLayer.build()`" → respected (Task 8 exercises the existing branch). ✓
- §4 Option B (wire in main aligned to #61) → Phase B. ✓
- §5 Phase 0 (port builder rewrite) → Task 2 + Task 3. ✓
- §5 Phase 1 (construction site + getter + env) → Task 1 + Task 4. ✓
- §5 Phase 2 (gating) → Task 5 (+ Task 7 gate for Model-C). ✓
- §5 Phase 3 (tests) → Tasks 6, 8, 9. ✓
- §6 testing (unit builder-factory, unit memory-layer, extend integration) → Tasks 6, 8, 9; CI note (tests under `tests/**`) honored everywhere. ✓
- §7 migration/rollback (no schema; three-gate activation) → captured in Task 10 Step 4 + §A. ✓
- §8 risk 1 (no per-layer timeout) → Task 3 (Promise.race port) + §A gate 1. ✓
- §8 risk 4 (double compression) → Task 4 (INFINITY sentinel) + Task 6 Step 1 test + §C item 2 (#61 flag). ✓
- §8 risk 5 (History/recall de-dup) → §A gate 3 + Task 8 Step 3 note. ✓
- §8 risk 6 (main builder ≠ #61 builder) → Task 0 detection + Phase B port. ✓
- §8.1 (main-first vs wait) → Task 0 decision gate. ✓
- §8.2 (pilot path) → Task 7. ✓
- §8.4 (minScore unvalidated) → §A gate 2 + Task 8 note. ✓
- §8.5 (post-LIMIT minScore) → §C item 1 + Task 8 note. ✓
- §9 DoD → mapped across Phases A/B/C; Task 10 closes the build/test/regression bullets. ✓

**2. Placeholder scan:** No "TBD/TODO/implement later/add error handling". Every code step contains complete code. The investigation/decision tasks (0, 7) and the operational gates (§A) are explicitly NON-CODE and labelled so; they are real deliverables (a routing decision; a pilot-path confirmation), not placeholders. The `grep`-based verify steps include exact commands + expected output + the corrective action.

**3. Type/name consistency:**
- `createContextBuilder(deps: ContextBuilderDeps, options: CreateContextBuilderOptions)` — defined Task 1; called in Task 5 (handler) and Task 6 (test) with `{ db }` + `{ globalMaxTokens, layerTimeoutMs }`. Consistent. ✓
- `ContextBuilderOptions { globalMaxTokens?, layerTimeoutMs? }` — defined Task 3; consumed by `createContextBuilder` (Task 1) and the handler call (Task 5). Consistent. ✓
- `BuiltContext.blocks: ContextBlock[]` — added Task 2; produced by `assemble()` Task 3; consumed by `foldContext` Task 4. Consistent. ✓
- `buildContextInput(args: BuildContextInputArgs): ContextInput` + `foldContext(built, doctrineTail, opts)` — defined Task 4; called in Task 5. Consistent. ✓
- `MemoryLayerOptions.semanticRecall?` / `recallContentTruncate?` — read from `main` (`memory.layer.ts:35-45`); used in Tasks 1, 6, 8. Consistent with source. ✓
- `SemanticRecall.recall(opts)` / `RecalledMessage` — imported from `semantic-recall.ts` (verified `:21-41`); used in Tasks 6, 8, 9. Consistent. ✓
- `setSemanticRecall` / `getSemanticRecall` / `resetMemoryRegistryForTests` — from `registry.ts:28-33,43` (verified); used in Tasks 6, 8, 9, 10. Consistent. ✓
- Env flags `CONTEXT_BUILDER_ENABLED` / `CONTEXT_BUILDER_LAYER_TIMEOUT_MS` — defined Task 4 with the SAME names as #61 (spec §10); read in Task 5 + Task 10. Consistent. ✓

**Issues found & fixed inline during review:**
- Initial draft framed Phase B as "thin wire". Corrected throughout to "port CTX-01 + wire recall" per spec §4.4/§8 risk 6 — Task 0 now forces the Path A vs B decision and labels Path B's true scope/estimate.
- The reviewer's double-compression concern (#4) initially looked covered by `maxContextTokens: undefined`; verified against `context-builder.ts:14/21` that this hits `?? 8000`. Fixed by mandating the `Number.POSITIVE_INFINITY` sentinel at the call site (Task 4/5) + a regression assertion (Task 6 Step 1), and flagged #61's own call sites for the CTX-01 review (§C item 2).
- Confirmed via `grep` that `builder-factory.ts` and `context-wiring.ts` do NOT exist on `main`, and `getSemanticRecall` has zero call sites — so Phase B genuinely creates them (Path A short-circuits if #61 added them).
