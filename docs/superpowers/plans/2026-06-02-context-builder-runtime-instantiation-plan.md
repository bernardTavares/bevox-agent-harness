# ContextBuilder Runtime Instantiation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the dead-code 5-layer `ContextBuilder` into the two live execution paths (ReAct `handleExecution` + Model-C `_dispatchModelCImpl`) via a DI factory, behind a default-off env flag, with fail-open layer execution, single-owner base prompt, head-preserving budget reconciliation, and observability — implementing audit finding CTX-01 / issue #39.

**Architecture:** A new `createContextBuilder(deps, options)` factory instantiates 4 layers (BaseConfig, Rules, Memory, History — CalendarLayer deferred per B2) with a `Pool` and memory deps. `ContextBuilder.build()` is refactored to `Promise.allSettled` + per-layer timeout so a failing layer degrades to an empty block recorded in `layersFailed` instead of aborting. The execution handler builds a `ContextInput` and, when `CONTEXT_BUILDER_ENABLED && contactId != null`, folds the builder's ordered blocks into a head (Base + Rules + doctrine/FSM, non-compressible) and a compressible tail (Memory + History), with `composeSystemPrompt("")` owning only the doctrine tail (base lives solely in `BaseConfigLayer`). Phase 3 inserts `COMPRESSIBLE_MARKER` between head and tail so the existing `enforceBudget` (CTX-02) becomes head-preserving, and adds an equivalent `enforceBudget` gate to Model-C. A try/catch at each call-site falls back to the legacy `composeSystemPrompt(systemPrompt, sdrProfile)` on any error; combined with the default-off flag, the worst case is today's behaviour.

**Branch & coordination:**
- Runs on its own worktree/branch (`ctx-builder`), in parallel with the separate "mutation-stack" track.
- The ONLY file shared with the mutation-stack track is `src/runtime/execution-handler.ts`, but in **different regions**: this plan edits context-wiring in the ReAct path (~`:933`/`:972`/`:1266`/`:1312`) and the Model-C path (`_dispatchModelCImpl`, ~`:239`/`:377`); the other track edits `sendComplete` call-sites, the PERM-03 audit block, and registry imports. Expect a small **textual** merge in `execution-handler.ts`; whoever merges second resolves it. There is no semantic conflict.

**Tech Stack:** Node.js 20, TypeScript 5.9 (ESM/NodeNext — all relative imports use `.js` extensions), `pg` (`Pool`), Zod 4 (env validation), Vitest 4 (`describe/it/expect/vi`), Pino logger, `@opentelemetry/api` spans via `withSpan`/`rootSpan.setAttribute`.

---

## File Structure

**Create:**
- `src/context/builder-factory.ts` — `createContextBuilder(deps, options)` DI factory (4 layers).
- `src/context/builder-factory.test.ts` — unit tests for the factory.
- `src/runtime/context-wiring.ts` — pure helpers: `buildContextInput(...)`, `foldContext(builtContext, doctrineTail, { withMarker })`, `setContextSpanAttributes(span, builtContext)`. Keeps the handler edits small and the logic unit-testable without a full handler harness.
- `src/runtime/context-wiring.test.ts` — unit tests for the wiring helpers.

**Modify:**
- `src/context/types.ts` — `contactId?: bigint`; add `blocks`/`layersFailed` to `BuiltContext`.
- `src/context/context-builder.ts` — `build()` → `Promise.allSettled` + `buildWithTimeout`; emit `blocks`/`layersFailed`; section heading map for empty blocks.
- `src/context/layers/memory.layer.ts` — guard `contactId == null` → empty block.
- `src/config/env.ts` — add `CONTEXT_BUILDER_ENABLED` (default `false`) + `CONTEXT_BUILDER_LAYER_TIMEOUT_MS` (default `800`).
- `src/runtime/execution-handler.ts` — flag-gated wiring in ReAct (replace use of `:933`) + Model-C (before `:239`); reuse `builtContext` at the L3 seam (`:1266`); Phase-3 marker + Model-C `enforceBudget`.
- `src/context/context-builder.test.ts` — enhance for fail-open / `layersFailed` / `blocks`.
- `src/context/context-builder.integration.test.ts` — enhance: real headings + single-base snapshot + fail-open + budget.
- `CLAUDE.md` — correct the bootstrap line claiming the builder is live.

---

## Phase 1 — Factory (DI) + fail-open + flag-gated wiring (ReAct + Model-C)

### Task 1: Make `contactId` optional and extend `BuiltContext` in `types.ts`

**Files:**
- Modify: `src/context/types.ts`
- Test: `src/context/context-builder.test.ts` (compile-time only here; behaviour covered in Task 4)

- [ ] **Step 1: Edit `ContextInput.contactId` to optional**

In `src/context/types.ts`, change line 4 from:

```typescript
  contactId: bigint;
```

to:

```typescript
  /**
   * M7: optional at runtime — the ReAct/Model-C handler resolves it as
   * `bigint | undefined`. When absent, MemoryLayer returns an empty block
   * (its contact_profiles/contact_facts queries require a contact_id).
   */
  contactId?: bigint;
```

- [ ] **Step 2: Add `blocks` and `layersFailed` to `BuiltContext`**

In `src/context/types.ts`, replace the `BuiltContext` interface (lines 33-38) with:

