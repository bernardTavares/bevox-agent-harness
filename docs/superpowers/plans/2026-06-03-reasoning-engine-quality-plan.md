# Reasoning-Engine Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land three `src/reasoning/` quality fixes — make ReflexionWrapper's learned-context actually feed the ReAct retry (R01 / a-reasoning-01), make `runSurfaceAgentLoop` return the *final escalated* engine so `/complete.strategy`/`escalated` and the loop span reflect reality (R02 / a-reasoning-02), and drive ReWOO via its tested `executeWaves` parallel path on the escalate-to-rewoo branch (R03 / a-reasoning-03).

**Architecture:** Three independent, individually-revertible phases. **R01** formalizes `reflexionNotes?: string[]` on `AgentExecutionContext`, drops the unsafe cast in `reflexion.ts:augmentContext`, and prepends those notes to the `doctrine` channel of `ReactEngine.step` (the channel `LlmClientBridge` injects as a leading system message, so the retry is no longer byte-identical to the first attempt). **R02** changes `runSurfaceAgentLoop` to return a `SurfaceLoopResult { observations, engine, escalated, escalationChain }`; both synthesis sites (main + Model-C) use `loopResult.engine` instead of a fresh `strategyRouter.build`; the wrap-reflexion branch wraps at most once (guard) but always emits `engine_strategy` + pushes a deduped `"reflexion"` marker; the main loop span stamps `reasoning.final_strategy`/`escalated`/`escalation_chain`. **R03** replaces the sequential drive on the escalate-to-rewoo branch with `rewoo.executeWaves(...)` inside a `reasoning.rewoo.waves` span, gated by J8 (deadline) and J9 (cost) before and after, catching `CyclicDependencyError`, then `break`-ing the loop.

**Tech Stack:** Node.js 20, TypeScript 5.9 (ESM/NodeNext — all relative imports use `.js` extensions), Vitest 4. `npm run build` = `tsc && copy-skill-manifests`; `npm run test:unit` = `vitest run tests/unit`. Run a single file with `npm run test:unit -- <path-or-substring>`. **Never** set `RUN_INTEGRATION`. New tests go ONLY under `tests/**/*.test.ts` (the `vitest.config.ts` `include` is `tests/**/*.test.ts` — co-located `src/**` tests are NOT run; do not add any).

**Branch & coordination:**
- Branch from `origin/main` (this is post all merges; the audit predates them, so line refs below were re-verified against live code — several spec line refs were stale and are corrected here).
- Phase order is **R01 → R02 → R03** (R03 depends on the `escalationChain`/`SurfaceLoopResult` introduced in R02). Each phase is its own commit set.
- **Build/CI caveat (unverified by this plan):** `j-build-01` (missing `@rolldown/binding-linux-x64-gnu`) and `j-build-02` (prettier red) may block the vitest suite in CI. Run the targeted suites locally and flag in the PR; do not claim CI-green without local evidence.
- **Reviewer deferred decisions (resolve before committing the affected phase):**
  - **OQ2 (R02 `escalated` semantics)** — this plan ships `escalated = escalationChain.length > 1`, which marks `escalated: true` for reflexion-only runs (the most common scheduler path) even though the literal `strategy` stays `"react"`. The backend `/complete` contract owner must confirm this is the desired semantic; the alternative (`engine.strategy !== reasoning.default`) is a one-line change noted inline in Task 9. **Confirm before merging Phase 2.**
  - **OQ1 (R03 scope)** — escalate-to-rewoo is reachable ONLY via React→plan-execute→rewoo (never directly from React; the ReAct plan is 1-step so Rule 2 never fires from it), the dependent step runs blind to prerequisite output (ORDER honored, not data-flow — OQ6), and the path has never run in prod. The founder must confirm there is a real ReWOO use case for the pilot before spending the ~4h on Phase 3; if not, Phase 3 should be DELETED (remove `executeWaves` + the branch) rather than wired. **Confirm before starting Phase 3.**

---

## File Structure

**Modified (Phase 1 — R01):**
- `src/agents/execution-context.ts` — add `reflexionNotes?: string[]` to `AgentExecutionContext` (after `originalExecutionId`, ends `:128`).
- `src/reasoning/reflexion.ts` — `augmentContext` (`:188-202`): drop the `as unknown as object` cast; use the typed field.
- `src/reasoning/react.ts` — `step` (`:97-105`): build a `reflexionPreamble` and pass the enriched `doctrine` to `complete` (the `:104` `doctrine: context.systemPrompt` line). `synthesize()` is ALREADY the fixed `data.*` version from the mutation-tool plan — DO NOT touch it.
- Tests: `tests/unit/reasoning/reflexion.test.ts` (extend), `tests/unit/reasoning/react.test.ts` (extend).

**Modified (Phase 2 — R02):**
- `src/runtime/execution-handler.ts` — `interface SurfaceLoopResult`; change `runSurfaceAgentLoop` return type + body (`:834-968`); wrap-reflexion guard + emit + chain (`:921-922`); main path (`:1909-1949`) capture loopResult, stamp span attrs, synthesize with `loopResult.engine`; Model-C path (`:491-508`) same capture + engine reuse.
- Tests: `tests/unit/runtime/surface-loop-escalation.test.ts` (new).

**Modified (Phase 3 — R03):**
- `src/runtime/execution-handler.ts` — import `CyclicDependencyError`; rewrite the escalate-to-rewoo branch (`:943-960`) to drive `executeWaves` inside a `reasoning.rewoo.waves` span with J8/J9 gates and `break`.
- Tests: `tests/unit/runtime/surface-loop-rewoo.test.ts` (new). Existing `tests/unit/reasoning/rewoo.test.ts` executeWaves cases stay green (reused, not edited).

---

## Phase 1 — R01 Reflexion learning feeds the retry

### Task 1: Formalize `reflexionNotes` on `AgentExecutionContext`

**Files:**
- Modify: `src/agents/execution-context.ts:128`

- [ ] **Step 1: Add the typed field** — in `src/agents/execution-context.ts`, immediately AFTER the `originalExecutionId?: string;` field (its JSDoc block ends at `:128`) and BEFORE the `usageAccumulator` JSDoc, insert:

```typescript
  /**
   * a-reasoning-01 — Notas de reflexão acumuladas pelo ReflexionWrapper. Em
   * cada retry de falha o wrapper anexa o `learnedContext` derivado pela
   * micro-call de `_evaluateFailure`. Engines que suportam reflexão (hoje só
   * `ReactEngine`) prependem estas notas à doctrine do prompt do retry, para
   * que a 2ª tentativa de fato se beneficie do insight. ABSENT (default) /
   * vazio → comportamento byte-idêntico ao 1º attempt. Engines que não leem o
   * campo (rewoo/plan-execute/direct hoje) o ignoram — follow-up.
   *
   * NB privacidade (harness-llm.md): as notas são derivadas de LLM sobre
   * mensagens de erro/saída de tool; ficam dentro da mesma postura de
   * redaction — nunca logar a doctrine montada.
   */
  reflexionNotes?: string[];
```

- [ ] **Step 2: Build to verify the type compiles**

Run: `npm run typecheck`
Expected: exits 0 (the field is optional; no existing caller breaks).

- [ ] **Step 3: Commit**

```bash
git add src/agents/execution-context.ts
git commit -m "feat(reasoning): add reflexionNotes to AgentExecutionContext (a-reasoning-01)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Drop the unsafe cast in `reflexion.ts:augmentContext`

**Files:**
- Modify: `src/reasoning/reflexion.ts:188-202`
- Test: `tests/unit/reasoning/reflexion.test.ts` (existing `:196-231` case stays valid; no new test here — Task 3 proves the reader)

> The existing test `"augments context with reflexionNotes across retries (no mutation of original)"` (`reflexion.test.ts:196-231`) reads `reflexionNotes` off the context via its own cast and asserts the original is not mutated. It MUST stay green after the cast is removed (the runtime behavior is identical; only the type-level cast goes away).

- [ ] **Step 1: Run the existing reflexion suite to confirm green baseline**

Run: `npm run test:unit -- reflexion`
Expected: PASS — all 10 cases green (including the `:196-231` augment case).

- [ ] **Step 2: Replace `augmentContext`** — in `src/reasoning/reflexion.ts`, replace this exact block (`:188-202`):

```typescript
  private augmentContext(
    context: AgentExecutionContext,
    learnedContext: string,
  ): AgentExecutionContext {
    // AgentExecutionContext does not define reflexionNotes — we attach it
    // as an extended property via a type assertion on a shallow copy
    const extended = context as AgentExecutionContext & { reflexionNotes?: string[] };
    const existingNotes: string[] = extended.reflexionNotes ?? [];

    return {
      ...context,
      // Carry the reflexion notes forward
      ...({ reflexionNotes: [...existingNotes, learnedContext] } as unknown as object),
    };
  }
```

with:

```typescript
  private augmentContext(
    context: AgentExecutionContext,
    learnedContext: string,
  ): AgentExecutionContext {
    // a-reasoning-01 — `reflexionNotes` agora é tipado em
    // AgentExecutionContext, então o cast inseguro (`as unknown as object`)
    // some. Cópia rasa: o original NÃO é mutado (coberto pelo teste
    // "no mutation of original").
    const existingNotes = context.reflexionNotes ?? [];
    return {
      ...context,
      reflexionNotes: [...existingNotes, learnedContext],
    };
  }
```

- [ ] **Step 3: Run the reflexion suite to verify it still passes**

Run: `npm run test:unit -- reflexion`
Expected: PASS — same 10 cases green; the augment case still observes `['fix-me-up']` and the original context's `reflexionNotes` is still `undefined`.

- [ ] **Step 4: Commit**

```bash
git add src/reasoning/reflexion.ts
git commit -m "refactor(reasoning): drop unsafe cast in augmentContext now that reflexionNotes is typed (a-reasoning-01)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `ReactEngine.step` prepends reflexion notes to the doctrine

**Files:**
- Modify: `src/reasoning/react.ts:97-105`
- Test: `tests/unit/reasoning/react.test.ts`

> **Why `.doctrine` and not `.system`:** `react.ts:85` builds the ReAct goal+tools prompt into `systemPrompt` and passes it as `req.system`. The agent doctrine is passed separately via `req.doctrine` (`react.ts:104`). `LlmClientBridge.complete` injects `req.doctrine` as a LEADING system message ahead of `req.system` — so prepending the reflexion preamble to `doctrine` reaches the model. The `FakeLlmClient` records the full `LlmCompletionRequest` (which has `doctrine`), so tests assert `calls[retryIdx].doctrine`, NOT `.system`.

- [ ] **Step 1: Write the failing test** — append these two cases to `tests/unit/reasoning/react.test.ts`, immediately BEFORE the final closing `});` of the `describe('ReactEngine', ...)` block:

```typescript
  it("step() prepends reflexionNotes to the doctrine (retry sees the lesson)", async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ thinking: "retrying", text: "done" })],
    });
    const engine = new ReactEngine();
    const ctx = {
      ...makeContext(llm, { systemPrompt: "BASE DOCTRINE" }),
      reflexionNotes: ["use param X"],
    };
    const plan = await engine.plan("goal", ctx);
    await engine.step(plan, 0, [], ctx, async () => ({ ok: true }));
    const call = llm.calls[0];
    expect(call.doctrine).toContain("use param X");
    expect(call.doctrine).toContain("BASE DOCTRINE");
    // The ReAct goal+tools prompt stays in `.system`, untouched by the note.
    expect(call.system).toContain("autonomous agent");
    expect(call.system).not.toContain("use param X");
  });

  it("step() with no reflexionNotes → doctrine is byte-identical to systemPrompt", async () => {
    const llm = new FakeLlmClient({
      responses: [llmJson({ thinking: "t", text: "done" })],
    });
    const engine = new ReactEngine();
    const ctx = makeContext(llm, { systemPrompt: "BASE DOCTRINE" });
    const plan = await engine.plan("goal", ctx);
    await engine.step(plan, 0, [], ctx, async () => ({ ok: true }));
    expect(llm.calls[0].doctrine).toBe("BASE DOCTRINE");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- react.test`
Expected: FAIL — the first new case fails because `call.doctrine` is `"BASE DOCTRINE"` (no `"use param X"`); the reader is not implemented yet.