```typescript
export interface BuiltContext {
  systemPrompt: string;
  totalTokens: number;
  layersUsed: string[]; // = blocks.map(b => b.section) (section headings — m1)
  compressed: boolean;
  /** NOVO: ordered blocks (by priority) so callers can split head/tail. */
  blocks: ContextBlock[];
  /** NOVO: names of layers that failed/timed out (fail-open). */
  layersFailed: string[];
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: PASS (existing `assemble()` does not yet set `blocks`/`layersFailed`, so this will FAIL with TS errors on `context-builder.ts:69` — that is expected and fixed in Task 3). If the only errors are "Property 'blocks' is missing" / "Property 'layersFailed' is missing" in `context-builder.ts`, proceed; otherwise fix the unexpected error.

- [ ] **Step 4: Commit**

```bash
git add src/context/types.ts
git commit -m "feat(context): make contactId optional + add blocks/layersFailed to BuiltContext"
```

---

### Task 2: Add env flags `CONTEXT_BUILDER_ENABLED` and `CONTEXT_BUILDER_LAYER_TIMEOUT_MS`

**Files:**
- Modify: `src/config/env.ts`

- [ ] **Step 1: Add the two env fields**

In `src/config/env.ts`, inside the `z.object({ ... })` (immediately before the closing `})` on line 169, after the `SDR_SPEED_TO_CONTACT_FASTPATH` line, add:

```typescript
    // CTX-01 — ContextBuilder runtime instantiation (issue #39).
    // Default OFF on initial merge; flipped true in Phase 4 after regression.
    // Uses the .enum().transform() pattern (NOT z.coerce.boolean(), which
    // treats the literal string "false" as truthy).
    CONTEXT_BUILDER_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** Per-layer timeout (ms) for ContextBuilder fail-open. */
    CONTEXT_BUILDER_LAYER_TIMEOUT_MS: z.coerce.number().int().positive().default(800),
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: PASS (same pre-existing `blocks`/`layersFailed` errors from Task 1 in `context-builder.ts` may remain — ignore those; no NEW errors from env.ts).

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "feat(config): add CONTEXT_BUILDER_ENABLED + CONTEXT_BUILDER_LAYER_TIMEOUT_MS env flags"
```

---

### Task 3: Refactor `ContextBuilder.build()` to fail-open (`Promise.allSettled` + timeout)

**Files:**
- Modify: `src/context/context-builder.ts`
- Test: `src/context/context-builder.test.ts`

- [ ] **Step 1: Write the failing test (fail-open)**

In `src/context/context-builder.test.ts`, add this test inside the `describe("ContextBuilder", ...)` block (after the last existing `it(...)`):

```typescript
  it("fails open: a rejecting layer yields an empty block and is recorded in layersFailed", async () => {
    const ok = makeLayer(10, 100, false);
    const bad: ContextLayer = {
      name: "rules",
      priority: 20,
      compressible: false,
      build: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const builder = new ContextBuilder([ok, bad], { globalMaxTokens: 100000 });
    const result = await builder.build(baseInput);

    expect(result.layersFailed).toContain("rules");
    expect(result.blocks).toHaveLength(2);
    // the failed layer contributed a block with empty content + 0 tokens
    const failedBlock = result.blocks.find((b) => b.section.includes("encaminhamento"));
    expect(failedBlock?.content).toBe("");
    expect(failedBlock?.tokenEstimate).toBe(0);
    // the healthy layer is still present
    expect(result.layersUsed).toContain("## Layer 10");
  });

  it("fails open on layer timeout", async () => {
    const ok = makeLayer(10, 100, false);
    const slow: ContextLayer = {
      name: "history",
      priority: 50,
      compressible: true,
      build: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    };
    const builder = new ContextBuilder([ok, slow], {
      globalMaxTokens: 100000,
      layerTimeoutMs: 20,
    });
    const result = await builder.build(baseInput);
    expect(result.layersFailed).toContain("history");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context/context-builder.test.ts -t "fails open"`
Expected: FAIL — `result.layersFailed` is `undefined` (property does not exist yet) and `layerTimeoutMs` option is unknown.

- [ ] **Step 3: Rewrite `context-builder.ts` with fail-open + timeout + heading map**

Replace the entire contents of `src/context/context-builder.ts` with:

```typescript
import { estimateTokens } from "./tokenizer.js";
import type { ContextInput, ContextBlock, ContextLayer, BuiltContext } from "./types.js";

interface ContextBuilderOptions {
  globalMaxTokens?: number; // default 8000 (overridden by agentConfig.maxContextTokens)
  /** Per-layer timeout (ms) for fail-open. Default 800. */
  layerTimeoutMs?: number;
}

/**
 * Heading used when a layer fails/times out: we still need a `section`
 * for the empty fallback block, but `ContextLayer` (types.ts) does not
 * carry one. Map the well-known layer `name` to its real heading so the
 * empty block is byte-compatible with the layer's own output (m2).
 */
const LAYER_HEADINGS: Record<string, string> = {
  "base-config": "## Configuracao base",
  rules: "## Regras de encaminhamento",
  calendar: "## Agenda",
  memory: "## Informacoes do contato",
  history: "## Historico da conversa",
};

function headingFor(layer: ContextLayer): string {
  return LAYER_HEADINGS[layer.name] ?? `## ${layer.name}`;
}

function emptyBlock(layer: ContextLayer): ContextBlock {
  return {
    section: headingFor(layer),
    content: "",
    tokenEstimate: 0,
    priority: layer.priority,
    compressible: layer.compressible,
  };
}

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`layer timeout after ${ms}ms`)), ms);
  });
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
    // Fail-open: a single rejecting/timing-out layer must NOT abort the build.
    const settled = await Promise.allSettled(
      this.layers.map((layer) => this.buildWithTimeout(layer, input)),
    );

    const blocks: ContextBlock[] = [];
    const layersFailed: string[] = [];
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") {
        blocks.push(res.value);
      } else {
        layersFailed.push(this.layers[i].name);
        blocks.push(emptyBlock(this.layers[i]));
      }
    });

    const limit = input.agentConfig.maxContextTokens ?? this.globalMaxTokens;
    const totalTokens = blocks.reduce((sum, b) => sum + b.tokenEstimate, 0);

    if (totalTokens <= limit) {
      return this.assemble(blocks, false, layersFailed);
    }

    const compressed = this.compress(blocks, limit);
    return this.assemble(compressed, true, layersFailed);
  }

  private async buildWithTimeout(
    layer: ContextLayer,
    input: ContextInput,
  ): Promise<ContextBlock> {
    return Promise.race([layer.build(input), timeout(this.layerTimeoutMs)]);
  }

  private compress(blocks: ContextBlock[], limit: number): ContextBlock[] {
    // Work on a copy; compress from lowest priority (highest number) first
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

  private assemble(
    blocks: ContextBlock[],
    compressed: boolean,
    layersFailed: string[],
  ): BuiltContext {
    const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
    const systemPrompt = sorted.map((b) => `${b.section}\n${b.content}`).join("\n\n");
    return {
      systemPrompt,
      totalTokens: sorted.reduce((sum, b) => sum + b.tokenEstimate, 0),
      layersUsed: sorted.map((b) => b.section),
      compressed,
      blocks: sorted,
      layersFailed,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/context/context-builder.test.ts`
Expected: PASS — all existing tests plus the two new fail-open tests pass. (The pre-existing tests still assert `layersUsed`/`compressed`/`totalTokens`, which are unchanged.)

- [ ] **Step 5: Verify the build is clean**

Run: `npm run build`
Expected: PASS — the Task 1 `blocks`/`layersFailed` TS errors are now resolved because `assemble()` populates both.

- [ ] **Step 6: Commit**

```bash
git add src/context/context-builder.ts src/context/context-builder.test.ts
git commit -m "feat(context): fail-open build() via allSettled + per-layer timeout"
```

---

### Task 4: Guard `MemoryLayer` for absent `contactId`

**Files:**
- Modify: `src/context/layers/memory.layer.ts`
- Test: `src/context/context-builder.integration.test.ts` (new co-located test added below)

- [ ] **Step 1: Write the failing test**

In `src/context/context-builder.integration.test.ts`, add a new top-level `describe` block at the end of the file:

```typescript
import { MemoryLayer as MemoryLayerForGuard } from "./layers/memory.layer.js";

describe("MemoryLayer contactId guard (M7)", () => {
  it("returns an empty block when contactId is undefined (no db query)", async () => {
    const query = vi.fn();
    const layer = new MemoryLayerForGuard({ query } as never);
    const block = await layer.build({
      executionId: "e1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: undefined,
      conversationKey: "c1",
      agentConfig: { systemPrompt: "" },
      dispatchPayload: {},
    });
    expect(block.section).toBe("## Informacoes do contato");
    expect(block.content).toBe("");
    expect(block.tokenEstimate).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context/context-builder.integration.test.ts -t "contactId guard"`
Expected: FAIL — `query` IS called (the guard does not exist), and/or the query throws on `undefined` contactId.

- [ ] **Step 3: Add the guard at the top of `MemoryLayer.build()`**

In `src/context/layers/memory.layer.ts`, locate the start of `async build(input: ContextInput): Promise<ContextBlock> {` (line 61) and insert immediately after that opening line (before the `const [profileResult, factsResult]` query):

```typescript
    // M7: contactId is optional at runtime. The contact_profiles/contact_facts
    // queries below require a contact_id; without one, skip all I/O and return
    // an empty block (fail-open, no regression).
    if (input.contactId == null) {
      return {
        section: "## Informacoes do contato",
        content: "",
        tokenEstimate: 0,
        priority: this.priority,
        compressible: this.compressible,
      };
    }

```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/context/context-builder.integration.test.ts -t "contactId guard"`
Expected: PASS — `query` is not called and the empty block is returned.

- [ ] **Step 5: Commit**

```bash
git add src/context/layers/memory.layer.ts src/context/context-builder.integration.test.ts
git commit -m "feat(context): MemoryLayer skips when contactId absent (M7 guard)"
```

---

### Task 5: Create the `createContextBuilder` DI factory

**Files:**
- Create: `src/context/builder-factory.ts`
- Test: `src/context/builder-factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/context/builder-factory.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createContextBuilder } from "./builder-factory.js";
import { ContextBuilder } from "./context-builder.js";
import { resetMemoryRegistryForTests, setSemanticRecall } from "../memory/registry.js";

describe("createContextBuilder", () => {
  beforeEach(() => resetMemoryRegistryForTests());
  afterEach(() => resetMemoryRegistryForTests());

  it("returns a ContextBuilder instance", () => {
    const db = { query: vi.fn() } as never;
    const builder = createContextBuilder({ db });
    expect(builder).toBeInstanceOf(ContextBuilder);
  });

  it("instantiates exactly 4 layers (Calendar deferred — B2)", () => {
    const db = { query: vi.fn() } as never;
    const builder = createContextBuilder({ db });
    // access private layers for the test
    const layers = (builder as unknown as { layers: { name: string }[] }).layers;
    const names = layers.map((l) => l.name).sort();
    expect(names).toEqual(["base-config", "history", "memory", "rules"]);
  });

  it("passes layerTimeoutMs and globalMaxTokens options through", () => {
    const db = { query: vi.fn() } as never;
    const builder = createContextBuilder({ db }, { globalMaxTokens: 12345, layerTimeoutMs: 50 });
    expect((builder as unknown as { globalMaxTokens: number }).globalMaxTokens).toBe(12345);
    expect((builder as unknown as { layerTimeoutMs: number }).layerTimeoutMs).toBe(50);
  });

  it("uses the registry semanticRecall by default and caller override otherwise", () => {
    const db = { query: vi.fn() } as never;
    const registryRecall = { recall: vi.fn() } as never;
    setSemanticRecall(registryRecall);
    const builder = createContextBuilder({ db });
    const memoryLayer = (builder as unknown as { layers: { name: string; opts?: unknown }[] }).layers.find(
      (l) => l.name === "memory",
    ) as unknown as { opts: { semanticRecall: unknown; factsRepo: unknown } };
    expect(memoryLayer.opts.semanticRecall).toBe(registryRecall);
    expect(memoryLayer.opts.factsRepo).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context/builder-factory.test.ts`
Expected: FAIL — `Cannot find module './builder-factory.js'`.

- [ ] **Step 3: Create `src/context/builder-factory.ts`**

```typescript
import type { Pool } from "pg";

import { ContactFactsRepository } from "../memory/contact-facts.repository.js";
import { getSemanticRecall } from "../memory/registry.js";
import { ContextBuilder } from "./context-builder.js";
import { BaseConfigLayer, RulesLayer, MemoryLayer, HistoryLayer } from "./layers/index.js";
import type { MemoryLayerOptions } from "./layers/memory.layer.js";

export interface BuilderDeps {
  db: Pool;
  /**
   * Optional overrides for MemoryLayer. When omitted, factsRepo is built from
   * `db` and semanticRecall is read from the process-singleton registry
   * (getSemanticRecall) — both nullable, both fail-open inside the layer.
   */
  memory?: Partial<MemoryLayerOptions>;
}

export interface BuilderFactoryOptions {
  globalMaxTokens?: number;
  layerTimeoutMs?: number;
}

/**
 * DI factory for the runtime ContextBuilder (CTX-01 / issue #39).
 *
 * Phase 1 wires 4 layers: BaseConfig (zero-arg), Rules (Pool), Memory
 * (Pool + opts), History (Pool). CalendarLayer is deferred (B2) until a
 * `CalendarContextAdapter` over `src/integration/calendar-client.ts` exists.
 *
 * `layers/index.ts` exports CLASSES, not instances — so each is constructed
 * here with its required dependency.
 */
export function createContextBuilder(
  deps: BuilderDeps,
  options: BuilderFactoryOptions = {},
): ContextBuilder {
  const memoryOpts: MemoryLayerOptions = {
    // spread FIRST so the defaults below only fill what the caller omitted
    // (avoids clobbering caller-supplied values with undefined).
    ...deps.memory,
    factsRepo: deps.memory?.factsRepo ?? new ContactFactsRepository(deps.db),
    semanticRecall: deps.memory?.semanticRecall ?? getSemanticRecall(),
  };

  const layers = [
    new BaseConfigLayer(),
    new RulesLayer(deps.db),
    new MemoryLayer(deps.db, memoryOpts),
    new HistoryLayer(deps.db),
    // new CalendarLayer(calendarClient) — deferred (B2): needs CalendarContextAdapter
  ];

  return new ContextBuilder(layers, {
    globalMaxTokens: options.globalMaxTokens,
    layerTimeoutMs: options.layerTimeoutMs,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/context/builder-factory.test.ts`
Expected: PASS — all 4 tests pass. (The test reaches into the private `layers`/`opts` via a cast; `MemoryLayer` stores its options as `this.opts`.)

- [ ] **Step 5: Commit**

```bash
git add src/context/builder-factory.ts src/context/builder-factory.test.ts
git commit -m "feat(context): createContextBuilder DI factory (4 layers, Calendar deferred)"
```

---

### Task 6: Create the `context-wiring` helpers (`buildContextInput`, `foldContext`, `setContextSpanAttributes`)

**Files:**
- Create: `src/runtime/context-wiring.ts`
- Test: `src/runtime/context-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/runtime/context-wiring.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

import { COMPRESSIBLE_MARKER } from "../context/budget-enforcer.js";
import type { BuiltContext, ContextBlock } from "../context/types.js";
import { buildContextInput, foldContext, setContextSpanAttributes } from "./context-wiring.js";

const block = (section: string, content: string, priority: number, compressible: boolean): ContextBlock => ({
  section,
  content,
  tokenEstimate: 10,
  priority,
  compressible,
});

const built: BuiltContext = {
  systemPrompt: "ignored",
  totalTokens: 40,
  layersUsed: [],
  compressed: false,
  layersFailed: ["memory"],
  blocks: [
    block("## Configuracao base", "BASE", 10, false),
    block("## Regras de encaminhamento", "RULES", 20, false),
    block("## Informacoes do contato", "MEM", 40, true),
    block("## Historico da conversa", "HIST", 50, true),
  ],
};

describe("buildContextInput", () => {
  it("maps runtime values, leaves maxContextTokens undefined, passes contactId through", () => {
    const input = buildContextInput({
      executionId: "e1",
      organizationId: "org-1",
      contactId: 42n,
      conversationKey: "conv-1",
      systemPrompt: "RAW BASE",
      dispatchPayload: { foo: 1 },
      userMessage: "hi",
      tokenBudget: 4000,
    });
    expect(input.executionId).toBe("e1");
    expect(input.organizationId).toBe("org-1");
    expect(input.contactId).toBe(42n);
    expect(input.conversationKey).toBe("conv-1");
    expect(input.agentConfig.systemPrompt).toBe("RAW BASE");
    expect(input.agentConfig.maxContextTokens).toBeUndefined();
    expect(input.userMessage).toBe("hi");
    expect(input.tokenBudget).toBe(4000);
    expect(input.dispatchPayload).toEqual({ foo: 1 });
  });
});

describe("foldContext", () => {
  it("orders head (non-compressible blocks + doctrine) then tail (compressible blocks); no marker by default", () => {
    const folded = foldContext(built, "DOCTRINE");
    const baseIdx = folded.indexOf("BASE");
    const rulesIdx = folded.indexOf("RULES");
    const doctrineIdx = folded.indexOf("DOCTRINE");
    const memIdx = folded.indexOf("MEM");
    const histIdx = folded.indexOf("HIST");
    expect(baseIdx).toBeLessThan(rulesIdx);
    expect(rulesIdx).toBeLessThan(doctrineIdx);
    expect(doctrineIdx).toBeLessThan(memIdx);
    expect(memIdx).toBeLessThan(histIdx);
    expect(folded).not.toContain(COMPRESSIBLE_MARKER);
  });

  it("omits an empty doctrine tail without leaving an orphan separator", () => {
    const folded = foldContext(built, "");
    expect(folded).toContain("RULES");
    expect(folded).toContain("MEM");
    expect(folded.endsWith("\n")).toBe(false);
    expect(folded).not.toContain("\n\n\n");
  });

  it("inserts COMPRESSIBLE_MARKER between head and tail when withMarker=true", () => {
    const folded = foldContext(built, "DOCTRINE", { withMarker: true });
    const markerIdx = folded.indexOf(COMPRESSIBLE_MARKER);
    expect(markerIdx).toBeGreaterThan(folded.indexOf("DOCTRINE"));
    expect(markerIdx).toBeLessThan(folded.indexOf("MEM"));
  });

  it("renders the base block exactly once (B5)", () => {
    const folded = foldContext(built, "DOCTRINE");
    const matches = folded.match(/## Configuracao base/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe("setContextSpanAttributes", () => {
  it("sets layers used/failed/count span attributes", () => {
    const setAttribute = vi.fn();
    setContextSpanAttributes({ setAttribute } as never, built);
    expect(setAttribute).toHaveBeenCalledWith(
      "context.layers.used",
      "## Configuracao base,## Regras de encaminhamento,## Informacoes do contato,## Historico da conversa",
    );
    expect(setAttribute).toHaveBeenCalledWith("context.layers.failed", "memory");
    expect(setAttribute).toHaveBeenCalledWith("context.layers.count", 4);
    expect(setAttribute).toHaveBeenCalledWith("context.total_tokens", 40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runtime/context-wiring.test.ts`
Expected: FAIL — `Cannot find module './context-wiring.js'`.

- [ ] **Step 3: Create `src/runtime/context-wiring.ts`**

```typescript
import type { Span } from "@opentelemetry/api";

import { COMPRESSIBLE_MARKER } from "../context/budget-enforcer.js";
import type { BuiltContext, ContextBlock, ContextInput } from "../context/types.js";

export interface BuildContextInputArgs {
  executionId: string;
  organizationId: string;
  contactId?: bigint;
  conversationKey: string;
  /** Raw base system prompt (pre-doctrine). Owned by BaseConfigLayer. */
  systemPrompt: string;
  dispatchPayload: Record<string, unknown>;
  userMessage?: string;
  tokenBudget?: number;
}

/**
 * Build the ContextInput for the runtime ContextBuilder.
 *
 * IMPORTANT (Phase 1-2): `agentConfig.maxContextTokens` is left UNDEFINED so
 * the builder does NOT compress internally — the live `enforceBudget`
 * (CTX-02) stays the single budget gate. `tokenBudget` only controls the
 * MemoryLayer semantic-recall skip (memory.layer.ts).
 */
export function buildContextInput(args: BuildContextInputArgs): ContextInput {
  return {
    executionId: args.executionId,
    organizationId: args.organizationId,
    contactId: args.contactId,
    conversationKey: args.conversationKey,
    agentConfig: {
      systemPrompt: args.systemPrompt,
      maxContextTokens: undefined,
    },
    dispatchPayload: args.dispatchPayload,
    userMessage: args.userMessage,
    tokenBudget: args.tokenBudget,
  };
}

export interface FoldOptions {
  /** Phase 3: insert COMPRESSIBLE_MARKER between head and tail. */
  withMarker?: boolean;
}

function renderBlock(b: ContextBlock): string {
  return `${b.section}\n${b.content}`;
}

/**
 * Fold the builder's ordered blocks + doctrine tail into the final prompt.
 *
 * HEAD (non-compressible): BaseConfig + Rules blocks, then the doctrine/L3/FSM
 *   tail produced by composeSystemPrompt("", ...). BaseConfigLayer is the sole
 *   owner of the base (B5) — composeSystemPrompt is called with base="".
 * [MARKER] when withMarker=true (Phase 3) — splits head from tail for the
 *   head-preserving enforceBudget.
 * TAIL (compressible): Memory + History blocks (+ Calendar when enabled).
 */
export function foldContext(
  built: BuiltContext,
  doctrineTail: string,
  options: FoldOptions = {},
): string {
  const head = built.blocks.filter((b) => !b.compressible).map(renderBlock);
  const tail = built.blocks.filter((b) => b.compressible).map(renderBlock);

  const headParts = [...head];
  if (doctrineTail !== "") headParts.push(doctrineTail);
  const headStr = headParts.join("\n\n");

  const tailStr = tail.join("\n\n");

  if (tailStr === "") return headStr;

  if (options.withMarker) {
    // COMPRESSIBLE_MARKER already carries its own leading "\n\n" and trailing "\n".
    return `${headStr}${COMPRESSIBLE_MARKER}${tailStr}`;
  }
  return `${headStr}\n\n${tailStr}`;
}

/**
 * Set the `context.*` span attributes for the builder run, extending the
 * existing CTX-02 attrs (context.compressed / context.*_tokens set elsewhere).
 */
export function setContextSpanAttributes(span: Span, built: BuiltContext): void {
  span.setAttribute("context.layers.used", built.layersUsed.join(","));
  span.setAttribute("context.layers.failed", built.layersFailed.join(","));
  span.setAttribute("context.layers.count", built.blocks.length);
  span.setAttribute("context.total_tokens", built.totalTokens);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/runtime/context-wiring.test.ts`
Expected: PASS — all wiring-helper tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/context-wiring.ts src/runtime/context-wiring.test.ts
git commit -m "feat(runtime): context-wiring helpers (buildContextInput, foldContext, span attrs)"
```

---

### Task 7: Wire the ContextBuilder into the ReAct path (`handleExecution`), flag-gated

**Files:**
- Modify: `src/runtime/execution-handler.ts`

- [ ] **Step 1: Add imports**

In `src/runtime/execution-handler.ts`, after the existing `import { enforceBudget } from "../context/budget-enforcer.js";` (line 60), add:

```typescript
import { createContextBuilder } from "../context/builder-factory.js";
import {
  buildContextInput,
  foldContext,
  setContextSpanAttributes,
} from "./context-wiring.js";
import type { BuiltContext } from "../context/types.js";
```

- [ ] **Step 2: Replace the ReAct compose with flag-gated builder wiring**

The current code at `src/runtime/execution-handler.ts:933` is:

```typescript
      const composedSystemPrompt = composeSystemPrompt(systemPrompt, sdrProfile);
```

This value is consumed below at line 990 (`systemPrompt: composedSystemPrompt,` inside `agentContext`). The builder needs `contactIdCtx` (resolved at `:963`) and `ctx.db`, so the builder run must happen AFTER `contactIdCtx` exists but the result must be available when `agentContext` is constructed at `:972`.

Replace the single line at `:933`:

```typescript
      const composedSystemPrompt = composeSystemPrompt(systemPrompt, sdrProfile);
```

with:

```typescript
      // CTX-01 (issue #39): legacy compose kept as the default + fallback.
      // The flag-gated ContextBuilder wiring below (after contactIdCtx is
      // resolved) overrides `composedSystemPrompt` when enabled.
      let composedSystemPrompt = composeSystemPrompt(systemPrompt, sdrProfile);
      let builtContext: BuiltContext | undefined;
```

- [ ] **Step 3: Insert the builder run after `contactIdCtx` is resolved**

Locate the `catch { contactIdCtx = undefined; }` block ending at line 970, immediately before the `const agentContext: AgentExecutionContext = {` at `:972`. Insert this block between them (after `:970`, before `:972`):

```typescript
      // CTX-01 — flag-gated ContextBuilder run (ReAct path). Build ONCE here;
      // reused at the B.8 L3 seam below (no rebuild). Fails open to the legacy
      // prompt on any error; default-off via CONTEXT_BUILDER_ENABLED.
      if (env_.CONTEXT_BUILDER_ENABLED && contactIdCtx != null) {
        try {
          const lastUserMsg = payload.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content)
            .at(-1);
          const contextInput = buildContextInput({
            executionId: execution_id,
            organizationId,
            contactId: contactIdCtx,
            conversationKey,
            systemPrompt,
            dispatchPayload: payload as unknown as Record<string, unknown>,
            userMessage: lastUserMsg,
          });
          const builder = createContextBuilder(
            { db: ctx.db },
            { layerTimeoutMs: env_.CONTEXT_BUILDER_LAYER_TIMEOUT_MS },
          );
          builtContext = await builder.build(contextInput);
          const doctrineTail = composeSystemPrompt("", sdrProfile);
          composedSystemPrompt = foldContext(builtContext, doctrineTail);
          setContextSpanAttributes(rootSpan, builtContext);
        } catch (err) {
          logger.warn(
            { err, execution_id },
            "CTX-01: context builder failed; falling back to legacy prompt",
          );
          builtContext = undefined;
          composedSystemPrompt = composeSystemPrompt(systemPrompt, sdrProfile);
        }
      }
```

(Note: `env_` is already in scope from `:937`; `organizationId` from `:843`; `conversationKey` from `:923`; `systemPrompt` from `:928`; `rootSpan` is the active span argument of the `withSpan` callback at `:850`.)

- [ ] **Step 4: Reuse `builtContext` at the B.8 L3 seam**

The current L3 seam at `:1263-1273` recomposes the prompt via `composeSystemPrompt(systemPrompt, sdrProfile, snapshot, analyzerOutput.sdrSubMode)`. When the builder ran, reuse `builtContext` (build-once) and only re-fold with the L3-aware doctrine tail. Replace the block at `:1263-1273`:

```typescript
        if (sdrProfile?.enabled && agentContext.contactId != null) {
          const snapshot = await getSdrAccountState(ctx.db, organizationId, agentContext.contactId);
          if (snapshot) {
            agentContext.systemPrompt = composeSystemPrompt(
              systemPrompt,
              sdrProfile,
              snapshot,
              analyzerOutput.sdrSubMode,
            );
          }
        }
```

with:

```typescript
        if (sdrProfile?.enabled && agentContext.contactId != null) {
          const snapshot = await getSdrAccountState(ctx.db, organizationId, agentContext.contactId);
          if (snapshot) {
            if (builtContext) {
              // CTX-01: reuse the already-built context (build-once); only the
              // doctrine/L3 tail changes (base="" — BaseConfigLayer owns base).
              const doctrineTail = composeSystemPrompt(
                "",
                sdrProfile,
                snapshot,
                analyzerOutput.sdrSubMode,
              );
              agentContext.systemPrompt = foldContext(builtContext, doctrineTail);
            } else {
              agentContext.systemPrompt = composeSystemPrompt(
                systemPrompt,
                sdrProfile,
                snapshot,
                analyzerOutput.sdrSubMode,
              );
            }
          }
        }
```

- [ ] **Step 5: Verify the build compiles**

Run: `npm run build`
Expected: PASS — no TS errors. `composedSystemPrompt` is now `let`, `builtContext` is declared, and `foldContext`/`buildContextInput`/`createContextBuilder` are imported.

- [ ] **Step 6: Run the existing test suite (no regression with flag off)**

Run: `npx vitest run`
Expected: PASS — flag defaults to `false`, so all existing behaviour is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): wire ContextBuilder into ReAct path behind CONTEXT_BUILDER_ENABLED"
```

---

### Task 8: Wire the ContextBuilder into the Model-C path (`_dispatchModelCImpl`), flag-gated

**Files:**
- Modify: `src/runtime/execution-handler.ts`

- [ ] **Step 1: Add a `getEnv()` read inside `_dispatchModelCImpl`**

`_dispatchModelCImpl` does not currently read `getEnv()`. In `src/runtime/execution-handler.ts`, locate the line `const executionId = agentContext.executionId;` (line 202) inside `_dispatchModelCImpl` and add immediately after it:

```typescript
  const envMc = getEnv();
```

(`getEnv` is already imported at `:12`.)

- [ ] **Step 2: Replace the Model-C compose with flag-gated builder wiring**

The current code at `src/runtime/execution-handler.ts:239-245` is:

```typescript
  agentContext.systemPrompt = composeSystemPrompt(
    rawSystemPrompt,
    sdrProfile,
    null,
    undefined,
    fsmProjection,
  );
```

Replace it with:

```typescript
  // CTX-01 (issue #39): flag-gated ContextBuilder wiring for Model-C. Build
  // ONCE; fails open to the legacy compose on any error. The doctrine tail
  // carries the FSM projection (base="" — BaseConfigLayer owns base).
  if (envMc.CONTEXT_BUILDER_ENABLED && agentContext.contactId != null) {
    try {
      const contextInput = buildContextInput({
        executionId,
        organizationId,
        contactId: agentContext.contactId,
        conversationKey: agentContext.conversationKey,
        systemPrompt: rawSystemPrompt,
        dispatchPayload: { messages } as unknown as Record<string, unknown>,
        userMessage: inboundMessage,
      });
      const builder = createContextBuilder(
        { db: agentContext.db },
        { layerTimeoutMs: envMc.CONTEXT_BUILDER_LAYER_TIMEOUT_MS },
      );
      const builtContextMc = await builder.build(contextInput);
      const doctrineTail = composeSystemPrompt("", sdrProfile, null, undefined, fsmProjection);
      agentContext.systemPrompt = foldContext(builtContextMc, doctrineTail);
    } catch (err) {
      logger.warn(
        { err, executionId },
        "CTX-01 (Model-C): context builder failed; falling back to legacy prompt",
      );
      agentContext.systemPrompt = composeSystemPrompt(
        rawSystemPrompt,
        sdrProfile,
        null,
        undefined,
        fsmProjection,
      );
    }
  } else {
    agentContext.systemPrompt = composeSystemPrompt(
      rawSystemPrompt,
      sdrProfile,
      null,
      undefined,
      fsmProjection,
    );
  }
```

(Note: `inboundMessage` is computed at `:211`, before this point; `organizationId` is destructured from `args` at `:193`; `agentContext.contactId`/`agentContext.db`/`agentContext.conversationKey` are all in scope.)

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build`
Expected: PASS — no TS errors.

- [ ] **Step 4: Run the existing test suite (no regression with flag off)**

Run: `npx vitest run`
Expected: PASS — flag defaults to `false`.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): wire ContextBuilder into Model-C path behind CONTEXT_BUILDER_ENABLED"
```

---

## Phase 2 — Observability + double-injection guard + docs

### Task 9: Integration test — 4 layers in the prompt with real headings, base exactly once

**Files:**
- Modify: `src/context/context-builder.integration.test.ts`

- [ ] **Step 1: Write the failing test (via the factory, 4 layers, single base)**

In `src/context/context-builder.integration.test.ts`, add a new top-level `describe` block at the end of the file:

```typescript
import { createContextBuilder } from "./builder-factory.js";
import { foldContext } from "../runtime/context-wiring.js";
import { resetMemoryRegistryForTests } from "../memory/registry.js";

describe("ContextBuilder runtime (4 layers via factory)", () => {
  beforeEach(() => resetMemoryRegistryForTests());
  afterEach(() => resetMemoryRegistryForTests());

  it("assembles base+rules+memory+history (Calendar deferred) with real headings", async () => {
    const mockDb = {
      query: vi
        .fn()
        // RulesLayer
        .mockResolvedValueOnce({ rows: [{ id: 1, description: "Encaminhar se solicitado." }] })
        // MemoryLayer — profile
        .mockResolvedValueOnce({
          rows: [
            {
              full_name: "Maria Silva",
              preferred_name: null,
              phone: null,
              email: null,
              address: null,
              city: null,
              state: null,
              preferred_language: null,
              last_interaction_at: null,
              total_interactions: 1,
            },
          ],
        })
        // MemoryLayer — facts
        .mockResolvedValueOnce({ rows: [] })
        // HistoryLayer
        .mockResolvedValueOnce({ rows: [{ role: "Cliente", content: "Ola!", created_at: new Date() }] }),
    };

    const builder = createContextBuilder({ db: mockDb as never }, { layerTimeoutMs: 5000 });
    const built = await builder.build({
      executionId: "exec-rt",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 42n,
      conversationKey: "conv-rt",
      agentConfig: { systemPrompt: "Voce e um assistente." },
      dispatchPayload: {},
    });

    expect(built.layersUsed).toEqual([
      "## Configuracao base",
      "## Regras de encaminhamento",
      "## Informacoes do contato",
      "## Historico da conversa",
    ]);
    expect(built.layersFailed).toEqual([]);

    const folded = foldContext(built, "DOCTRINE_TAIL");
    // base appears exactly once (B5)
    expect((folded.match(/## Configuracao base/g) ?? [])).toHaveLength(1);
    // user base content present once
    expect((folded.match(/Voce e um assistente\./g) ?? [])).toHaveLength(1);
    // order: head (base, rules) before doctrine before tail (memory, history)
    expect(folded.indexOf("## Configuracao base")).toBeLessThan(
      folded.indexOf("## Regras de encaminhamento"),
    );
    expect(folded.indexOf("## Regras de encaminhamento")).toBeLessThan(folded.indexOf("DOCTRINE_TAIL"));
    expect(folded.indexOf("DOCTRINE_TAIL")).toBeLessThan(folded.indexOf("## Informacoes do contato"));
    expect(folded.indexOf("## Informacoes do contato")).toBeLessThan(
      folded.indexOf("## Historico da conversa"),
    );
  });
});
```

Also add the missing imports `beforeEach, afterEach` to the existing top `import { describe, it, expect, vi } from "vitest";` line so it reads:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/context/context-builder.integration.test.ts -t "4 layers via factory"`
Expected: PASS — the factory builds 4 layers, `foldContext` orders head/doctrine/tail, base appears once.

- [ ] **Step 3: Commit**

```bash
git add src/context/context-builder.integration.test.ts
git commit -m "test(context): integration — 4 layers via factory, base once, ordered fold"
```

---

### Task 10: Integration test — fail-open propagates `layersFailed`

**Files:**
- Modify: `src/context/context-builder.integration.test.ts`

- [ ] **Step 1: Write the test (MemoryLayer throws → build completes)**

In `src/context/context-builder.integration.test.ts`, inside the `describe("ContextBuilder runtime (4 layers via factory)", ...)` block, add:

```typescript
  it("fails open: MemoryLayer DB error completes the build and records memory in layersFailed", async () => {
    const mockDb = {
      query: vi
        .fn()
        // RulesLayer — ok
        .mockResolvedValueOnce({ rows: [{ id: 1, description: "R" }] })
        // MemoryLayer — profile query rejects
        .mockRejectedValueOnce(new Error("relation contact_profiles does not exist"))
        // MemoryLayer — facts query (Promise.all sibling) — also rejects
        .mockRejectedValueOnce(new Error("relation contact_facts does not exist"))
        // HistoryLayer — ok
        .mockResolvedValueOnce({ rows: [{ role: "Cliente", content: "Oi", created_at: new Date() }] }),
    };

    const builder = createContextBuilder({ db: mockDb as never }, { layerTimeoutMs: 5000 });
    const built = await builder.build({
      executionId: "exec-fo",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 7n,
      conversationKey: "conv-fo",
      agentConfig: { systemPrompt: "Base" },
      dispatchPayload: {},
    });

    expect(built.layersFailed).toContain("memory");
    // other layers still present
    expect(built.layersUsed).toContain("## Regras de encaminhamento");
    expect(built.layersUsed).toContain("## Historico da conversa");
    // memory block is present but empty
    const memBlock = built.blocks.find((b) => b.section === "## Informacoes do contato");
    expect(memBlock?.content).toBe("");
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/context/context-builder.integration.test.ts -t "fails open"`
Expected: PASS — `Promise.allSettled` catches the MemoryLayer rejection; `layersFailed` includes `memory`.

- [ ] **Step 3: Commit**

```bash
git add src/context/context-builder.integration.test.ts
git commit -m "test(context): integration — fail-open records layersFailed without aborting"
```

---

### Task 11: Resolve the layer-error taxonomy (expected vs unexpected) for alarms

**Files:**
- Modify: `src/context/context-builder.ts`
- Test: `src/context/context-builder.test.ts`

Per §8 scope-question 2: distinguish expected layer failures (timeout / DB `relation does not exist`) from unexpected bugs (e.g. `TypeError`), so observability/alarms only fire on the unexpected. Encode this as a per-layer outcome on the block; the wiring layer logs unexpected ones.

- [ ] **Step 1: Write the failing test**

In `src/context/context-builder.test.ts`, add inside the `describe("ContextBuilder", ...)` block:

```typescript
  it("classifies layer failures: timeouts/DB errors are 'expected', others 'unexpected'", async () => {
    const dbErr: ContextLayer = {
      name: "rules",
      priority: 20,
      compressible: false,
      build: vi.fn().mockRejectedValue(new Error("relation rules does not exist")),
    };
    const bug: ContextLayer = {
      name: "history",
      priority: 50,
      compressible: true,
      build: vi.fn().mockRejectedValue(new TypeError("cannot read properties of undefined")),
    };
    const builder = new ContextBuilder([dbErr, bug], { globalMaxTokens: 100000 });
    const result = await builder.build(baseInput);

    expect(result.layersFailed).toEqual(expect.arrayContaining(["rules", "history"]));
    expect(result.layersFailedUnexpected).toEqual(["history"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context/context-builder.test.ts -t "classifies layer failures"`
Expected: FAIL — `result.layersFailedUnexpected` is `undefined`.

- [ ] **Step 3: Add `layersFailedUnexpected` to `BuiltContext` and classify**

In `src/context/types.ts`, add to the `BuiltContext` interface (after `layersFailed`):

```typescript
  /** Subset of layersFailed whose error was NOT a known timeout/DB error (alarm-worthy). */
  layersFailedUnexpected: string[];
```

In `src/context/context-builder.ts`, add a classifier helper near the top (after `headingFor`):

```typescript
const EXPECTED_FAILURE_PATTERNS = [
  /timeout/i,
  /relation .* does not exist/i,
  /column .* does not exist/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
];

function isExpectedFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return EXPECTED_FAILURE_PATTERNS.some((re) => re.test(msg));
}
```

In `build()`, change the `layersFailed` collection loop and `assemble` calls to also track unexpected failures:

```typescript
    const blocks: ContextBlock[] = [];
    const layersFailed: string[] = [];
    const layersFailedUnexpected: string[] = [];
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") {
        blocks.push(res.value);
      } else {
        layersFailed.push(this.layers[i].name);
        if (!isExpectedFailure(res.reason)) {
          layersFailedUnexpected.push(this.layers[i].name);
        }
        blocks.push(emptyBlock(this.layers[i]));
      }
    });

    const limit = input.agentConfig.maxContextTokens ?? this.globalMaxTokens;
    const totalTokens = blocks.reduce((sum, b) => sum + b.tokenEstimate, 0);

    if (totalTokens <= limit) {
      return this.assemble(blocks, false, layersFailed, layersFailedUnexpected);
    }

    const compressed = this.compress(blocks, limit);
    return this.assemble(compressed, true, layersFailed, layersFailedUnexpected);
```

Update the `assemble` signature and return:

```typescript
  private assemble(
    blocks: ContextBlock[],
    compressed: boolean,
    layersFailed: string[],
    layersFailedUnexpected: string[],
  ): BuiltContext {
    const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
    const systemPrompt = sorted.map((b) => `${b.section}\n${b.content}`).join("\n\n");
    return {
      systemPrompt,
      totalTokens: sorted.reduce((sum, b) => sum + b.tokenEstimate, 0),
      layersUsed: sorted.map((b) => b.section),
      compressed,
      blocks: sorted,
      layersFailed,
      layersFailedUnexpected,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/context/context-builder.test.ts`
Expected: PASS — the DB error is expected (not in `layersFailedUnexpected`); the `TypeError` is unexpected.

- [ ] **Step 5: Surface unexpected failures on the span + factory test fixtures**

In `src/runtime/context-wiring.ts`, extend `setContextSpanAttributes` to also emit the unexpected set:

```typescript
export function setContextSpanAttributes(span: Span, built: BuiltContext): void {
  span.setAttribute("context.layers.used", built.layersUsed.join(","));
  span.setAttribute("context.layers.failed", built.layersFailed.join(","));
  span.setAttribute("context.layers.failed_unexpected", built.layersFailedUnexpected.join(","));
  span.setAttribute("context.layers.count", built.blocks.length);
  span.setAttribute("context.total_tokens", built.totalTokens);
}
```

In `src/runtime/context-wiring.test.ts`, the `built` fixture must now include the new field. Add `layersFailedUnexpected: []` to the `built` literal (after `layersFailed: ["memory"],`), and add an assertion in the `setContextSpanAttributes` test:

```typescript
    expect(setAttribute).toHaveBeenCalledWith("context.layers.failed_unexpected", "");
```

- [ ] **Step 6: Run wiring + builder tests**

Run: `npx vitest run src/context/context-builder.test.ts src/runtime/context-wiring.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify nothing else broke (fixtures with new field)**

Run: `npm run build && npx vitest run src/context/`
Expected: PASS — `BuiltContext` now requires `layersFailedUnexpected`; `assemble()` populates it, and test fixtures that construct a literal `BuiltContext` (only `context-wiring.test.ts`) were updated in Step 5.

- [ ] **Step 8: Commit**

```bash
git add src/context/types.ts src/context/context-builder.ts src/context/context-builder.test.ts src/runtime/context-wiring.ts src/runtime/context-wiring.test.ts
git commit -m "feat(context): classify layer failures (expected vs unexpected) for alarms"
```

---

### Task 12: Log unexpected layer failures at the ReAct call-site

**Files:**
- Modify: `src/runtime/execution-handler.ts`

- [ ] **Step 1: Add a warn log when `layersFailedUnexpected` is non-empty (ReAct)**

In `src/runtime/execution-handler.ts`, inside the ReAct builder `try` block added in Task 7, immediately after `setContextSpanAttributes(rootSpan, builtContext);`, add:

```typescript
          if (builtContext.layersFailedUnexpected.length > 0) {
            logger.warn(
              {
                execution_id,
                layers_failed_unexpected: builtContext.layersFailedUnexpected,
              },
              "CTX-01: context layers failed with unexpected errors",
            );
          }
```

- [ ] **Step 2: Verify build + suite**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): warn on unexpected context-layer failures (ReAct)"
```

---

### Task 13: Correct the `CLAUDE.md` bootstrap claim (M8)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Locate the over-stated builder line**

Run: `grep -n "5 layers\|5 layers com token budget\|Context Builder" CLAUDE.md`
Expected: shows the architecture diagram line "→ Context Builder (5 layers com token budget)" and/or the directory line "context/ — Context builder com 5 layers + tokenizer".

- [ ] **Step 2: Annotate the architecture diagram line**

In `CLAUDE.md`, change the diagram line:

```
    → Context Builder (5 layers com token budget)
```

to:

```
    → Context Builder (4 layers ativos atrás de CONTEXT_BUILDER_ENABLED; Calendar adiada — CTX-01/#39)
```

- [ ] **Step 3: Annotate the directory description line**

In `CLAUDE.md`, change:

```
  context/          — Context builder com 5 layers + tokenizer
```

to:

```
  context/          — Context builder com 5 layers (4 vivos via CONTEXT_BUILDER_ENABLED; Calendar adiada) + tokenizer + budget-enforcer
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: correct ContextBuilder status in CLAUDE.md (4 live layers, flag-gated — CTX-01)"
```

---

## Phase 3 — Reconciliation with CTX-02 (marker-aware) + Model-C budget gate

### Task 14: Insert `COMPRESSIBLE_MARKER` in the ReAct fold (head-preserving)

**Files:**
- Modify: `src/runtime/execution-handler.ts`
- Test: `src/runtime/context-wiring.test.ts` (marker behaviour already covered in Task 6; this task verifies enforceBudget head-preservation)

- [ ] **Step 1: Write a failing test proving head preservation under tight budget**

In `src/runtime/context-wiring.test.ts`, add a new top-level `describe` block:

```typescript
import { enforceBudget } from "../context/budget-enforcer.js";

describe("foldContext + enforceBudget (Phase 3 head-preserving)", () => {
  it("never truncates the head (base/rules/doctrine) under a tight budget", () => {
    const bigTail = Array.from({ length: 400 }, (_, i) => `line ${i} of history`).join("\n");
    const builtBig: BuiltContext = {
      systemPrompt: "ignored",
      totalTokens: 0,
      layersUsed: [],
      compressed: false,
      layersFailed: [],
      layersFailedUnexpected: [],
      blocks: [
        block("## Configuracao base", "IMPORTANT_BASE_PROMPT", 10, false),
        block("## Regras de encaminhamento", "IMPORTANT_RULES", 20, false),
        block("## Historico da conversa", bigTail, 50, true),
      ],
    };
    const folded = foldContext(builtBig, "IMPORTANT_DOCTRINE", { withMarker: true });
    const enforced = enforceBudget({ systemPrompt: folded, tools: [], maxContextTokens: 60 });

    expect(enforced.wasCompressed).toBe(true);
    expect(enforced.systemPrompt).toContain("IMPORTANT_BASE_PROMPT");
    expect(enforced.systemPrompt).toContain("IMPORTANT_RULES");
    expect(enforced.systemPrompt).toContain("IMPORTANT_DOCTRINE");
    // tail was trimmed
    expect(enforced.systemPrompt).not.toContain("line 399 of history");
  });
});
```

(`block`, `BuiltContext`, `foldContext` are already imported at the top of this test file from Task 6.)

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/runtime/context-wiring.test.ts -t "head-preserving"`
Expected: PASS — `foldContext(..., { withMarker: true })` inserts the marker; `enforceBudget` keeps the head intact and trims the tail. (If this fails, the marker is not being inserted between head and tail — re-check `foldContext`.)

- [ ] **Step 3: Turn on the marker in the ReAct fold**

In `src/runtime/execution-handler.ts`, in the ReAct builder `try` block (Task 7), change:

```typescript
          composedSystemPrompt = foldContext(builtContext, doctrineTail);
```

to:

```typescript
          composedSystemPrompt = foldContext(builtContext, doctrineTail, { withMarker: true });
```

And in the L3 seam reuse (Task 7, Step 4), change:

```typescript
              agentContext.systemPrompt = foldContext(builtContext, doctrineTail);
```

to:

```typescript
              agentContext.systemPrompt = foldContext(builtContext, doctrineTail, { withMarker: true });
```

- [ ] **Step 4: Verify build + suite**

Run: `npm run build && npx vitest run`
Expected: PASS. The existing CTX-02 `enforceBudget` at `:1312` now receives a marker-bearing prompt and becomes head-preserving automatically (no change to the enforceBudget call itself).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/execution-handler.ts src/runtime/context-wiring.test.ts
git commit -m "feat(runtime): insert COMPRESSIBLE_MARKER in ReAct fold (head-preserving budget)"
```

---

### Task 15: Add an `enforceBudget` gate to the Model-C path

**Files:**
- Modify: `src/runtime/execution-handler.ts`

Per B4/§11: `_dispatchModelCImpl` has no budget gate today. Add one before `runSurfaceAgentLoop` (`:377`), mirroring the ReAct CTX-02 block, and turn on the marker in the Model-C fold.

- [ ] **Step 1: Turn on the marker in the Model-C fold**

In `src/runtime/execution-handler.ts`, in the Model-C builder `try` block (Task 8), change:

```typescript
      agentContext.systemPrompt = foldContext(builtContextMc, doctrineTail);
```

to:

```typescript
      agentContext.systemPrompt = foldContext(builtContextMc, doctrineTail, { withMarker: true });
```

- [ ] **Step 2: Add the `enforceBudget` gate before `runSurfaceAgentLoop`**

In `src/runtime/execution-handler.ts`, locate the first-attempt branch in `_dispatchModelCImpl` — the comment `// 4 (continued). Run the normal doctrine-governed surface loop.` immediately precedes `const observations = await runWithTimeout(` (`:376`). Insert this block immediately BEFORE that `// 4 (continued)` comment (i.e. inside the `else {` first-attempt branch, before the surface loop runs):

```typescript
    // CTX-01/CTX-02 (Model-C, B4): enforce the token budget before reasoning,
    // mirroring the ReAct gate (handleExecution :1312). Model-C had NO gate
    // before this. Tools are counted but never trimmed.
    const budgetRawMc = (agentContext as { agentConfig?: { maxContextTokens?: unknown } }).agentConfig
      ?.maxContextTokens;
    const budgetTokensMc =
      typeof budgetRawMc === "number" && Number.isFinite(budgetRawMc) && budgetRawMc > 0
        ? budgetRawMc
        : undefined;
    const enforcedMc = enforceBudget({
      systemPrompt: agentContext.systemPrompt ?? "",
      tools: permittedTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      maxContextTokens: budgetTokensMc,
    });
    if (enforcedMc.warning) {
      logger.warn(
        { executionId, warning: enforcedMc.warning },
        "CTX-02 (Model-C): budget enforcement could not be applied; proceeding with full prompt",
      );
    } else if (enforcedMc.wasCompressed) {
      logger.info(
        {
          executionId,
          original_tokens: enforcedMc.originalTokens,
          final_tokens: enforcedMc.finalTokens,
          budget_tokens: enforcedMc.budgetTokens,
        },
        "CTX-02 (Model-C): system prompt compressed to fit token budget",
      );
    }
    agentContext.systemPrompt = enforcedMc.systemPrompt;

```

(Note: `AgentExecutionContext` has no `agentConfig.maxContextTokens` field, so the Model-C budget defaults to `DEFAULT_GLOBAL_MAX_TOKENS`; the cast probes defensively for any future field. `permittedTools` is in scope from `:322`; `enforceBudget` is already imported at `:60`.)

- [ ] **Step 3: Verify build + suite**

Run: `npm run build && npx vitest run`
Expected: PASS — flag still off by default, so Model-C runs the legacy compose; the new `enforceBudget` gate runs unconditionally but with no marker (legacy prompt) it falls back to proportional truncation only when over the 8000 default — i.e. no change for normal-sized prompts.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(runtime): add enforceBudget gate to Model-C path + marker fold (B4/§11)"
```

---

### Task 16: Integration test — tight budget keeps Base/Rules intact in both fold paths

**Files:**
- Modify: `src/context/context-builder.integration.test.ts`

- [ ] **Step 1: Write the test (factory build → fold with marker → enforceBudget)**

In `src/context/context-builder.integration.test.ts`, inside the `describe("ContextBuilder runtime (4 layers via factory)", ...)` block, add:

```typescript
  it("budget enforcement keeps Base/Rules intact and trims history tail", async () => {
    const { foldContext: fold } = await import("../runtime/context-wiring.js");
    const { enforceBudget } = await import("./budget-enforcer.js");

    const longHistory = Array.from({ length: 300 }, (_, i) => ({
      role: "Cliente",
      content: `mensagem numero ${i} com bastante texto para encher`,
      created_at: new Date(),
    }));
    const mockDb = {
      query: vi
        .fn()
        // Rules
        .mockResolvedValueOnce({ rows: [{ id: 1, description: "REGRA_CRITICA" }] })
        // Memory profile
        .mockResolvedValueOnce({ rows: [] })
        // Memory facts
        .mockResolvedValueOnce({ rows: [] })
        // History
        .mockResolvedValueOnce({ rows: longHistory }),
    };

    const builder = createContextBuilder({ db: mockDb as never }, { layerTimeoutMs: 5000 });
    const built = await builder.build({
      executionId: "exec-budget",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 1n,
      conversationKey: "conv-budget",
      agentConfig: { systemPrompt: "BASE_PROMPT_CRITICO" },
      dispatchPayload: {},
    });

    const folded = fold(built, "DOUTRINA_CRITICA", { withMarker: true });
    const enforced = enforceBudget({ systemPrompt: folded, tools: [], maxContextTokens: 80 });

    expect(enforced.wasCompressed).toBe(true);
    expect(enforced.systemPrompt).toContain("BASE_PROMPT_CRITICO");
    expect(enforced.systemPrompt).toContain("REGRA_CRITICA");
    expect(enforced.systemPrompt).toContain("DOUTRINA_CRITICA");
    expect(enforced.systemPrompt).not.toContain("mensagem numero 299");
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/context/context-builder.integration.test.ts -t "budget enforcement keeps"`
Expected: PASS — head preserved, tail trimmed.

- [ ] **Step 3: Commit**

```bash
git add src/context/context-builder.integration.test.ts
git commit -m "test(context): integration — tight budget preserves Base/Rules/doctrine head"
```

---

## Phase 4 — Regression + flag flip + CalendarLayer follow-up

### Task 17: Full regression with flag OFF and flag ON

**Files:**
- (no source changes — verification task)

- [ ] **Step 1: Run the full suite with the flag OFF (default)**

Run: `npx vitest run`
Expected: PASS — all suites green. This is the default-off behaviour (today's behaviour preserved).

- [ ] **Step 2: Run the full suite with the flag ON**

Run: `CONTEXT_BUILDER_ENABLED=true npx vitest run`
Expected: PASS — turning the flag on must not break any existing test. (Tests that construct a real `Pool` would need a DB; the existing suites mock or skip DB-bound paths. If a test fails ONLY because it now hits an unmocked layer query, that test must be fixed to provide a mock `db` or the builder must remain gated behind the test's own env — note the failure and resolve before flipping the default. Do not flip the default until this is green.)

- [ ] **Step 3: Run lint + build**

Run: `npm run lint && npm run build`
Expected: PASS — no lint errors, no TS errors.

- [ ] **Step 4: Commit (only if any fixes were needed in Step 2)**

```bash
git add -A
git commit -m "test: regression fixes for CONTEXT_BUILDER_ENABLED=true"
```

(If no fixes were needed, skip this commit.)

---

### Task 18: Flip the default flag to ON

**Files:**
- Modify: `src/config/env.ts`

- [ ] **Step 1: Change the default to `"true"`**

In `src/config/env.ts`, change the `CONTEXT_BUILDER_ENABLED` default (added in Task 2) from:

```typescript
    CONTEXT_BUILDER_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
```

to:

```typescript
    CONTEXT_BUILDER_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
```

- [ ] **Step 2: Run the full suite (now default-on)**

Run: `npx vitest run`
Expected: PASS — equivalent to Task 17 Step 2 which is now the default.

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "feat(config): flip CONTEXT_BUILDER_ENABLED default to true (Phase 4, CTX-01)"
```

---

### Task 19: Document the CalendarLayer follow-up and close CTX-01

**Files:**
- Modify: `CLAUDE.md` (final status note)

- [ ] **Step 1: Add a follow-up note near the context directory line**

In `CLAUDE.md`, locate the `context/` directory line edited in Task 13 and append a parenthetical follow-up note. Change:

```
  context/          — Context builder com 5 layers (4 vivos via CONTEXT_BUILDER_ENABLED; Calendar adiada) + tokenizer + budget-enforcer
```

to:

```
  context/          — Context builder com 5 layers (4 vivos via CONTEXT_BUILDER_ENABLED=true; CalendarLayer adiada — requer CalendarContextAdapter, follow-up de #39) + tokenizer + budget-enforcer
```

- [ ] **Step 2: Open the CalendarLayer follow-up issue**

Run:

```bash
gh issue create \
  --title "CTX-01 follow-up: CalendarContextAdapter to enable CalendarLayer in the runtime ContextBuilder" \
  --body "CalendarLayer was deferred from CTX-01 (#39) because \`src/context/layers/calendar.layer.ts\` requires a \`CalendarClient.getCalendarContext(orgId)\` implementor, and \`src/integration/calendar-client.ts\` does not provide one. Build a \`CalendarContextAdapter\` over the calendar client and add \`new CalendarLayer(adapter)\` to \`createContextBuilder\` (prio 30, compressible tail). 

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: prints the new issue URL. (If `gh` is unavailable or unauthenticated, note the follow-up text in the PR description instead and skip this step.)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note CalendarLayer follow-up; CTX-01 (#39) resolved"
```

---

## Self-Review (run by the plan author; issues fixed inline)

**1. Spec coverage** — every spec requirement maps to a task:

- DI factory (§4 "Factory com DI", B1/B2) → Task 5.
- Fail-open via `Promise.allSettled` + per-layer timeout (B3, §4) → Task 3.
- `ContextInput.contactId` optional (M7) + `MemoryLayer` skip guard → Task 1 + Task 4.
- `BuiltContext.blocks` + `layersFailed` non-breaking additions (§4) → Task 1.
- Single-owner base prompt via `composeSystemPrompt("")` + base-once snapshot (B5) → Task 6 (`foldContext`) + Task 9 (snapshot).
- ReAct wiring (replace `:933`, build after `:972`) → Task 7.
- Build-once reuse at the L3 seam (`:1266`, M5) → Task 7 Step 4.
- Model-C wiring (before `:239`, M2/M3) → Task 8.
- Env flags `CONTEXT_BUILDER_ENABLED` (default off) + layer timeout → Task 2; flip → Task 18.
- Observability span attrs extending `context.*` (used/failed/count + total tokens) → Task 6 (`setContextSpanAttributes`) wired in Task 7; unexpected-failure attr → Task 11/12.
- Marker/budget reconciliation (Phase 3, head-preserving) → Task 14.
- Model-C budget gate (B4/§11) → Task 15.
- Layer-error taxonomy (§8 Q2, "resolve before Phase 2") → Task 11 (placed at the Phase 1/2 boundary, before the Phase 3 marker work, satisfying "antes da Phase 2" intent for alarms).
- Docs (`CLAUDE.md`, M8) → Task 13 + Task 19.
- Tests: factory, fail-open, build-once/path, fallback, snapshot, budget, double-injection → Tasks 5/9/10/11/14/16 (+ wiring helper tests in Task 6).
- Regression with flag on/off (Phase 4) → Task 17.
- CalendarLayer follow-up documented (B2/§11.1) → Task 19.

**2. Placeholder scan** — no "TBD"/"add error handling"/"similar to Task N"/"write tests for the above" present; every code step contains full code; every test step shows the assertion and the run command with expected output.

**3. Type consistency** — verified against the live code:
- `createContextBuilder(deps: BuilderDeps, options?: BuilderFactoryOptions)` is the single factory name used in Tasks 5/7/8/9/10/16.
- `ContextBuilder` constructor stays positional `(layers, options)`; `options.layerTimeoutMs` added in Task 3 and consumed by the factory in Task 5.
- `BuiltContext` gains `blocks` + `layersFailed` (Task 1) and `layersFailedUnexpected` (Task 11); every `BuiltContext` literal in tests (`context-wiring.test.ts`) is updated to include all three (Task 6 sets the first two; Task 11 Step 5 adds the third). `assemble()` populates all three.
- `foldContext(built, doctrineTail, options?)` signature is identical across Tasks 6/9/14/16; `setContextSpanAttributes(span, built)` identical across Task 6/11.
- `buildContextInput(args)` leaves `agentConfig.maxContextTokens` undefined (Phase 1-2 no-compress contract, §4 "Faseamento") — consistent with the ReAct/Model-C call-sites that omit it.
- Heading strings match the live layers exactly (m2): `## Configuracao base`, `## Regras de encaminhamento`, `## Informacoes do contato`, `## Historico da conversa`, `## Agenda`.

**Verified anchor drift fixed (vs spec line numbers):** ReAct compose at `:933`, `contactIdCtx` at `:963`, `agentContext` at `:972`, L3 seam at `:1263-1273`, CTX-02 `enforceBudget` at `:1312`, span attrs `:1326-1329`; Model-C `_dispatchModelCImpl` at `:189`, compose 5-arg `:239`, `runSurfaceAgentLoop` `:377`; `env_ = getEnv()` at `:937`. Tasks reference these verified anchors plus stable nearby comments so the engineer can relocate them even if minor drift occurs.