- [ ] **Step 3: Write minimal implementation** — in `src/reasoning/react.ts`, the `step()` method currently builds `systemPrompt` at `:85` and calls `complete({...})` at `:97-105` with `doctrine: context.systemPrompt`. Insert the preamble computation AFTER the `const systemPrompt = this.buildSystemPrompt(...)` line (`:85`) and the `const userContent = ...` line (`:89`), and change the `doctrine` argument. Replace this exact block (`:97-105`):

```typescript
    try {
      const response = await context.llmClient.complete({
        model,
        system: systemPrompt,
        user: userContent,
        responseFormat: { type: "json_object" },
        maxTokens: 1024,
        doctrine: context.systemPrompt,
      });
```

with:

```typescript
    // a-reasoning-01 — injeta as notas de reflexão (se houver) na doctrine do
    // retry. Sem notas → byte-idêntico (doctrine = systemPrompt puro). A
    // doctrine vira system message LÍDER no LlmClientBridge, então o retry
    // NÃO é mais idêntico ao 1º attempt.
    const reflexionPreamble =
      context.reflexionNotes && context.reflexionNotes.length > 0
        ? `Prior attempt(s) failed. Apply these lessons:\n${context.reflexionNotes
            .map((n, i) => `${i + 1}. ${n}`)
            .join("\n")}\n\n`
        : "";
    const doctrine = reflexionPreamble
      ? `${reflexionPreamble}${context.systemPrompt ?? ""}`
      : context.systemPrompt;

    try {
      const response = await context.llmClient.complete({
        model,
        system: systemPrompt,
        user: userContent,
        responseFormat: { type: "json_object" },
        maxTokens: 1024,
        doctrine,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- react.test`
Expected: PASS — both new cases green; the no-notes case proves byte-identical behavior; all pre-existing ReactEngine cases still pass.

- [ ] **Step 5: Add the end-to-end reflexion-feeds-react case** — append this case to `tests/unit/reasoning/reflexion.test.ts`, immediately BEFORE the final closing `});` of the `describe('ReflexionWrapper', ...)` block. It uses a REAL `ReactEngine` as the inner engine so the note flows through `augmentContext` into the retry's doctrine:

```typescript
  it("a-reasoning-01: retry through a REAL ReactEngine receives the reflexion note in its doctrine", async () => {
    const { ReactEngine } = await import("../../../src/reasoning/react.js");
    const inner = new ReactEngine();
    // 1) ReAct step #1 fails (executeTool throws) → step result success=false.
    // 2) _evaluateFailure micro-call returns learnedContext.
    // 3) ReAct retry step succeeds (plain-text answer, no tool).
    const llm = new FakeLlmClient({
      responses: [
        llmJson({ thinking: "call tool", toolName: "boom", toolParams: {} }), // attempt 1 (tool throws)
        llmJson({ learnedContext: "use param X" }), // _evaluateFailure micro-call
        llmJson({ thinking: "recovered", text: "ok" }), // retry attempt
      ],
    });
    const ctx = makeContext(llm, { systemPrompt: "BASE" });
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 2 });
    const plan = await wrapper.plan("g", ctx);
    let calls = 0;
    const result = await wrapper.step(plan, 0, [], ctx, async () => {
      calls++;
      if (calls === 1) throw new Error("tool exploded");
      return { ok: true };
    });
    expect(result.success).toBe(true);
    // The retry ReAct call is the one whose `.system` is the ReAct prompt
    // (contains "autonomous agent") — NOT the failure-analyst micro-call.
    const reactCalls = llm.calls.filter((c) => c.system.includes("autonomous agent"));
    const retryCall = reactCalls[reactCalls.length - 1];
    expect(retryCall.doctrine).toContain("use param X");
  });

  it("a-reasoning-01: success on first attempt → no _evaluateFailure micro-call", async () => {
    const { ReactEngine } = await import("../../../src/reasoning/react.js");
    const inner = new ReactEngine();
    const llm = new FakeLlmClient({
      responses: [llmJson({ thinking: "answer", text: "done" })],
    });
    const ctx = makeContext(llm, { systemPrompt: "BASE" });
    const wrapper = new ReflexionWrapper({ inner, maxRetries: 2 });
    const plan = await wrapper.plan("g", ctx);
    const result = await wrapper.step(plan, 0, [], ctx, async () => ({ ok: true }));
    expect(result.success).toBe(true);
    // Exactly one LLM call (the ReAct step). No failure-analyst micro-call,
    // so no call carries a "failure analyst" system prompt.
    expect(llm.calls.some((c) => c.system.includes("failure analyst"))).toBe(false);
    expect(llm.calls).toHaveLength(1);
  });
```

- [ ] **Step 6: Run the reflexion suite to verify it passes**

Run: `npm run test:unit -- reflexion`
Expected: PASS — the two new cases green; the retry's doctrine contains `"use param X"`; the first-attempt-success case makes exactly one call with no failure-analyst prompt.

- [ ] **Step 7: Commit**

```bash
git add src/reasoning/react.ts tests/unit/reasoning/react.test.ts tests/unit/reasoning/reflexion.test.ts
git commit -m "feat(reasoning): ReactEngine prepends reflexionNotes to retry doctrine (a-reasoning-01)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Phase 1 gate — build + full reasoning suite

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 2: Run the reasoning suite**

Run: `npm run test:unit -- tests/unit/reasoning`
Expected: PASS — reflexion, react, rewoo, plan-execute, direct suites all green.

---

## Phase 2 — R02 escalated-engine telemetry

> **Resolve OQ2 (`escalated` semantics) with the `/complete` contract owner before committing this phase.** This plan ships `escalated = escalationChain.length > 1` (Task 9, Step 4). The alternative is noted inline.

### Task 5: Introduce `SurfaceLoopResult` and change the loop's return type

**Files:**
- Modify: `src/runtime/execution-handler.ts:834-968`
- Test: `tests/unit/runtime/surface-loop-escalation.test.ts` (new)

> `runSurfaceAgentLoop` currently returns `Observation[]`. Both call sites consume that directly: main path `:1928` (`result.length`) + passes `observations` to synthesize `:1946`; Model-C `:491-508`. This task changes ONLY the function's return shape and accumulates `escalationChain`; the call-site updates land in Tasks 8 (main) and 9 (Model-C) so each commit stays focused.

- [ ] **Step 1: Write the failing test** — create `tests/unit/runtime/surface-loop-escalation.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

import { runSurfaceAgentLoop } from "../../../src/runtime/execution-handler.js";
import type { AgentDefinition } from "../../../src/agents/types.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { ToolExecutor } from "../../../src/reasoning/engine.js";
import { ReflexionWrapper } from "../../../src/reasoning/reflexion.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";

function makeLoopContext(
  llm: FakeLlmClient,
  extra: Partial<AgentExecutionContext> = {},
): AgentExecutionContext {
  return {
    executionId: "exec-loop-1",
    organizationId: "org-loop-1",
    conversationKey: "conv-1",
    db: {} as never,
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
    } as never,
    llmClient: llm,
    accountConfig: { llmModel: "fake-model" },
    systemPrompt: "DOCTRINE",
    ...extra,
  };
}

// Scheduler-like agent: React default + onFailure:reflexion. The router wraps
// the engine in a ReflexionWrapper at build time (escalation.onFailure ===
// "reflexion"), so the loop ALREADY starts wrapped.
const reflexionAgent: AgentDefinition = {
  name: "loop-test-react",
  type: "surface",
  description: "react + reflexion",
  reasoning: {
    default: "react",
    escalation: {
      stepThreshold: 99,
      escalateTo: "plan-execute",
      parallelThreshold: 99,
      onFailure: "reflexion",
    },
  },
  permissions: { required: [], denied: [] },
};

const noop: ToolExecutor = async () => ({ ok: true });

describe("runSurfaceAgentLoop — SurfaceLoopResult (R02)", () => {
  it("non-escalated run returns escalated=false and chain=[engine.strategy]", async () => {
    // ReAct returns a plain-text answer on step 0 → loop ends without failure.
    const llm = new FakeLlmClient({
      responses: [{ content: JSON.stringify({ thinking: "t", text: "done" }), model: "m", promptTokens: 1, completionTokens: 1 }],
    });
    const result = await runSurfaceAgentLoop(reflexionAgent, "goal", makeLoopContext(llm), [], noop);
    expect(result.observations.length).toBeGreaterThanOrEqual(1);
    expect(result.escalated).toBe(false);
    expect(result.escalationChain).toEqual(["react"]);
    expect(result.engine.strategy).toBe("react");
  });

  it("wrap-reflexion: emits engine_strategy + pushes 'reflexion' to chain EVEN when already wrapped", async () => {
    // First ReAct step fails (executeTool throws) → Rule 1 fires wrap-reflexion.
    // The engine is already a ReflexionWrapper (router wrapped it), so the
    // guard must NOT re-wrap, but the telemetry/chain MUST still fire.
    const llm = new FakeLlmClient({
      responses: [
        { content: JSON.stringify({ toolName: "boom", toolParams: {} }), model: "m", promptTokens: 1, completionTokens: 1 }, // step 0 calls tool that throws
        { content: JSON.stringify({ learnedContext: "x" }), model: "m", promptTokens: 1, completionTokens: 1 }, // _evaluateFailure
        { content: JSON.stringify({ text: "done" }), model: "m", promptTokens: 1, completionTokens: 1 }, // reflexion retry
        { content: JSON.stringify({ text: "done-again" }), model: "m", promptTokens: 1, completionTokens: 1 }, // next loop step (if any)
      ],
    });
    const events: Array<{ type: string; payload: unknown }> = [];
    const ctx = makeLoopContext(llm, {
      streamCallback: async (e) => {
        events.push(e);
      },
    });
    let calls = 0;
    const throwingTool: ToolExecutor = async () => {
      calls++;
      if (calls === 1) throw new Error("tool boom");
      return { ok: true };
    };
    const result = await runSurfaceAgentLoop(reflexionAgent, "goal", ctx, [], throwingTool);
    // chain includes the reflexion marker exactly once (deduped)
    expect(result.escalationChain).toContain("reflexion");
    expect(result.escalationChain.filter((s) => s === "reflexion")).toHaveLength(1);
    expect(result.escalated).toBe(true);
    // engine_strategy event fired for the reflexion transition
    const strat = events.filter((e) => e.type === "engine_strategy");
    expect(strat.some((e) => (e.payload as { to?: string }).to === "reflexion")).toBe(true);
    // No multiplicative nesting: final engine is a SINGLE ReflexionWrapper,
    // whose inner is NOT itself a ReflexionWrapper.
    expect(result.engine).toBeInstanceOf(ReflexionWrapper);
    expect((result.engine as unknown as { inner: unknown }).inner).not.toBeInstanceOf(
      ReflexionWrapper,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- surface-loop-escalation`
Expected: FAIL — `result.observations`/`result.escalated`/`result.escalationChain`/`result.engine` are undefined (the function still returns `Observation[]`).

- [ ] **Step 3: Add the `SurfaceLoopResult` interface** — in `src/runtime/execution-handler.ts`, immediately ABOVE the `export async function runSurfaceAgentLoop(` declaration (`:834`), insert:

```typescript
/**
 * R02 (a-reasoning-02) — resultado do surface loop, expondo o engine que de
 * fato executou o último step (escalado ou não) para que o synthesis e a
 * telemetria reflitam a realidade, não o default do agent.
 */
export interface SurfaceLoopResult {
  observations: Observation[];
  /** Engine que executou o último step (escalado/embrulhado ou o original). */
  engine: ReasoningEngine;
  /** true se houve qualquer swap/reflexão (escalationChain.length > 1). */
  escalated: boolean;
  /** Cadeia from→to: ["react"] = sem escalation; ["react","reflexion"] etc. */
  escalationChain: string[];
}
```

- [ ] **Step 4: Change the signature, accumulate the chain, and return the result** — in `src/runtime/execution-handler.ts`, change the return type on the `runSurfaceAgentLoop` signature (`:841`):

Replace:

```typescript
): Promise<Observation[]> {
```

with:

```typescript
): Promise<SurfaceLoopResult> {
```

Then, immediately after `let stepIndex = 0;` (`:852`), insert the chain initializer:

```typescript
  // R02 — cadeia de estratégias para telemetria. Inicia com a estratégia do
  // engine construído pelo router (o scheduler entra como ReflexionWrapper,
  // cujo `.strategy` delega ao inner React → "react").
  const escalationChain: string[] = [engine.strategy];
```

Replace the wrap-reflexion branch (`:921-922`):

```typescript
      if (decision.action === "wrap-reflexion") {
        engine = new ReflexionWrapper({ inner: engine });
      } else if (decision.action === "escalate-to-plan-execute") {
```

with:

```typescript
      if (decision.action === "wrap-reflexion") {
        // R02 — embrulha NO MÁXIMO uma vez. O scheduler JÁ entra embrulhado
        // pelo router (onFailure:'reflexion'), então normalmente NÃO re-embrulha
        // — sem este guard, cada falha repetida (Rule 1 re-dispara) aninharia
        // um novo ReflexionWrapper, multiplicando os retries.
        if (!(engine instanceof ReflexionWrapper)) {
          engine = new ReflexionWrapper({ inner: engine });
        }
        // Telemetria/cadeia disparam SEMPRE (mesmo já-embrulhado), senão a
        // observabilidade de reflexão fica morta p/ o scheduler. Dedup: só
        // empurra "reflexion" se ainda não for o topo da cadeia.
        if (escalationChain[escalationChain.length - 1] !== "reflexion") {
          escalationChain.push("reflexion");
        }
        if (agentContext.streamCallback) {
          try {
            await agentContext.streamCallback({
              type: "engine_strategy",
              payload: { from: fromStrategy, to: "reflexion", reason: decision.action },
            });
          } catch {
            // best-effort
          }
        }
        // (sem `continue` — comportamento legado: cai em stepIndex++)
      } else if (decision.action === "escalate-to-plan-execute") {
```

Add `escalationChain.push(engine.strategy);` to the plan-execute branch, immediately after `engine = new PlanExecuteEngine();` (`:924`):

```typescript
        engine = new PlanExecuteEngine();
        escalationChain.push(engine.strategy);
```

Add the same to the rewoo branch, immediately after `engine = new ReWOOEngine();` (`:944`):

```typescript
        engine = new ReWOOEngine();
        escalationChain.push(engine.strategy);
```

Finally, replace the return statement (`:967`):

```typescript
  return allObservations;
}
```

with:

```typescript
  return {
    observations: allObservations,
    engine,
    escalated: escalationChain.length > 1,
    escalationChain,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:unit -- surface-loop-escalation`
Expected: PASS — non-escalated run returns `escalated:false`, `chain:["react"]`; the failure case pushes `"reflexion"` once, fires `engine_strategy`, and the final engine is a single (non-nested) `ReflexionWrapper`.

- [ ] **Step 6: Typecheck (call sites now broken — expected)**

Run: `npm run typecheck`
Expected: FAIL — `:1928` (`result.length`), `:1946` (`observations`), and `:491-508` (Model-C) now mismatch `SurfaceLoopResult`. This is fixed in Tasks 8 and 9. Do NOT fix here.

- [ ] **Step 7: Commit (intermediate — note the known broken call sites)**

```bash
git add src/runtime/execution-handler.ts tests/unit/runtime/surface-loop-escalation.test.ts
git commit -m "feat(reasoning): runSurfaceAgentLoop returns SurfaceLoopResult + escalation chain (a-reasoning-02)

Call sites updated in follow-up commits (main + Model-C synthesis).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Main path — capture loopResult, stamp span attributes, synthesize with the loop engine

**Files:**
- Modify: `src/runtime/execution-handler.ts:1909-1949`

> The main path wraps `runSurfaceAgentLoop` in a `withSpan("execution.surface.loop", ...)` (`:1909-1931`), reads `result.length` (`:1928`), then `:1938` rebuilds a FRESH engine via `strategyRouter.build` and synthesizes with it (`:1945-1949`). After this task it captures the full `SurfaceLoopResult`, stamps the new span attributes, and synthesizes with `loopResult.engine`.

- [ ] **Step 1: Replace the loop-span + synthesis block** — in `src/runtime/execution-handler.ts`, replace this exact block (`:1909-1949`):

```typescript
        const observations = await withSpan(
          "execution.surface.loop",
          {
            "agent.name": agentDef.name,
            "reasoning.engine": agentDef.reasoning?.default,
          },
          async (loopSpan) => {
            const result = await runWithTimeout(
              runSurfaceAgentLoop(
                agentDef,
                input,
                agentContext,
                permittedTools,
                executeTool,
                traceCallback,
              ),
              config.harness.maxExecutionTimeMs / 2,
              `SurfaceAgent(${agentName})`,
            );
            loopSpan.setAttribute("reasoning.steps", result.length);
            return result;
          },
        );

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

with:

```typescript
        const loopResult = await withSpan(
          "execution.surface.loop",
          {
            "agent.name": agentDef.name,
            "reasoning.engine": agentDef.reasoning?.default,
          },
          async (loopSpan) => {
            const result = await runWithTimeout(
              runSurfaceAgentLoop(
                agentDef,
                input,
                agentContext,
                permittedTools,
                executeTool,
                traceCallback,
              ),
              config.harness.maxExecutionTimeMs / 2,
              `SurfaceAgent(${agentName})`,
            );
            // R02 (a-reasoning-02) — carimba o engine FINAL/escalado e a cadeia
            // no span do loop, não só o default do agent.
            loopSpan.setAttribute("reasoning.steps", result.observations.length);
            loopSpan.setAttribute("reasoning.final_strategy", result.engine.strategy);
            loopSpan.setAttribute("reasoning.escalated", result.escalated);
            loopSpan.setAttribute("reasoning.escalation_chain", result.escalationChain.join(">"));
            return result;
          },
        );
        const observations = loopResult.observations;

        // 11. Synthesize final response — agora bounded pelo deadline restante
        // (J8-b: fecha o buraco do synthesize não-bounded). reject-wrapper SEM
        // AbortController (chamada terminal única, sem step boundary): no
        // estouro o JOB é bounded, mas o fetch interno fica órfão até o
        // AbortSignal.timeout(30s) do adapter (risco §8.8 — NÃO é fix estrutural).
        // R02 — usa o engine ESCALADO do loop (não um rebuild do default), para
        // que `agentResponse.strategy`/`escalated` reflitam a realidade.
        const engine = loopResult.engine;
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

- [ ] **Step 2: Run the flow test to verify no regression**

Run: `npm run test:unit -- execution-handler.flow`
Expected: PASS — the flow test mocks `strategyRouter.build` to return stub engines used in the loop; `loopResult.engine` is that same stub (escalation config on those stubs does not wrap, so synthesize still calls the stub's `synthesize`). All flow cases stay green.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(reasoning): main synthesis uses escalated loop engine + stamps loop span (a-reasoning-02)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Model-C path — capture loopResult, synthesize with the loop engine

**Files:**
- Modify: `src/runtime/execution-handler.ts:491-508`

> The Model-C path (`:491-508`) calls `runSurfaceAgentLoop` with 5 args (no `traceCallback`), reads `observations`, then `:498` rebuilds a fresh engine for synthesis. It MUST get the same treatment or Model-C silently keeps the bug.

- [ ] **Step 1: Replace the Model-C loop + synthesis block** — in `src/runtime/execution-handler.ts`, replace this exact block (`:491-508`):

```typescript
    // 4 (continued). Run the normal doctrine-governed surface loop.
    const observations = await runWithTimeout(
      runSurfaceAgentLoop(agentDef, input, agentContext, permittedTools, executeTool),
      config.harness.maxExecutionTimeMs / 2,
      `ModelC-SurfaceAgent(${agentName})`,
    );

    // Synthesize final response
    const engine = strategyRouter.build(agentDef, agentContext);
    const finalPlan = {
      goal: input,
      steps: [{ index: 0, description: "model-c-surface-execution" }],
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
    // 4 (continued). Run the normal doctrine-governed surface loop.
    const loopResult = await runWithTimeout(
      runSurfaceAgentLoop(agentDef, input, agentContext, permittedTools, executeTool),
      config.harness.maxExecutionTimeMs / 2,
      `ModelC-SurfaceAgent(${agentName})`,
    );
    const observations = loopResult.observations;

    // Synthesize final response — R02: usa o engine ESCALADO do loop (não um
    // rebuild do default), idêntico ao main path, senão Model-C mantém o bug
    // de `strategy`/`escalated` sempre = default.
    const engine = loopResult.engine;
    const finalPlan = {
      goal: input,
      steps: [{ index: 0, description: "model-c-surface-execution" }],
      estimatedComplexity: "medium" as const,
    };
    const agentResponse: AgentResponse = await engine.synthesize(
      observations,
      finalPlan,
      agentContext,
    );
```

- [ ] **Step 2: Typecheck — should now be clean**

Run: `npm run typecheck`
Expected: exits 0 — both call sites consume `SurfaceLoopResult`; `strategyRouter` is still imported (used elsewhere), no unused-import error.

- [ ] **Step 3: Build + run the runtime + reasoning suites**

Run: `npm run build && npm run test:unit -- tests/unit/runtime tests/unit/reasoning`
Expected: PASS — build clean; surface-loop-escalation, flow, and all reasoning suites green.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "feat(reasoning): Model-C synthesis uses escalated loop engine (a-reasoning-02)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — R03 ReWOO parallel waves

> **Resolve OQ1 (R03 scope) with the founder before starting this phase.** If there is no real ReWOO use case for the pilot, DELETE the escalate-to-rewoo branch + `executeWaves` instead of wiring (the path is rare, never run in prod, and honors only ORDER not data-flow — OQ6). The tasks below assume WIRE was chosen.

### Task 8: Drive ReWOO via `executeWaves` on the escalate-to-rewoo branch

**Files:**
- Modify: `src/runtime/execution-handler.ts` (import + branch `:943-960`)
- Test: `tests/unit/runtime/surface-loop-rewoo.test.ts` (new)

> **Test setup note (reachability):** escalate-to-rewoo is NOT reachable from a pure ReAct agent (the ReAct plan is 1-step → Rule 2 never sees ≥2 independent steps). The deterministic way to exercise the branch is a stub agent whose `reasoning.default` is `plan-execute` (so the router builds `PlanExecuteEngine`, whose `plan()` produces a multi-step plan) with a planner that yields ≥2 independent branches → Rule 2 fires directly. Because the flow test mocks `strategyRouter.build` but this test calls the REAL `runSurfaceAgentLoop`, we exercise the real `PlanExecuteEngine` and real `ReWOOEngine` against a `FakeLlmClient`. We assert ORDER (dependent step runs in a later wave than its prerequisite), NOT data-flow (the dependent step's prompt does not consume prerequisite output — OQ6).

- [ ] **Step 1: Write the failing test** — create `tests/unit/runtime/surface-loop-rewoo.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

import { runSurfaceAgentLoop } from "../../../src/runtime/execution-handler.js";
import type { AgentDefinition } from "../../../src/agents/types.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { ToolExecutor } from "../../../src/reasoning/engine.js";
import { ExecutionAbortError } from "../../../src/runtime/errors.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";

function jsonResp(obj: unknown) {
  return { content: JSON.stringify(obj), model: "m", promptTokens: 1, completionTokens: 1 };
}

function makeLoopContext(
  llm: FakeLlmClient,
  extra: Partial<AgentExecutionContext> = {},
): AgentExecutionContext {
  return {
    executionId: "exec-rewoo-1",
    organizationId: "org-rewoo-1",
    conversationKey: "conv-1",
    db: {} as never,
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
    } as never,
    llmClient: llm,
    accountConfig: { llmModel: "fake-model" },
    systemPrompt: "DOCTRINE",
    ...extra,
  };
}

// plan-execute default → router builds PlanExecuteEngine (no reflexion wrap).
// parallelThreshold:2 so Rule 2 fires once the multi-step plan with >=2
// independent branches is in play, escalating to ReWOO.
const planExecAgent: AgentDefinition = {
  name: "rewoo-test-agent",
  type: "surface",
  description: "plan-execute that escalates to rewoo",
  reasoning: {
    default: "plan-execute",
    escalation: {
      stepThreshold: 99,
      escalateTo: "rewoo",
      parallelThreshold: 2,
      onFailure: "abort",
    },
  },
  permissions: { required: [], denied: [] },
};

// Plan with 0 and 1 independent, 2 depends on [0,1]. PlanExecuteEngine.plan
// and ReWOOEngine.plan both parse `steps` from the LLM JSON, so the same shape
// works for whichever engine re-plans. Provide enough responses for the
// PlanExecute initial plan + step + the ReWOO re-plan + 3 wave steps.
const depPlan = {
  steps: [
    { index: 0, description: "A", dependsOn: [] },
    { index: 1, description: "B", dependsOn: [] },
    { index: 2, description: "C", dependsOn: [0, 1] },
  ],
};

describe("runSurfaceAgentLoop — ReWOO via executeWaves (R03)", () => {
  it("escalate-to-rewoo runs executeWaves; dependent step runs AFTER prerequisites (ORDER)", async () => {
    const llm = new FakeLlmClient({
      defaultResponse: jsonResp({ thinking: "t", toolName: "noop", toolParams: {} }),
      responses: [
        jsonResp(depPlan), // PlanExecute initial plan → multi-step, >=2 independent
        jsonResp({ thinking: "t", toolName: "noop", toolParams: {} }), // first PlanExecute step
        jsonResp(depPlan), // ReWOO re-plan after escalation
        jsonResp({ toolName: "t0", toolParams: {} }), // wave 1 step 0
        jsonResp({ toolName: "t1", toolParams: {} }), // wave 1 step 1
        jsonResp({ toolName: "t2", toolParams: {} }), // wave 2 step 2
      ],
    });
    const callOrder: string[] = [];
    const tracer: ToolExecutor = async (name) => {
      callOrder.push(name);
      return { ok: name };
    };
    const result = await runSurfaceAgentLoop(planExecAgent, "goal", makeLoopContext(llm), [], tracer);
    expect(result.escalationChain).toContain("rewoo");
    expect(result.escalated).toBe(true);
    // t2 (depends on 0,1) must run after t0 AND t1 (ORDER, not data-flow)
    expect(callOrder.indexOf("t2")).toBeGreaterThan(callOrder.indexOf("t0"));
    expect(callOrder.indexOf("t2")).toBeGreaterThan(callOrder.indexOf("t1"));
  });

  it("J9 cost ceiling crossed before waves → ExecutionAbortError(cost_ceiling)", async () => {
    const llm = new FakeLlmClient({
      responses: [
        jsonResp(depPlan), // PlanExecute initial plan
        jsonResp({ thinking: "t", toolName: "noop", toolParams: {} }), // first step
      ],
    });
    const ctx = makeLoopContext(llm, {
      costCeilingCents: 10,
      costAccumulator: { costCents: 50 }, // already over ceiling
    });
    await expect(
      runSurfaceAgentLoop(planExecAgent, "goal", ctx, [], async () => ({ ok: true })),
    ).rejects.toBeInstanceOf(ExecutionAbortError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- surface-loop-rewoo`
Expected: FAIL — the first case fails because the current sequential drive runs ReWOO steps by ascending `stepIndex` (ignores `dependsOn`) and never calls `executeWaves`; depending on plan iteration `t2` may run before `t0`/`t1`, or the loop exhausts the LLM queue differently. (The point is the branch does not yet route through `executeWaves`.)

- [ ] **Step 3: Add the `CyclicDependencyError` import** — in `src/runtime/execution-handler.ts`, the ReWOO import is currently `import { ReWOOEngine } from "../reasoning/rewoo.js";` (`:36`). Replace it with:

```typescript
import { ReWOOEngine, CyclicDependencyError } from "../reasoning/rewoo.js";
```

- [ ] **Step 4: Rewrite the escalate-to-rewoo branch** — in `src/runtime/execution-handler.ts`, replace this exact block (the rewoo branch, `:943-960`, as it stands AFTER Task 5 added `escalationChain.push(engine.strategy);`):

```typescript
      } else if (decision.action === "escalate-to-rewoo") {
        engine = new ReWOOEngine();
        escalationChain.push(engine.strategy);
        if (agentContext.streamCallback) {
          try {
            await agentContext.streamCallback({
              type: "engine_strategy",
              payload: { from: fromStrategy, to: engine.strategy, reason: decision.action },
            });
          } catch {
            // best-effort
          }
        }
        const remainingInput = `${input}\n\nCompleted so far:\n${allObservations.map((o) => o.summary).join("\n")}`;
        plan = await engine.plan(remainingInput, agentContext);
        // Audit ref a-reasoning-04: see above — same reset on rewoo path.
        engine.reset?.();
        stepIndex = 0;
        continue;
      }
```

with:

```typescript
      } else if (decision.action === "escalate-to-rewoo") {
        // R03 (a-reasoning-03) — dirige ReWOO pelo path PARALELO real
        // (executeWaves), honrando a ORDEM de dependsOn (NÃO fluxo de dados
        // entre steps — OQ6), em vez do loop sequencial genérico que ignora
        // dependsOn. As waves rodam o plano inteiro de uma vez → break.
        const rewoo = new ReWOOEngine();
        engine = rewoo;
        escalationChain.push(engine.strategy);
        if (agentContext.streamCallback) {
          try {
            await agentContext.streamCallback({
              type: "engine_strategy",
              payload: { from: fromStrategy, to: engine.strategy, reason: decision.action },
            });
          } catch {
            // best-effort
          }
        }
        const remainingInput = `${input}\n\nCompleted so far:\n${allObservations.map((o) => o.summary).join("\n")}`;

        // J8 — gate de deadline ANTES de disparar waves (paralelo é caro).
        if (agentContext.deadlineMs != null && Date.now() >= agentContext.deadlineMs) {
          throw new ExecutionAbortError(
            "wall_clock_timeout",
            `Execution exceeded wall-clock deadline before ReWOO waves (deadline=${agentContext.deadlineMs}, now=${Date.now()})`,
            /* retryable */ false,
          );
        }
        // J9 — teto de custo ANTES das waves.
        if (
          agentContext.costCeilingCents != null &&
          (agentContext.costAccumulator?.costCents ?? 0) >= agentContext.costCeilingCents
        ) {
          throw new ExecutionAbortError(
            "cost_ceiling",
            `Cost ceiling reached before ReWOO waves: ${agentContext.costAccumulator?.costCents}c >= ${agentContext.costCeilingCents}c`,
            /* retryable */ false,
          );
        }

        try {
          plan = await rewoo.plan(remainingInput, agentContext);
        } catch (err) {
          if (err instanceof CyclicDependencyError) {
            // Plano cíclico é determinístico → abort não-retryable (re-rodar só
            // re-gera o mesmo ciclo). OQ4: fallback sequencial fica fora do piloto.
            throw new ExecutionAbortError("invalid_plan", err.message, /* retryable */ false);
          }
          throw err;
        }

        const waveObs = await withSpan(
          "reasoning.rewoo.waves",
          {
            "engine.type": engine.strategy,
            "plan.length": plan.steps?.length,
            "execution.id": agentContext.executionId,
          },
          async () => rewoo.executeWaves(plan, tools, agentContext, executeTool, traceCallback),
        );
        allObservations.push(...waveObs);

        // J9 — re-check pós-waves (waves podem ter cruzado o teto).
        if (
          agentContext.costCeilingCents != null &&
          (agentContext.costAccumulator?.costCents ?? 0) >= agentContext.costCeilingCents
        ) {
          throw new ExecutionAbortError(
            "cost_ceiling",
            `Cost ceiling reached after ReWOO waves: ${agentContext.costAccumulator?.costCents}c >= ${agentContext.costCeilingCents}c`,
            /* retryable */ false,
          );
        }
        break; // ReWOO roda o plano inteiro de uma vez → run completa.
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:unit -- surface-loop-rewoo`
Expected: PASS — `escalationChain` contains `"rewoo"`, `t2` runs after `t0`/`t1` (ORDER honored), and the J9 case rejects with `ExecutionAbortError`.

- [ ] **Step 6: Run the reusable executeWaves coverage + reasoning suite**

Run: `npm run test:unit -- tests/unit/reasoning/rewoo tests/unit/runtime/surface-loop`
Expected: PASS — the existing `rewoo.test.ts` executeWaves cases (parallel/deps/chunk/stop) stay green; both new runtime loop suites green.

- [ ] **Step 7: Build + runtime suite regression**

Run: `npm run build && npm run test:unit -- tests/unit/runtime`
Expected: PASS — build clean; `execution-handler.flow` and all runtime suites green.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/execution-handler.ts tests/unit/runtime/surface-loop-rewoo.test.ts
git commit -m "feat(reasoning): drive ReWOO via executeWaves on escalate-to-rewoo branch (a-reasoning-03)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Final gate — full unit suite + build

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 2: Full unit suite**

Run: `npm run test:unit`
Expected: PASS — entire `tests/unit` suite green (reasoning + runtime + tools + everything else). NEVER run with `RUN_INTEGRATION`.

- [ ] **Step 3: Confirm the OQ2 `escalated` default is correct (decision gate)**

This plan ships `escalated = escalationChain.length > 1` (`runSurfaceAgentLoop` return). If the `/complete` contract owner instead wants `escalated` to mean "switched literal strategy" (so reflexion-only runs report `escalated: false`), make this one-line change in `runSurfaceAgentLoop`'s return:

```typescript
    escalated: engine.strategy !== (agent.reasoning?.default ?? engine.strategy),
```

and update the `surface-loop-escalation` reflexion case to expect `escalated: false`. Do NOT make this change unless the owner confirms; the default ships as documented.

- [ ] **Step 4: Mark audit findings resolved** — update the audit doc to mark `a-reasoning-01`, `a-reasoning-02`, and (if Phase 3 was wired) `a-reasoning-03` as resolved. If Phase 3 was DELETED per OQ1, mark `a-reasoning-03` as "resolved by removal" and note the executeWaves deletion. (No code step — documentation update in the audit tracker.)

---

## Self-Review

**Spec coverage:**
- §4.1 R01 — Change 1 (`reflexionNotes` field) → Task 1; Change 2 (`augmentContext` cast) → Task 2; Change 3 (`react.ts` doctrine reader) → Task 3. Test points (a) retry receives note via real ReactEngine, (b) first-attempt success → zero reflexion, (c) no-mutation (pre-existing), (d) no-notes byte-identical → Task 3 Steps 1+5. **Covered.**
- §4.2 R02 — `SurfaceLoopResult` + chain → Task 5; wrap-reflexion guard + emit + dedup (the corrected NB double-wrap form) → Task 5 Step 4; main synthesis + span attrs → Task 6; Model-C synthesis → Task 7. `escalated` semantics decision (OQ2) → Task 9 Step 3. **Covered.**
- §4.3 R03 — escalate-to-rewoo via `executeWaves` + J8/J9 gates + `CyclicDependencyError` capture + `break` → Task 8; ORDER-not-data-flow assertion (OQ6) called out in the test note; scope decision (OQ1) gated before Phase 3. **Covered.**
- §5 implementation order (R01→R02→R03), §6 testing strategy (FakeLlmClient, real engines, `tests/**` only), §7 migration/rollback (each phase independently revertible), §9 DoD checklist → all reflected in phase structure + gates. **Covered.**

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step contains complete, paste-ready code. The OQ2 alternate (Task 9 Step 3) is a concrete one-line diff, not a placeholder.

**Type consistency:** `SurfaceLoopResult { observations, engine, escalated, escalationChain }` is defined once (Task 5) and consumed with the same property names in Tasks 6 (`loopResult.observations`/`.engine`/`.escalated`/`.escalationChain`) and 7 (`loopResult.observations`/`.engine`). `reflexionNotes?: string[]` defined in Task 1, read in Task 3 (`context.reflexionNotes`), written in Task 2 (`context.reflexionNotes`). `escalationChain.push(engine.strategy)` added to plan-execute (Task 5) and rewoo (Task 5, then the rewoo branch is fully rewritten in Task 8 retaining the push). `ExecutionAbortError(reason, message, retryable)` matches the verified 3-arg constructor (`reason: AbortReason`, `message`, `retryable`). `executeWaves(plan, tools, context, executeTool, traceCallback)` matches `rewoo.ts:280-286`. `CyclicDependencyError` imported from `../reasoning/rewoo.js` (verified export at `rewoo.ts:430`).

**Corrected stale spec line refs (verified against live code):** `react.ts` doctrine line is `:104` (step `:70-164`); `react.ts:synthesize` is ALREADY the `data.*`-fixed version from the mutation-tool plan and is explicitly NOT touched; `execution-context.ts` insert point is after `originalExecutionId` (`:128`); `CyclicDependencyError` was NOT yet imported in `execution-handler.ts` (Task 8 adds it). The wrap-reflexion branch at `:921-922` had NO `escalationChain` (introduced fresh in R02). Both `runSurfaceAgentLoop` call sites (main `:1917`, Model-C `:492`) and span attr site (`:1928`) confirmed.
