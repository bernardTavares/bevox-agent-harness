# Tools/Skills Canonical Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two parallel tool stores (`ToolRegistry` + `SkillRegistry`) into one canonical `UnifiedToolRegistry` backed by `skills-builtin/*` manifests, make `manifest.yaml` the single source of metadata, eliminate double-registration in bootstrap, and delete the 13 legacy `.tool.ts` wrappers — all while preserving 100% of runtime behavior (ADR-006 `executeOrPropose`, ADR-023 idempotency-key).

**Architecture:** A single `UnifiedToolRegistry` stores `LoadedSkill` (manifest is the metadata source) and exposes BOTH views: `LoadedSkill[]` (for `mcp/server.ts`) and `ToolDefinition[]` (derived via `skillToToolDefinition`, for the executor hot path). Each built-in skill becomes self-contained — read/stop tools move their `execute` body into the skill `index.ts`; mutation tools use a new metadata-free `mutationExecute(mutation)` helper so the `executeOrPropose` closure survives. We relocate logic FIRST (Phase 0), build the registry (Phase 1), migrate consumers + test reset hacks (Phase 2), then delete legacy (Phase 3), then docs (Phase 4). Never delete before migrating.

**Tech Stack:** Node.js 20 / TypeScript 5.9 (ESM/NodeNext — all relative imports end in `.js`), Vitest 4 (`npm test` = `vitest run`), `npm run build` = `tsc && node scripts/copy-skill-manifests.mjs`, Zod 4, Pino 9.

---

## Branch & coordination

- **Branch:** `mutation-stack` (or a branch stacked on it). This is **Track B, Plan 2 of 2** and runs AFTER the "mutation tool rollout + idempotency" plan (`docs/superpowers/plans/2026-06-02-mutation-tool-rollout-idempotency-plan.md`) on the **same worktree/branch**.
- **Assumed starting state (prior plan ALREADY LANDED):**
  - ALL 5 mutation tools (`create-appointment`, `cancel-appointment`, `reschedule-appointment`, `waitlist-add`, `send-message`) have a `.mutation.ts` business-logic file (a `MutationTool` subclass) PLUS a thin `.tool.ts` wrapper built via `wrapMutationTool(<mutation>, <meta>)`.
  - `src/tools/_shared/mutation-tool.ts` has the hardened base: typed `MutationPreconditionError` (now exported from `mutation-tool.ts`, not from `create-appointment.mutation.ts`) and a content-derived sha256 `deriveIdempotencyKey(context, params)`.
  - This plan **PRESERVES** all `.mutation.ts` files and `mutation-tool.ts` (it only ADDS the `mutationExecute()` helper). It DELETES the thin `.tool.ts` wrappers and the two legacy registries.
- **Cross-track shared file:** The ONLY file also touched by the context-builder track is `src/runtime/execution-handler.ts`. This plan changes only the **registry import + `getInstance()` lines** (`:48`, `:253`, `:585`, `:896`) — a different region from the context-wiring track. Worst case: a small textual merge on the import block. No semantic conflict.
- **Atomicity requirement (encoded in Phase 2):** bootstrap stage 5 (`load-tools-permissions`) and the MCP stage (`load-mcp-clients`) must convert to `UnifiedToolRegistry` in the **same commit** — if only one converts, the other references a deleted class and breaks the bootstrap.

## Design decisions locked here (resolving spec open questions)

- **Import compat (spec §4.2 A vs B):** Adopt **(A)** — migrate the real consumer imports to `UnifiedToolRegistry`, then delete `registry.ts`/`skill-registry.ts`. No magic alias.
- **`getAllTools()` alias (spec §8 Q2):** DROP it. The one caller (bootstrap stage-5 log) switches to `all()`.
- **`listByCategory()` / `resolveOrThrow()` / `listByAgentType()` (spec §4.1, §8 Q1):** DROP `listByCategory()` (no caller). KEEP `resolveOrThrow()` (cheap, used by the new registry test, plausible callers). Do NOT add speculative `listByAgentType()`.
- **Test registration ergonomics (gap not in spec):** Tests register bare `ToolDefinition` objects via `toolRegistry.register(tool)` (e.g. `fakeQualifyTool` in `qualify-framework-wiring.test.ts`). The new primary `register()` takes a `LoadedSkill`. So `UnifiedToolRegistry` gains a `registerToolDefinition(tool: ToolDefinition)` convenience that wraps a `ToolDefinition` into a synthetic `LoadedSkill`. Tests migrate `register(toolDef)` → `registerToolDefinition(toolDef)`.

## File structure (what gets created / modified / deleted)

**Created:**
- `src/tools/unified-registry.ts` — the single canonical registry + `skillToToolDefinition` (moved here in Phase 3).
- `tests/unit/tools/mutation-proposal.test.ts` — Phase 0 regression guard for all 5 mutation tools.
- `tests/unit/tools/unified-registry.test.ts` — Phase 1 unit tests.
- `tests/unit/bootstrap/stage5.test.ts` — Phase 2 bootstrap behavior test.
- `src/skills-builtin/calendar/read-calendar/read-calendar.impl.ts` (+ list-appointments, search-faq, read-profile, write-profile, write-fact, request-human impl files) — relocated read/stop `execute` bodies.

**Modified:**
- `src/tools/_shared/mutation-tool.ts` — ADD `mutationExecute()`. Keep everything else.
- 12 `src/skills-builtin/**/index.ts` — become self-contained.
- `src/runtime/execution-handler.ts` — registry import + 2 `getInstance()` + field type.
- `src/runtime/harness.ts` — import + field type + default `getInstance()`.
- `src/bootstrap/stages.ts` — stage 5 + MCP stage + start-consumer.
- `src/mcp/server.ts`, `src/mcp/bootstrap.ts`, `src/mcp/adapters/permission-filter.ts` — `SkillRegistry`/`skillToToolDefinition` → `UnifiedToolRegistry`.
- 9 test files — swap import + reset hack + `register` calls.
- Docs (Phase 4): `CLAUDE.md`, `.claude/rules/harness-tools.md`, `.claude/rules/harness-payload.md`, `src/skills-builtin/README.md`.

**Deleted (Phase 3):**
- `src/tools/registry.ts`, `src/skills/skill-registry.ts`.
- 13 `src/tools/<cat>/<name>.tool.ts` (the 5 mutation wrappers + 8 read/stop tools — see Risk note; spec counts "12" but the tree has `create-appointment.tool.ts` + 4 other mutation wrappers + 7 read/stop = 12 distinct tool names; the prior plan adds `send-message.mutation.ts` and keeps its `.tool.ts` wrapper, so the wrapper count to delete = 12).
- `registerAllTools()` + `.tool.ts` imports/re-exports in `src/tools/index.ts`. Remove `wrapMutationTool` only if no skill imports it anymore.

---

## Phase 0 — Relocate `execute` into skills + preserve `executeOrPropose`

> Goal: make every built-in skill self-contained; manifest becomes the single metadata source. NO `.tool.ts` deleted yet, bootstrap unchanged. The `mutation-proposal.test.ts` suite is the non-negotiable guard-rail for the ADR-006 invariant.

### Task 0.1: Add `mutationExecute()` helper to `mutation-tool.ts`

**Files:**
- Modify: `src/tools/_shared/mutation-tool.ts`
- Test: `tests/unit/tools/mutation-proposal.test.ts` (Task 0.2)

- [ ] **Step 1: Add the helper** (append after `wrapMutationTool`, before `extractProposal`, in `src/tools/_shared/mutation-tool.ts`)

```typescript
/**
 * Produces ONLY the `execute` closure (AgentExecutionContext → ToolDefResult)
 * for a MutationTool — identical body to `wrapMutationTool`'s `execute`, but
 * WITHOUT requiring duplicated metadata. The skill `index.ts` supplies this as
 * `export default { execute: mutationExecute(<mutation>) }`; description /
 * category / agentType / parameters now live ONLY in the skill `manifest.yaml`.
 *
 * Behavior preserved (ADR-006 / EM-03, tested in mutation-proposal.test.ts):
 *   - executionMode `autonomous_supervised` (or undefined) → real effect,
 *     returns `{ success: true, data: <result> }`.
 *   - `manual_assisted` / `copilot` → `{ success: true, data: { proposal } }`
 *     with NO side effect.
 *   - failure → `{ success: false, error: code, detail: message }`.
 */
export function mutationExecute<P, R>(
  mutation: MutationTool<P, R>,
): (params: unknown, context: AgentExecutionContext) => Promise<ToolDefResult> {
  return async (rawParams: unknown, context: AgentExecutionContext): Promise<ToolDefResult> => {
    const params = rawParams as P;
    const mode: ExecutionMode = context.executionMode ?? "autonomous_supervised";
    const toolContext: ToolContext = {
      execution_id: context.executionId,
      organization_id: context.organizationId,
      step_index: context.stepIndex,
      execution_mode: mode,
    };
    const outcome = await mutation.executeOrPropose(params, toolContext, mode);
    if (outcome.ok === false) {
      return { success: false, error: outcome.error.code, detail: outcome.error.message };
    }
    if ("proposal" in outcome) {
      return { success: true, data: { proposal: outcome.proposal } };
    }
    return { success: true, data: outcome.result };
  };
}
```

> NOTE on `context.stepIndex`: confirm the field name on `AgentExecutionContext` before running. If the context exposes the step index under a different name (e.g. `roundIndex`) or not at all, set `step_index` accordingly (omit the line if absent — the base `deriveIdempotencyKey` defaults `step` to `0`). `wrapMutationTool` today does NOT pass `step_index`; to keep behavior bit-for-bit identical with the legacy wrapper, you MAY omit `step_index` here too. Decide based on the prior plan's hardened `deriveIdempotencyKey(context, params)` signature — if it derives the key from `params` content, `step_index` is moot. Keep this helper's `toolContext` shape identical to whatever `wrapMutationTool` builds in the landed code.

- [ ] **Step 2: Run the build to confirm types compile**

Run: `npm run build`
Expected: PASS (no type errors). If `stepIndex` is not a field on `AgentExecutionContext`, remove that line and rebuild.

- [ ] **Step 3: Commit**

```bash
git add src/tools/_shared/mutation-tool.ts
git commit -m "feat(tools): add metadata-free mutationExecute() helper (SKILLS-05 Phase 0)"
```

### Task 0.2: Regression test for all 5 mutation tools (autonomous vs draft vs idempotency)

**Files:**
- Create: `tests/unit/tools/mutation-proposal.test.ts`

This suite asserts the §4.3 invariant against the CURRENT `.tool.ts` wrappers FIRST (they re-export the same closure), so it stays green through the Phase 0 skill rewrite. It mocks the calendar client / backend so we can assert "no effect" in draft modes.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";

// Mock the calendar client BEFORE importing the mutations under test.
vi.mock("../../../src/integration/calendar-client.js", () => ({
  createAppointment: vi.fn(async () => ({ id: "apt-1" })),
  cancelAppointment: vi.fn(async () => ({ id: "apt-1", status: "cancelled" })),
  rescheduleAppointment: vi.fn(async () => ({ id: "apt-1", status: "scheduled" })),
  addToWaitlist: vi.fn(async () => ({ id: "wl-1" })),
}));
// Rate limiter never denies in this suite.
vi.mock("../../../src/tools/_shared/rate-limit.js", () => ({
  checkRateLimit: vi.fn(async () => undefined),
}));

import * as calendarClient from "../../../src/integration/calendar-client.js";
import { mutationExecute } from "../../../src/tools/_shared/mutation-tool.js";
import { createAppointmentMutation } from "../../../src/tools/calendar/create-appointment.mutation.js";
import { cancelAppointmentMutation } from "../../../src/tools/calendar/cancel-appointment.mutation.js";
import { rescheduleAppointmentMutation } from "../../../src/tools/calendar/reschedule-appointment.mutation.js";
import { waitlistAddMutation } from "../../../src/tools/calendar/waitlist-add.mutation.js";
import { sendMessageMutation } from "../../../src/tools/messaging/send-message.mutation.js";

function ctx(mode: AgentExecutionContext["executionMode"]): AgentExecutionContext {
  return {
    executionId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    organizationId: "018f0000-0000-7000-8000-000000000000",
    executionMode: mode,
  } as unknown as AgentExecutionContext;
}

const cases = [
  {
    name: "create-appointment",
    mutation: createAppointmentMutation,
    params: {
      calendar_id: "cal-1",
      service_id: "svc-1",
      customer_name: "Ada",
      date: "2026-06-10",
      start_time: "09:00",
    },
    backendFn: () => calendarClient.createAppointment as ReturnType<typeof vi.fn>,
  },
  {
    name: "cancel-appointment",
    mutation: cancelAppointmentMutation,
    params: { appointment_id: "apt-1", reason: "client request" },
    backendFn: () => calendarClient.cancelAppointment as ReturnType<typeof vi.fn>,
  },
  {
    name: "reschedule-appointment",
    mutation: rescheduleAppointmentMutation,
    params: { appointment_id: "apt-1", new_date: "2026-06-11", new_start_time: "10:00" },
    backendFn: () => calendarClient.rescheduleAppointment as ReturnType<typeof vi.fn>,
  },
  {
    name: "waitlist-add",
    mutation: waitlistAddMutation,
    params: { calendar_id: "cal-1", customer_name: "Ada" },
    backendFn: () => calendarClient.addToWaitlist as ReturnType<typeof vi.fn>,
  },
] as const;

describe("mutation tools — ADR-006 executeOrPropose invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const c of cases) {
    describe(c.name, () => {
      it("autonomous_supervised → real effect (backend called)", async () => {
        const exec = mutationExecute(c.mutation);
        const res = await exec(c.params, ctx("autonomous_supervised"));
        expect(res.success).toBe(true);
        expect((res.data as { proposal?: unknown }).proposal).toBeUndefined();
        expect(c.backendFn()).toHaveBeenCalledTimes(1);
      });

      it("manual_assisted → proposal, NO backend call", async () => {
        const exec = mutationExecute(c.mutation);
        const res = await exec(c.params, ctx("manual_assisted"));
        expect(res.success).toBe(true);
        const proposal = (res.data as { proposal?: { action: string; params: unknown } }).proposal;
        expect(proposal).toBeDefined();
        expect(proposal!.action).toBe(c.mutation.action);
        expect(c.backendFn()).not.toHaveBeenCalled();
      });

      it("copilot → proposal, NO backend call", async () => {
        const exec = mutationExecute(c.mutation);
        const res = await exec(c.params, ctx("copilot"));
        expect(res.success).toBe(true);
        expect((res.data as { proposal?: unknown }).proposal).toBeDefined();
        expect(c.backendFn()).not.toHaveBeenCalled();
      });
    });
  }

  describe("send-message", () => {
    it("autonomous_supervised → real effect (sent)", async () => {
      const exec = mutationExecute(sendMessageMutation);
      const res = await exec({ message: "hi" }, ctx("autonomous_supervised"));
      expect(res.success).toBe(true);
      expect((res.data as { proposal?: unknown }).proposal).toBeUndefined();
    });

    it("manual_assisted → proposal, no send", async () => {
      const exec = mutationExecute(sendMessageMutation);
      const res = await exec({ message: "hi" }, ctx("manual_assisted"));
      const proposal = (res.data as { proposal?: { action: string } }).proposal;
      expect(proposal).toBeDefined();
      expect(proposal!.action).toBe(sendMessageMutation.action);
    });
  });

  it("idempotency-key follows the canonical ADR-023 formula", () => {
    // Static helper is deterministic: same execution_id + step + name → same key.
    const { MutationTool } = require("../../../src/tools/_shared/mutation-tool.js");
    const key = MutationTool.deriveIdempotencyKey(
      { execution_id: "exec-9", organization_id: "org", step_index: 3 },
      "create-appointment",
    );
    expect(key).toBe("harness:exec-9:3:create-appointment");
  });
});
```

> NOTE: The exact `*.mutation.ts` export names (`cancelAppointmentMutation`, `rescheduleAppointmentMutation`, `waitlistAddMutation`, `sendMessageMutation`) come from the prior plan. Before running, confirm those export names match the landed `.mutation.ts` files; adjust the imports if the prior plan used different casing. `createAppointmentMutation` is verified to exist at `src/tools/calendar/create-appointment.mutation.ts:115`. If the prior plan's hardened `deriveIdempotencyKey(context, params)` changed the formula (e.g. sha256 over params), replace the last `it(...)` block's expectation with the landed formula and assert determinism (call twice, expect equal) instead of the literal string.

- [ ] **Step 2: Run test to verify it passes against current `.tool.ts`-backed mutations**

Run: `npm test -- tests/unit/tools/mutation-proposal.test.ts`
Expected: PASS — the closures already behave this way today (`wrapMutationTool` produces the same outcome `mutationExecute` does).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/tools/mutation-proposal.test.ts
git commit -m "test(tools): ADR-006 proposal regression guard for 5 mutation tools (SKILLS-05 Phase 0)"
```

### Task 0.3: Make the 5 mutation skill `index.ts` files self-contained

**Files:**
- Modify: `src/skills-builtin/calendar/create-appointment/index.ts`
- Modify: `src/skills-builtin/calendar/cancel-appointment/index.ts`
- Modify: `src/skills-builtin/calendar/reschedule-appointment/index.ts`
- Modify: `src/skills-builtin/calendar/waitlist-add/index.ts`
- Modify: `src/skills-builtin/messaging/send-message/index.ts`

- [ ] **Step 1: Rewrite `create-appointment/index.ts`**

```typescript
import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { createAppointmentMutation } from "../../../tools/calendar/create-appointment.mutation.js";

export default {
  execute: mutationExecute(createAppointmentMutation),
};
```

- [ ] **Step 2: Rewrite `cancel-appointment/index.ts`**

```typescript
import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { cancelAppointmentMutation } from "../../../tools/calendar/cancel-appointment.mutation.js";

export default {
  execute: mutationExecute(cancelAppointmentMutation),
};
```

- [ ] **Step 3: Rewrite `reschedule-appointment/index.ts`**

```typescript
import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { rescheduleAppointmentMutation } from "../../../tools/calendar/reschedule-appointment.mutation.js";

export default {
  execute: mutationExecute(rescheduleAppointmentMutation),
};
```

- [ ] **Step 4: Rewrite `waitlist-add/index.ts`**

```typescript
import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { waitlistAddMutation } from "../../../tools/calendar/waitlist-add.mutation.js";

export default {
  execute: mutationExecute(waitlistAddMutation),
};
```

- [ ] **Step 5: Rewrite `send-message/index.ts`**

```typescript
import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { sendMessageMutation } from "../../../tools/messaging/send-message.mutation.js";

export default {
  execute: mutationExecute(sendMessageMutation),
};
```

> NOTE: These now import `*.mutation.ts` (preserved) directly, NOT `*.tool.ts` (to be deleted in Phase 3). Adjust export names if the prior plan differs.

- [ ] **Step 6: Run the build + mutation regression suite**

Run: `npm run build && npm test -- tests/unit/tools/mutation-proposal.test.ts`
Expected: PASS — skills now use `mutationExecute`; behavior identical.

- [ ] **Step 7: Commit**

```bash
git add src/skills-builtin/calendar/create-appointment/index.ts \
  src/skills-builtin/calendar/cancel-appointment/index.ts \
  src/skills-builtin/calendar/reschedule-appointment/index.ts \
  src/skills-builtin/calendar/waitlist-add/index.ts \
  src/skills-builtin/messaging/send-message/index.ts
git commit -m "refactor(skills): 5 mutation skills self-contained via mutationExecute (SKILLS-05 Phase 0)"
```

### Task 0.4: Relocate `read-calendar` execute body into the skill

**Files:**
- Create: `src/skills-builtin/calendar/read-calendar/read-calendar.impl.ts`
- Modify: `src/skills-builtin/calendar/read-calendar/index.ts`

- [ ] **Step 1: Create the impl file** (move the body out of `src/tools/calendar/read-calendar.tool.ts`, dropping the metadata — manifest owns it now)

```typescript
import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import * as calendarClient from "../../../integration/calendar-client.js";
import type { ToolResult } from "../../../tools/types.js";

interface ReadCalendarParams {
  calendar_id: string;
  date: string;
  service_id?: string;
  member_id?: string;
}

export async function execute(
  params: unknown,
  _context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as ReadCalendarParams;
  if (!p.calendar_id || !p.date) {
    return { success: false, error: "INVALID_PARAMS", detail: "calendar_id and date are required" };
  }
  try {
    const data = await calendarClient.getAvailability(p.calendar_id, p.date, p.service_id);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: "CALENDAR_SERVICE_ERROR", detail: String(err) };
  }
}
```

- [ ] **Step 2: Rewrite the skill `index.ts`**

```typescript
import { execute } from "./read-calendar.impl.js";

export default { execute };
```

- [ ] **Step 3: Build to confirm import path resolves**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/skills-builtin/calendar/read-calendar/
git commit -m "refactor(skills): relocate read-calendar logic into skill (SKILLS-05 Phase 0)"
```

### Task 0.5: Relocate `list-appointments` execute body into the skill

**Files:**
- Create: `src/skills-builtin/calendar/list-appointments/list-appointments.impl.ts`
- Modify: `src/skills-builtin/calendar/list-appointments/index.ts`

- [ ] **Step 1: Create the impl file**

```typescript
import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import * as calendarClient from "../../../integration/calendar-client.js";
import type { ToolResult } from "../../../tools/types.js";

interface ListAppointmentsParams {
  calendar_id: string;
  date_from: string;
  date_to: string;
  status?: string;
}

export async function execute(
  params: unknown,
  _context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as ListAppointmentsParams;
  if (!p.calendar_id || !p.date_from || !p.date_to) {
    return {
      success: false,
      error: "INVALID_PARAMS",
      detail: "calendar_id, date_from, and date_to are required",
    };
  }
  try {
    const data = await calendarClient.listAppointments(p.calendar_id, p.date_from, p.date_to);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: "CALENDAR_SERVICE_ERROR", detail: String(err) };
  }
}
```

- [ ] **Step 2: Rewrite the skill `index.ts`**

```typescript
import { execute } from "./list-appointments.impl.js";

export default { execute };
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/skills-builtin/calendar/list-appointments/
git commit -m "refactor(skills): relocate list-appointments logic into skill (SKILLS-05 Phase 0)"
```

### Task 0.6: Relocate `search-faq` execute body into the skill

**Files:**
- Create: `src/skills-builtin/knowledge/search-faq/search-faq.impl.ts`
- Modify: `src/skills-builtin/knowledge/search-faq/index.ts`

- [ ] **Step 1: Create the impl file** (copy the full body from `src/tools/knowledge/search-faq.tool.ts`, keeping `SEARCH_FAQ_SCHEMA_VERSION`)

```typescript
import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { getRetriever } from "../../../rag/registry.js";
import type { ToolResult } from "../../../tools/types.js";

interface SearchFaqParams {
  query: string;
  limit?: number;
  minScore?: number;
}

export const SEARCH_FAQ_SCHEMA_VERSION = 2 as const;

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as SearchFaqParams;
  if (!p.query) {
    return { success: false, error: "INVALID_PARAMS", detail: "query is required" };
  }
  const limit = Math.min(Math.max(p.limit ?? 5, 1), 20);
  const minScore = p.minScore ?? 0.5;

  const retriever = getRetriever();
  if (!retriever) {
    return {
      success: true,
      data: { schema_version: SEARCH_FAQ_SCHEMA_VERSION, degraded: true, results: [] },
    };
  }

  try {
    const chunks = await retriever.retrieve({
      query: p.query,
      organizationId: context.organizationId,
      source: "faq",
      topK: limit,
      minScore,
    });
    const results = chunks.map((c) => ({
      id: c.chunkId,
      chunkId: c.chunkId,
      documentId: c.documentId,
      content: c.content,
      title: c.title,
      score: c.score,
    }));
    return {
      success: true,
      data: { schema_version: SEARCH_FAQ_SCHEMA_VERSION, degraded: false, results },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes("does not exist") ||
      errMsg.includes('relation "rag_chunks"') ||
      errMsg.includes('type "vector"')
    ) {
      context.logger.warn(
        { err: errMsg },
        "search-faq: RAG schema not applied — returning degraded",
      );
      return {
        success: true,
        data: { schema_version: SEARCH_FAQ_SCHEMA_VERSION, degraded: true, results: [] },
      };
    }
    return { success: false, error: "RAG_FAILURE", detail: errMsg };
  }
}
```

- [ ] **Step 2: Rewrite the skill `index.ts`**

```typescript
import { execute } from "./search-faq.impl.js";

export default { execute };
```

- [ ] **Step 3: Check for other importers of `SEARCH_FAQ_SCHEMA_VERSION`**

Run: `grep -rn "SEARCH_FAQ_SCHEMA_VERSION" src/ tests/`
Expected: any importer currently points at `tools/knowledge/search-faq.tool.js`. If a test imports it, repoint that import to `../../../src/skills-builtin/knowledge/search-faq/search-faq.impl.js` in the same commit (note it for Phase 3 deletion safety).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills-builtin/knowledge/search-faq/
git commit -m "refactor(skills): relocate search-faq logic into skill (SKILLS-05 Phase 0)"
```

### Task 0.7: Relocate `read-profile` execute body into the skill

**Files:**
- Create: `src/skills-builtin/memory/read-profile/read-profile.impl.ts`
- Modify: `src/skills-builtin/memory/read-profile/index.ts`

- [ ] **Step 1: Create the impl file**

```typescript
import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { ContactFactsRepository } from "../../../memory/contact-facts.repository.js";
import { ContactProfileRepository } from "../../../memory/contact-profile.repository.js";
import type { ToolResult } from "../../../tools/types.js";

interface ReadProfileParams {
  contact_id: number;
}

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as ReadProfileParams;
  if (p.contact_id == null) {
    return { success: false, error: "INVALID_PARAMS", detail: "contact_id is required" };
  }
  try {
    const profileRepo = new ContactProfileRepository(context.db);
    const factsRepo = new ContactFactsRepository(context.db);
    const contactId = BigInt(p.contact_id);
    const [profile, facts] = await Promise.all([
      profileRepo.findByContact(context.organizationId, contactId),
      factsRepo.listActive(context.organizationId, contactId),
    ]);
    return { success: true, data: { profile, facts } };
  } catch (err) {
    return { success: false, error: "EXTERNAL_ERROR", detail: String(err) };
  }
}
```

- [ ] **Step 2: Rewrite the skill `index.ts`**

```typescript
import { execute } from "./read-profile.impl.js";

export default { execute };
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/skills-builtin/memory/read-profile/
git commit -m "refactor(skills): relocate read-profile logic into skill (SKILLS-05 Phase 0)"
```

### Task 0.8: Relocate `write-profile` execute body into the skill

**Files:**
- Create: `src/skills-builtin/memory/write-profile/write-profile.impl.ts`
- Modify: `src/skills-builtin/memory/write-profile/index.ts`

- [ ] **Step 1: Create the impl file**

```typescript
import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { ContactProfileRepository } from "../../../memory/contact-profile.repository.js";
import type { ToolResult } from "../../../tools/types.js";

interface WriteProfileParams {
  contact_id: number;
  fields: Record<string, unknown>;
}

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as WriteProfileParams;
  if (p.contact_id == null || !p.fields) {
    return { success: false, error: "INVALID_PARAMS", detail: "contact_id and fields are required" };
  }
  try {
    const profileRepo = new ContactProfileRepository(context.db);
    const contactId = BigInt(p.contact_id);
    await profileRepo.update(context.organizationId, contactId, p.fields);
    return { success: true, data: { updated: true } };
  } catch (err) {
    return { success: false, error: "EXTERNAL_ERROR", detail: String(err) };
  }
}
```

> NOTE: `write-profile` and `write-fact` are pipeline-only memory tools (`agentType: pipeline`). They are NOT mutation tools in the ADR-006 sense (no `executeOrPropose` / proposal path — they write contact DB rows, not external bookings). Relocate them as plain read/stop-style impls, NOT via `mutationExecute`. This matches the spec Phase 0 list (it groups `write-profile`/`write-fact` under "read/stop", not under the 5 mutation tools).

- [ ] **Step 2: Rewrite the skill `index.ts`**

```typescript
import { execute } from "./write-profile.impl.js";

export default { execute };
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/skills-builtin/memory/write-profile/
git commit -m "refactor(skills): relocate write-profile logic into skill (SKILLS-05 Phase 0)"
```

### Task 0.9: Relocate `write-fact` execute body into the skill

**Files:**
- Create: `src/skills-builtin/memory/write-fact/write-fact.impl.ts`
- Modify: `src/skills-builtin/memory/write-fact/index.ts`

- [ ] **Step 1: Create the impl file**

```typescript
import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { ContactFactsRepository } from "../../../memory/contact-facts.repository.js";
import type { ToolResult } from "../../../tools/types.js";

interface WriteFactParams {
  contact_id: number;
  fact_key: string;
  fact_value: string;
  category?: string;
  confidence: number;
}

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as WriteFactParams;
  if (p.contact_id == null || !p.fact_key || !p.fact_value || p.confidence == null) {
    return {
      success: false,
      error: "INVALID_PARAMS",
      detail: "contact_id, fact_key, fact_value, and confidence are required",
    };
  }

  if (p.confidence < 0.5) {
    return { success: true, data: { skipped: true, reason: "LOW_CONFIDENCE" } };
  }

  const confirmed = p.confidence >= 0.8;
  const contactId = BigInt(p.contact_id);
  const factsRepo = new ContactFactsRepository(context.db);

  const client = await context.db.connect();
  try {
    await client.query("BEGIN");
    const newFact = await factsRepo.upsertFact(
      {
        organizationId: context.organizationId,
        contactId,
        factKey: p.fact_key,
        factValue: p.fact_value,
        category: p.category,
        confidence: p.confidence,
        sourceConversationKey: context.conversationKey,
        sourceExecutionId: context.executionId,
      },
      client,
    );
    await client.query("COMMIT");
    return { success: true, data: { inserted: true, confirmed, factId: String(newFact.id) } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { success: false, error: "EXTERNAL_ERROR", detail: String(err) };
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Rewrite the skill `index.ts`**

```typescript
import { execute } from "./write-fact.impl.js";

export default { execute };
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/skills-builtin/memory/write-fact/
git commit -m "refactor(skills): relocate write-fact logic into skill (SKILLS-05 Phase 0)"
```

### Task 0.10: Relocate `request-human` execute body into the skill

**Files:**
- Create: `src/skills-builtin/messaging/request-human/request-human.impl.ts`
- Modify: `src/skills-builtin/messaging/request-human/index.ts`

- [ ] **Step 1: Create the impl file** (preserve the STOP-signal `handoff: true` contract — handler detects it; do NOT call sendComplete)

```typescript
import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { checkRateLimit } from "../../../tools/_shared/rate-limit.js";
import type { ToolResult } from "../../../tools/types.js";

interface RequestHumanParams {
  reason: string;
  team_id?: number;
}

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as RequestHumanParams;
  if (!p.reason) {
    return { success: false, error: "INVALID_PARAMS", detail: "reason is required" };
  }
  const denied = await checkRateLimit(context.organizationId, "request-human", "request-human");
  if (denied) return denied;
  return {
    success: true,
    data: { handoff: true, reason: p.reason, team_id: p.team_id ?? null },
  };
}
```

- [ ] **Step 2: Rewrite the skill `index.ts`**

```typescript
import { execute } from "./request-human.impl.js";

export default { execute };
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/skills-builtin/messaging/request-human/
git commit -m "refactor(skills): relocate request-human logic into skill (SKILLS-05 Phase 0)"
```

### Task 0.11: Audit manifest ↔ tool parameter parity (spec §8 Risk 5)

**Files:** (read-only audit, no code change unless drift found)

- [ ] **Step 1: Diff parameters for each built-in tool**

Run: `for d in src/skills-builtin/{calendar,messaging,memory,knowledge}/*/; do echo "=== $d ==="; cat "$d/manifest.yaml"; done`
Then compare each manifest's `parameters` block against the legacy `.tool.ts` `parameters` object (still present until Phase 3).
Expected: `read-calendar` and `create-appointment` match (verified in spec). For any tool where manifest drifted from the `.tool.ts`, the manifest is now authoritative — record the difference in the commit message. If a manifest is MISSING a property the `.tool.ts` had, add it to the manifest so the executor view stays complete.

- [ ] **Step 2: Commit any manifest corrections (skip if none)**

```bash
git add src/skills-builtin/
git commit -m "fix(skills): reconcile manifest parameters with legacy tool metadata (SKILLS-05 Phase 0)"
```

### Task 0.12: Phase 0 gate — full suite green

- [ ] **Step 1: Run the full suite**

Run: `npm run build && npm test`
Expected: PASS. Skills are now self-contained; `.tool.ts` files still exist (Phase 3 deletes them); bootstrap unchanged. The 3 sales skills are untouched (already self-contained).

- [ ] **Step 2: Commit (no-op if clean — this is a gate, not a change)**

No commit needed if nothing changed; this step confirms Phase 0 is mergeable.

---

## Phase 1 — `UnifiedToolRegistry` + unit tests

> Goal: build the single canonical registry. Do NOT delete `registry.ts` / `skill-registry.ts` yet. Keep `skillToToolDefinition` in `skill-registry.ts` for now (Phase 3 moves it).

### Task 1.1: Write the failing unit test for `UnifiedToolRegistry`

**Files:**
- Create: `tests/unit/tools/unified-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";

import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { LoadedSkill } from "../../../src/skills/skill-runtime.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
import type { ToolDefinition, ToolResult } from "../../../src/tools/types.js";

function makeSkill(name: string): LoadedSkill {
  return {
    manifest: {
      name,
      version: "1.0.0",
      description: `${name} test skill description.`,
      category: "knowledge",
      agentType: "surface",
      parameters: { type: "object", properties: {}, required: [] },
      permissions: { requires: [], sideEffects: [] },
      entry: "index",
    },
    module: {
      async execute(_params: unknown, _ctx: AgentExecutionContext): Promise<ToolResult> {
        return { success: true, data: { ran: name } };
      },
    },
    manifestPath: `/fake/${name}/manifest.yaml`,
    skillDir: `/fake/${name}`,
  };
}

function makeToolDef(name: string): ToolDefinition {
  return {
    name,
    description: `${name} bare tool`,
    category: "messaging",
    agentType: "surface",
    parameters: {},
    async execute(): Promise<ToolResult> {
      return { success: true, data: { bare: name } };
    },
  };
}

describe("UnifiedToolRegistry", () => {
  beforeEach(() => UnifiedToolRegistry.resetForTests());

  it("registers a LoadedSkill and resolves it both ways", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("search-faq"));
    expect(reg.has("search-faq")).toBe(true);
    expect(reg.get("search-faq")?.manifest.name).toBe("search-faq");
    expect(reg.list().length).toBe(1);
    const def = reg.resolve("search-faq");
    expect(def?.name).toBe("search-faq");
    expect(def?.description).toBe("search-faq test skill description.");
  });

  it("all() returns ToolDefinition[] with a callable execute()", async () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("a"));
    reg.register(makeSkill("b"));
    const all = reg.all();
    expect(all.map((t) => t.name).sort()).toEqual(["a", "b"]);
    const res = await all[0].execute({}, {} as AgentExecutionContext);
    expect(res.success).toBe(true);
  });

  it("list().length === all().length (view parity)", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("x"));
    reg.register(makeSkill("y"));
    reg.register(makeSkill("z"));
    expect(reg.list().length).toBe(reg.all().length);
  });

  it("rejects duplicate registration", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("dup"));
    expect(() => reg.register(makeSkill("dup"))).toThrow(/already registered/i);
  });

  it("registerToolDefinition wraps a bare ToolDefinition", async () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.registerToolDefinition(makeToolDef("send-message"));
    expect(reg.has("send-message")).toBe(true);
    const def = reg.resolve("send-message");
    expect(def?.category).toBe("messaging");
    const res = await def!.execute({}, {} as AgentExecutionContext);
    expect((res.data as { bare: string }).bare).toBe("send-message");
  });

  it("tracks availability", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("avail"));
    expect(reg.isAvailable("avail")).toBe(true);
    reg.markUnavailable("avail");
    expect(reg.isAvailable("avail")).toBe(false);
    expect(reg.getUnavailableNames()).toContain("avail");
    expect(reg.isAvailable("missing")).toBe(false);
  });

  it("resolveOrThrow throws for unknown tool", () => {
    const reg = UnifiedToolRegistry.getInstance();
    expect(() => reg.resolveOrThrow("nope")).toThrow(/not found/i);
  });

  it("resetForTests clears state and replaces the singleton", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("temp"));
    UnifiedToolRegistry.resetForTests();
    expect(UnifiedToolRegistry.getInstance().has("temp")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/tools/unified-registry.test.ts`
Expected: FAIL — `Cannot find module '.../unified-registry.js'`.

- [ ] **Step 3: Commit the test**

```bash
git add tests/unit/tools/unified-registry.test.ts
git commit -m "test(tools): failing spec for UnifiedToolRegistry (SKILLS-05 Phase 1)"
```

### Task 1.2: Implement `UnifiedToolRegistry`

**Files:**
- Create: `src/tools/unified-registry.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { skillToToolDefinition } from "../skills/skill-registry.js";
import type { LoadedSkill, SkillModule } from "../skills/skill-runtime.js";

import type { ToolDefinition } from "./types.js";

/**
 * Canonical single registry for tools/skills (SKILLS-05).
 *
 * Stores `LoadedSkill` — the manifest is the single source of metadata.
 * Exposes a `ToolDefinition` view (derived via `skillToToolDefinition`) for the
 * executor hot path, and the raw `LoadedSkill` view for MCP outbound exposure.
 * Replaces the legacy `ToolRegistry` + `SkillRegistry` pair.
 *
 * Singleton, populated during bootstrap stage 5 (built-in skills) and the MCP
 * stage (synthetic `mcp:<server>.<tool>` skills). Use `resetForTests()` instead
 * of the old `(X as any).instance = undefined` hack.
 */
export class UnifiedToolRegistry {
  private static instance: UnifiedToolRegistry | undefined;
  private skills = new Map<string, LoadedSkill>();
  private unavailable = new Set<string>();

  static getInstance(): UnifiedToolRegistry {
    if (!UnifiedToolRegistry.instance) {
      UnifiedToolRegistry.instance = new UnifiedToolRegistry();
    }
    return UnifiedToolRegistry.instance;
  }

  /** Test-only: drop all state and replace the singleton. */
  static resetForTests(): void {
    UnifiedToolRegistry.instance = new UnifiedToolRegistry();
  }

  // --- Primary (manifest-based) registration ---

  register(skill: LoadedSkill): void {
    if (this.skills.has(skill.manifest.name)) {
      throw new Error(`Tool already registered: ${skill.manifest.name}`);
    }
    this.skills.set(skill.manifest.name, skill);
  }

  /**
   * Convenience for tests / call sites that hold a bare `ToolDefinition`.
   * Wraps it into a synthetic `LoadedSkill` whose manifest mirrors the tool
   * metadata, so the unified store stays homogeneous.
   */
  registerToolDefinition(tool: ToolDefinition): void {
    const module: SkillModule = { execute: tool.execute.bind(tool) };
    const skill: LoadedSkill = {
      manifest: {
        name: tool.name,
        version: "0.0.0",
        description: tool.description,
        category: tool.category,
        agentType: tool.agentType,
        parameters: tool.parameters as LoadedSkill["manifest"]["parameters"],
        permissions: { requires: [], sideEffects: [] },
        entry: "index",
      },
      module,
      manifestPath: `synthetic://${tool.name}`,
      skillDir: `synthetic://${tool.name}`,
    };
    this.register(skill);
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  /** LoadedSkill view — consumed by `mcp/server.ts` outbound exposure. */
  list(): LoadedSkill[] {
    return Array.from(this.skills.values());
  }

  // --- ToolDefinition views (executor hot path) ---

  /** Most-called method (handler hot path). */
  all(): ToolDefinition[] {
    return this.list().map((skill) => skillToToolDefinition(skill));
  }

  resolve(name: string): ToolDefinition | undefined {
    const skill = this.skills.get(name);
    return skill ? skillToToolDefinition(skill) : undefined;
  }

  resolveOrThrow(name: string): ToolDefinition {
    const def = this.resolve(name);
    if (!def) {
      throw new Error(`Tool not found: ${name}`);
    }
    return def;
  }

  // --- Availability (preserved from ToolRegistry) ---

  markUnavailable(name: string): void {
    this.unavailable.add(name);
  }

  isAvailable(name: string): boolean {
    return this.skills.has(name) && !this.unavailable.has(name);
  }

  getUnavailableNames(): string[] {
    return Array.from(this.unavailable);
  }
}
```

> NOTE: This imports `skillToToolDefinition` from `skill-registry.js` in Phase 1 (it still lives there). Phase 3 Task 3.1 MOVES that function into this file and flips the import direction.

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- tests/unit/tools/unified-registry.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/unified-registry.ts
git commit -m "feat(tools): UnifiedToolRegistry — single canonical store (SKILLS-05 Phase 1)"
```

---

## Phase 2 — Migrate real consumers + tests (stage 5 ↔ MCP stage atomic)

> Goal: repoint every real consumer to `UnifiedToolRegistry`. The bootstrap stage-5 and MCP-stage conversions MUST land in ONE commit (Task 2.3). `registry.ts` / `skill-registry.ts` still exist after this phase (unreferenced) — Phase 3 deletes them.

### Task 2.1: Migrate `src/runtime/harness.ts`

**Files:**
- Modify: `src/runtime/harness.ts:8,17,31`
- Test: `tests/unit/runtime/harness.test.ts`

- [ ] **Step 1: Swap the import**

In `src/runtime/harness.ts`, replace line 8:

```typescript
import { UnifiedToolRegistry } from "../tools/unified-registry.js";
```

- [ ] **Step 2: Change the field type (line 17)**

```typescript
  readonly toolRegistry: UnifiedToolRegistry;
```

- [ ] **Step 3: Change the constructor option type + default (lines ~26, 31)**

Replace the option type:

```typescript
      toolRegistry?: UnifiedToolRegistry;
```

and the default assignment:

```typescript
    this.toolRegistry = options.toolRegistry ?? UnifiedToolRegistry.getInstance();
```

- [ ] **Step 4: Migrate `harness.test.ts`** (spec's 7-site list OMITTED this file — see Spec Gaps)

In `tests/unit/runtime/harness.test.ts`, replace line 4 import:

```typescript
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
```

Replace line 14:

```typescript
    const toolReg = UnifiedToolRegistry.getInstance();
```

Replace line 28:

```typescript
    expect(harness.toolRegistry).toBe(UnifiedToolRegistry.getInstance());
```

- [ ] **Step 5: Run the harness test**

Run: `npm test -- tests/unit/runtime/harness.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/harness.ts tests/unit/runtime/harness.test.ts
git commit -m "refactor(runtime): harness uses UnifiedToolRegistry (SKILLS-05 Phase 2)"
```

### Task 2.2: Migrate `src/runtime/execution-handler.ts`

**Files:**
- Modify: `src/runtime/execution-handler.ts:48,253,585,896`

- [ ] **Step 1: Swap the import (line 48)**

```typescript
import { UnifiedToolRegistry } from "../tools/unified-registry.js";
```

- [ ] **Step 2: Change the Model-C `getInstance()` (line 253)**

```typescript
  const toolRegistry = UnifiedToolRegistry.getInstance();
```

- [ ] **Step 3: Change the `ExecutionContext` field type (line 585)**

```typescript
  toolRegistry?: UnifiedToolRegistry;
```

> This field is the same type imported by `src/integration/bullmq-consumer.ts` (`import type { ExecutionContext }`), so the consumer needs NO separate edit — it picks up the new field type transitively.

- [ ] **Step 4: Change the main-path `getInstance()` (line 896)**

```typescript
      const toolRegistry = ctx.toolRegistry ?? UnifiedToolRegistry.getInstance();
```

> The hot-path methods `.all()` (`:323,:1023,:1285`), `.resolve()` (`:338,:1179,:1391`), `.getUnavailableNames()` (`:1279`), and `tool.execute(...)` (`:350,:1183,:1458`) all exist on `UnifiedToolRegistry` by design (Phase 1) — no edits there. The `qualify-opportunity` override at `:1435-1449` operates on the resolved `ToolDefinition`, unchanged.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS — if `all()` were missing this would fail at `:323`. Confirms API parity.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/execution-handler.ts
git commit -m "refactor(runtime): execution-handler uses UnifiedToolRegistry (SKILLS-05 Phase 2)"
```

### Task 2.3: Migrate `src/bootstrap/stages.ts` — stage 5 + MCP stage + start-consumer (ATOMIC)

**Files:**
- Modify: `src/bootstrap/stages.ts:46-48,128-129,148-150,320-321,365-370,389,602`

This is the atomic conversion required by spec §4.5 / Risk 2. All edits below land in ONE commit.

- [ ] **Step 1: Fix the imports (lines 46-48)**

Replace the three lines:

```typescript
import { registerAllTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { SkillRegistry, skillToToolDefinition } from "../skills/skill-registry.js";
```

with:

```typescript
import { UnifiedToolRegistry } from "../tools/unified-registry.js";
```

> `registerAllTools`, `skillToToolDefinition`, and `SkillRegistry` are no longer used in stages.ts after this task. `registerAllTools` is removed in Phase 3.

- [ ] **Step 2: Rewrite the MCP stage registry block (lines 128-129)**

Replace:

```typescript
  const skillReg = SkillRegistry.getInstance();
  const toolReg = ToolRegistry.getInstance();
```

with:

```typescript
  const reg = UnifiedToolRegistry.getInstance();
```

- [ ] **Step 3: Rewrite the MCP stage register block (lines 147-152)**

Replace the dual-registry try block:

```typescript
        try {
          skillReg.register(skill);
          if (!toolReg.has(skill.manifest.name)) {
            toolReg.register(skillToToolDefinition(skill));
          }
          skills.push(skill);
        } catch (err) {
```

with the single-registry form:

```typescript
        try {
          reg.register(skill);
          skills.push(skill);
        } catch (err) {
```

- [ ] **Step 4: Rewrite stage 5 registry handles (lines 320-321)**

Replace:

```typescript
        const toolRegistry = ToolRegistry.getInstance();
        const skillRegistry = SkillRegistry.getInstance();
        const env = getEnv();
```

with:

```typescript
        const reg = UnifiedToolRegistry.getInstance();
        const env = getEnv();
```

- [ ] **Step 5: Replace the built-in load loop (lines 337-339)**

Replace:

```typescript
        const builtinSkills = await loader.loadFromPath(builtinRoot);
        for (const skill of builtinSkills) {
          skillRegistry.register(skill);
        }
```

with:

```typescript
        const builtinSkills = await loader.loadFromPath(builtinRoot);
        for (const skill of builtinSkills) {
          reg.register(skill);
        }
```

- [ ] **Step 6: Replace the external-skills load loop (lines 349-352)**

Replace:

```typescript
            const external = await loader.loadFromPath(env.SKILLS_PATH);
            for (const skill of external) {
              skillRegistry.register(skill);
            }
```

with:

```typescript
            const external = await loader.loadFromPath(env.SKILLS_PATH);
            for (const skill of external) {
              reg.register(skill);
            }
```

- [ ] **Step 7: DELETE the legacy-tool + mirror block (lines 359-370)**

Remove the entire block (the comment + `registerAllTools(toolRegistry)` + the `for ... skillToToolDefinition` mirror loop):

```typescript
        // 3) Register legacy tools (coexistence) AND mirror any skills not
        //    already covered by a legacy tool. ...
        registerAllTools(toolRegistry);
        for (const skill of skillRegistry.list()) {
          if (!toolRegistry.has(skill.manifest.name)) {
            toolRegistry.register(skillToToolDefinition(skill));
          }
        }
```

Skills now carry their own `execute` (Phase 0), so there is no name collision and no legacy tools to register. Replace with a single comment line:

```typescript
        // Skills are self-contained (SKILLS-05) — no legacy tool mirror needed.
```

- [ ] **Step 8: Fix the validation loop registry handle (lines 375-385)**

Replace the two `toolRegistry.has(...)` references inside the agent-required-tool validation with `reg.has(...)`:

```typescript
        for (const agent of agentRegistry
          .listByType("surface")
          .concat(agentRegistry.listByType("pipeline"))) {
          for (const toolName of agent.definition.permissions.required) {
            if (toolName === "*") continue;
            if (!reg.has(toolName)) {
              throw new Error(
                `Stage 5 FATAL: required tool "${toolName}" for agent "${agent.definition.name}" is not registered`,
              );
            }
          }
        }
```

- [ ] **Step 9: Fix the stage-5 log (line 388-390)** — switch `getAllTools()` → `all()`, drop the separate skill count (one store now)

```typescript
        console.log(
          `[bootstrap] Tools and permissions loaded: ${reg.all().length} skills registered`,
        );
```

- [ ] **Step 10: Fix start-consumer (line 602)**

```typescript
          toolRegistry: UnifiedToolRegistry.getInstance(),
```

- [ ] **Step 11: Build**

Run: `npm run build`
Expected: PASS — confirms stage 5 + MCP stage + start-consumer all compile against the unified API and no stale `ToolRegistry`/`SkillRegistry`/`registerAllTools`/`skillToToolDefinition` symbols remain in stages.ts.

- [ ] **Step 12: Commit (atomic)**

```bash
git add src/bootstrap/stages.ts
git commit -m "refactor(bootstrap): stage5 + MCP stage use UnifiedToolRegistry, drop double-register (SKILLS-05 Phase 2)"
```

### Task 2.4: Migrate `src/mcp/server.ts` and `src/mcp/bootstrap.ts`

**Files:**
- Modify: `src/mcp/server.ts:6,62`
- Modify: `src/mcp/bootstrap.ts:8,44-49`

- [ ] **Step 1: `mcp/server.ts` — swap import (line 6)**

```typescript
import { UnifiedToolRegistry } from "../tools/unified-registry.js";
```

- [ ] **Step 2: `mcp/server.ts` — swap the list source (line 62)**

```typescript
  const all = UnifiedToolRegistry.getInstance().list();
```

> `list()` returns `LoadedSkill[]` — identical shape to the old `SkillRegistry.list()`, so `filterExposedSkills(all, patterns)` downstream is unchanged.

- [ ] **Step 3: `mcp/bootstrap.ts` — swap import (line 8)**

```typescript
import { UnifiedToolRegistry } from "../tools/unified-registry.js";
```

- [ ] **Step 4: `mcp/bootstrap.ts` — swap the registry handle (lines 44-49)**

Replace:

```typescript
  const registry = SkillRegistry.getInstance();
  for (const skill of skills) {
    if (!registry.has(skill.manifest.name)) {
      registry.register(skill);
    }
  }
```

with:

```typescript
  const registry = UnifiedToolRegistry.getInstance();
  for (const skill of skills) {
    if (!registry.has(skill.manifest.name)) {
      registry.register(skill);
    }
  }
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Run the MCP integration tests** (they use `SkillRegistry.resetForTests()` today — migrated in Task 2.5; build alone confirms the prod code compiles)

Run: `npm test -- tests/integration/mcp-server.sse.test.ts`
Expected: may FAIL until Task 2.5 migrates the test's `SkillRegistry.resetForTests()` + `register()`. That is expected; do not "fix" it here. Proceed to 2.5.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts src/mcp/bootstrap.ts
git commit -m "refactor(mcp): server + bootstrap use UnifiedToolRegistry (SKILLS-05 Phase 2)"
```

### Task 2.5: Migrate the MCP integration tests

**Files:**
- Modify: `tests/integration/mcp-server.sse.test.ts:14,68,69,80`
- Modify: `tests/integration/mcp-client.test.ts:10,45,46,50,51,74`

- [ ] **Step 1: `mcp-server.sse.test.ts` — swap import (line 14)**

```typescript
import { UnifiedToolRegistry } from "../../src/tools/unified-registry.js";
```

- [ ] **Step 2: `mcp-server.sse.test.ts` — swap reset + register (lines 68-69, 80)**

Replace `SkillRegistry.resetForTests()` (lines 68, 80) with `UnifiedToolRegistry.resetForTests()` and line 69 `SkillRegistry.getInstance().register(makeSkill())` with `UnifiedToolRegistry.getInstance().register(makeSkill())`.

> `makeSkill()` returns a `LoadedSkill` here (the test already builds one for the SSE server) — `register(LoadedSkill)` is the primary path, no `registerToolDefinition` needed.

- [ ] **Step 3: `mcp-client.test.ts` — swap import (line 10)**

```typescript
import { UnifiedToolRegistry } from "../../src/tools/unified-registry.js";
```

- [ ] **Step 4: `mcp-client.test.ts` — swap reset + register (lines 45,46,50,51,74)**

Replace `SkillRegistry.resetForTests()` (lines 45, 50) with `UnifiedToolRegistry.resetForTests()`, and line 74 `const reg = SkillRegistry.getInstance();` with `const reg = UnifiedToolRegistry.getInstance();`. (Lines 46/51 are `McpClientRegistry.resetForTests()` — leave unchanged.)

- [ ] **Step 5: Run both MCP integration tests**

Run: `npm test -- tests/integration/mcp-server.sse.test.ts tests/integration/mcp-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/mcp-server.sse.test.ts tests/integration/mcp-client.test.ts
git commit -m "test(mcp): migrate MCP tests to UnifiedToolRegistry (SKILLS-05 Phase 2)"
```

### Task 2.6: Migrate the 7 reset-hack test sites to `UnifiedToolRegistry.resetForTests()`

**Files:**
- Modify: `tests/integration/execution-handler.integration.test.ts:47,136,138,191,193,258,267`
- Modify: `tests/integration/sdr/model-c-bridge.test.ts:67,185,187`
- Modify: `tests/unit/runtime/surface-context-contactid.test.ts:142,196,199,220`
- Modify: `tests/unit/runtime/qualify-framework-wiring.test.ts:162,244,246,270,305,306`
- Modify: `tests/unit/runtime/correlation-probe.test.ts:99,208,209,243`
- Modify: `tests/unit/runtime/execution-handler.flow.test.ts:45,99,102,123`
- Modify: `tests/helpers/sdr-replay.ts:54,221,224`

For EACH file, apply the same three transforms:
1. Import: `import { ToolRegistry } from ".../src/tools/registry.js";` → `import { UnifiedToolRegistry } from ".../src/tools/unified-registry.js";` (keep the correct relative depth per file).
2. Reset hack: `(ToolRegistry as any).instance = undefined;` → `UnifiedToolRegistry.resetForTests();` (delete the now-pointless `eslint-disable` comment line directly above it).
3. Usage: `ToolRegistry.getInstance()` → `UnifiedToolRegistry.getInstance()`, and any type annotation `let toolRegistry: ToolRegistry;` / `: ToolRegistry` → `: UnifiedToolRegistry`.
4. Any `toolRegistry.register(<bareToolDefinition>)` (e.g. `qualify-framework-wiring.test.ts:305-306` registering `fakeQualifyTool`/`fakeOtherTool`) → `toolRegistry.registerToolDefinition(<bareToolDefinition>)`.

- [ ] **Step 1: Migrate `tests/helpers/sdr-replay.ts`** (apply transforms 1-4; it registers via `toolRegistry.register(...)` of LoadedSkills loaded from the SDR fixture KB — confirm whether those are `LoadedSkill` or `ToolDefinition`; if `LoadedSkill`, keep `.register`, else use `.registerToolDefinition`)

Run after editing: `npm test -- tests/integration/sdr/`
Expected: the SDR replay helper compiles; proceed.

- [ ] **Step 2: Migrate `tests/integration/execution-handler.integration.test.ts`** (transforms 1-4; line 267 `toolRegistry: ToolRegistry.getInstance()` → `UnifiedToolRegistry.getInstance()`)

Run: `npm test -- tests/integration/execution-handler.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Migrate `tests/integration/sdr/model-c-bridge.test.ts`** (transforms 1-3)

Run: `npm test -- tests/integration/sdr/model-c-bridge.test.ts`
Expected: PASS.

- [ ] **Step 4: Migrate `tests/unit/runtime/surface-context-contactid.test.ts`** (transforms 1-3 + type annotation `:220`)

Run: `npm test -- tests/unit/runtime/surface-context-contactid.test.ts`
Expected: PASS.

- [ ] **Step 5: Migrate `tests/unit/runtime/qualify-framework-wiring.test.ts`** (transforms 1-4; lines 305-306 register `fakeQualifyTool`/`fakeOtherTool` → `registerToolDefinition`; type annotations at `:270`)

Run: `npm test -- tests/unit/runtime/qualify-framework-wiring.test.ts`
Expected: PASS — confirms the `qualify-opportunity` deterministic-framework override (handler `:1435`) still resolves a registered tool via the unified registry.

- [ ] **Step 6: Migrate `tests/unit/runtime/correlation-probe.test.ts`** (transforms 1-3 + type annotation `:243`)

Run: `npm test -- tests/unit/runtime/correlation-probe.test.ts`
Expected: PASS.

- [ ] **Step 7: Migrate `tests/unit/runtime/execution-handler.flow.test.ts`** (transforms 1-3 + type annotation `:123`; line 102 `toolRegistry: ToolRegistry.getInstance()` → `UnifiedToolRegistry.getInstance()`)

Run: `npm test -- tests/unit/runtime/execution-handler.flow.test.ts`
Expected: PASS.

- [ ] **Step 8: Build + grep for stragglers**

Run: `npm run build && grep -rn "ToolRegistry as any\|src/tools/registry.js\|\bToolRegistry\b" tests/`
Expected: build PASS; grep returns ZERO hits (every test now uses `UnifiedToolRegistry`).

- [ ] **Step 9: Commit**

```bash
git add tests/
git commit -m "test: migrate 8 reset-hack sites to UnifiedToolRegistry.resetForTests() (SKILLS-05 Phase 2)"
```

### Task 2.7: Bootstrap stage-5 behavior test

**Files:**
- Create: `tests/unit/bootstrap/stage5.test.ts`

This proves stage 5 loads built-in skills into the unified registry and validates `permissions.required` WITHOUT `registerAllTools` / mirror.

- [ ] **Step 1: Write the failing test**

```typescript
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach } from "vitest";

import { SkillLoader } from "../../../src/skills/skill-loader.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// tests/unit/bootstrap -> repo root -> src/skills-builtin
const builtinRoot = path.resolve(__dirname, "..", "..", "..", "src", "skills-builtin");

describe("stage 5 — load-tools-permissions (unified registry)", () => {
  beforeEach(() => UnifiedToolRegistry.resetForTests());

  it("loads all built-in skills into the unified registry (12 tools + 3 sales = 15)", async () => {
    const reg = UnifiedToolRegistry.getInstance();
    const loader = new SkillLoader();
    const skills = await loader.loadFromPath(builtinRoot);
    for (const skill of skills) reg.register(skill);

    expect(reg.list().length).toBe(15);
    // ToolDefinition view parity
    expect(reg.all().length).toBe(15);
    // a representative read tool, mutation tool, and sales skill all resolve
    expect(reg.has("read-calendar")).toBe(true);
    expect(reg.has("create-appointment")).toBe(true);
    expect(reg.has("qualify-opportunity")).toBe(true);
  });

  it("required-tool validation passes for a registered tool and fails for a missing one", async () => {
    const reg = UnifiedToolRegistry.getInstance();
    const loader = new SkillLoader();
    for (const skill of await loader.loadFromPath(builtinRoot)) reg.register(skill);

    // Mimic the stage-5 validation predicate.
    const required = ["read-calendar", "create-appointment"];
    for (const name of required) {
      expect(reg.has(name)).toBe(true);
    }
    expect(reg.has("nonexistent-tool")).toBe(false);
  });
});
```

> NOTE: confirm the `15` count after Phase 0 (12 mirrored tool names + 3 sales). If `SKILLS_DISABLED` or environment affects loading in CI, pass `new SkillLoader({ disabled: new Set() })` (already the default). The loader resolves `.ts` under tsx/vitest and `.js` under prod — vitest runs TS directly, so `.impl.ts` files load fine.

- [ ] **Step 2: Run to verify it passes**

Run: `npm test -- tests/unit/bootstrap/stage5.test.ts`
Expected: PASS (15 skills, parity holds). If it FAILS with a count other than 15, investigate Phase 0 (a skill `index.ts` may still import a deleted symbol or a manifest may be malformed).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/bootstrap/stage5.test.ts
git commit -m "test(bootstrap): stage5 loads 15 skills into UnifiedToolRegistry, no registerAllTools (SKILLS-05 Phase 2)"
```

### Task 2.8: Phase 2 gate — full suite + build green

- [ ] **Step 1: Run everything**

Run: `npm run build && npm test`
Expected: PASS. `registry.ts` and `skill-registry.ts` still exist but are now referenced ONLY by `unified-registry.ts` (for `skillToToolDefinition`) and `mcp/adapters/permission-filter.ts` (for `skillToToolDefinition`). Phase 3 resolves those.

- [ ] **Step 2: Confirm no production code still imports the legacy registries as registries**

Run: `grep -rn "from \"../tools/registry.js\"\|from \"../../tools/registry.js\"\|ToolRegistry.getInstance\|SkillRegistry.getInstance" src/`
Expected: ZERO hits (only `skillToToolDefinition` from `skill-registry.js` remains, used by `unified-registry.ts` + `permission-filter.ts`).

---

## Phase 3 — Delete legacy (point of no return)

> Goal: delete `registry.ts`, `skill-registry.ts` (moving `skillToToolDefinition` first), the 12 `.tool.ts` wrappers, and `registerAllTools`. Keep all `.mutation.ts` + `_shared/mutation-tool.ts`.

### Task 3.1: Move `skillToToolDefinition` into `unified-registry.ts`, delete `skill-registry.ts`

**Files:**
- Modify: `src/tools/unified-registry.ts`
- Modify: `src/mcp/adapters/permission-filter.ts:6`
- Delete: `src/skills/skill-registry.ts`

- [ ] **Step 1: Inline `skillToToolDefinition` into `unified-registry.ts`**

In `src/tools/unified-registry.ts`, replace the top import:

```typescript
import { skillToToolDefinition } from "../skills/skill-registry.js";
import type { LoadedSkill, SkillModule } from "../skills/skill-runtime.js";
```

with:

```typescript
import type { LoadedSkill, SkillModule } from "../skills/skill-runtime.js";

import type { ToolDefinition } from "./types.js";

/**
 * Adapt a LoadedSkill (manifest = metadata source) to the ToolDefinition shape
 * the executor consumes. The `execute` binding preserves the skill module's
 * closure — for mutation tools this is the `mutationExecute(...)` closure that
 * implements ADR-006 executeOrPropose.
 */
export function skillToToolDefinition(skill: LoadedSkill): ToolDefinition {
  return {
    name: skill.manifest.name,
    description: skill.manifest.description,
    category: skill.manifest.category,
    agentType: skill.manifest.agentType,
    parameters: skill.manifest.parameters,
    execute: skill.module.execute.bind(skill.module),
  };
}
```

> Remove the now-duplicate `import type { ToolDefinition } from "./types.js";` if it already exists lower in the file — keep exactly one. The existing class body uses `skillToToolDefinition(...)` calls unchanged (now resolved locally).

- [ ] **Step 2: Repoint `mcp/adapters/permission-filter.ts` (line 6)**

```typescript
import { skillToToolDefinition } from "../../tools/unified-registry.js";
```

- [ ] **Step 3: Delete `skill-registry.ts`**

```bash
git rm src/skills/skill-registry.ts
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS — no remaining importer of `skill-registry.js`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/unified-registry.ts src/mcp/adapters/permission-filter.ts
git commit -m "refactor(tools): move skillToToolDefinition into unified-registry, delete SkillRegistry (SKILLS-05 Phase 3)"
```

### Task 3.2: Delete `ToolRegistry` (`src/tools/registry.ts`)

**Files:**
- Delete: `src/tools/registry.ts`

- [ ] **Step 1: Confirm zero importers remain**

Run: `grep -rn "tools/registry.js\|class ToolRegistry" src/ tests/`
Expected: ZERO hits.

- [ ] **Step 2: Delete the file**

```bash
git rm src/tools/registry.ts
```

- [ ] **Step 3: Build + test**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(tools): delete legacy ToolRegistry (SKILLS-05 Phase 3)"
```

### Task 3.3: Delete the 12 `.tool.ts` wrappers and clean `src/tools/index.ts`

**Files:**
- Delete: `src/tools/calendar/create-appointment.tool.ts`, `cancel-appointment.tool.ts`, `reschedule-appointment.tool.ts`, `waitlist-add.tool.ts`, `read-calendar.tool.ts`, `list-appointments.tool.ts`
- Delete: `src/tools/messaging/send-message.tool.ts`, `request-human.tool.ts`
- Delete: `src/tools/memory/read-profile.tool.ts`, `write-profile.tool.ts`, `write-fact.tool.ts`
- Delete: `src/tools/knowledge/search-faq.tool.ts`
- Modify (delete contents): `src/tools/index.ts`

> KEEP: `src/tools/calendar/create-appointment.mutation.ts` (+ the other 4 `.mutation.ts` from the prior plan), `src/tools/_shared/mutation-tool.ts`, `src/tools/_shared/rate-limit.ts`, `src/tools/types.ts`, `src/tools/unified-registry.ts`.

- [ ] **Step 1: Confirm nothing imports the `.tool.ts` files anymore** (Phase 0 repointed all skill `index.ts` files off them; Phase 2 dropped `registerAllTools`)

Run: `grep -rln "\.tool\.js\|\.tool\"" src/ tests/`
Expected: ZERO hits referencing `src/tools/**/*.tool.*`. If `tests/` still references a `.tool.js` import (e.g. a mutation `.tool.ts` was imported directly by a prior-plan test), repoint that test to the `.mutation.js` export in the same commit.

- [ ] **Step 2: Delete the 12 wrapper files**

```bash
git rm src/tools/calendar/create-appointment.tool.ts \
  src/tools/calendar/cancel-appointment.tool.ts \
  src/tools/calendar/reschedule-appointment.tool.ts \
  src/tools/calendar/waitlist-add.tool.ts \
  src/tools/calendar/read-calendar.tool.ts \
  src/tools/calendar/list-appointments.tool.ts \
  src/tools/messaging/send-message.tool.ts \
  src/tools/messaging/request-human.tool.ts \
  src/tools/memory/read-profile.tool.ts \
  src/tools/memory/write-profile.tool.ts \
  src/tools/memory/write-fact.tool.ts \
  src/tools/knowledge/search-faq.tool.ts
```

- [ ] **Step 3: Rewrite `src/tools/index.ts`** (remove `registerAllTools`, all `.tool.ts` imports, all re-exports — leave a minimal barrel or empty file)

Replace the ENTIRE contents of `src/tools/index.ts` with:

```typescript
// Tool/skill machinery barrel.
//
// Built-in tools are defined as skills under `src/skills-builtin/**` and loaded
// into `UnifiedToolRegistry` at bootstrap stage 5. Mutation business logic lives
// in `src/tools/<cat>/<name>.mutation.ts` and is wired via `mutationExecute()`.
// The legacy `registerAllTools` + per-tool `.tool.ts` wrappers were removed in
// SKILLS-05 (Phase 3).
export { UnifiedToolRegistry, skillToToolDefinition } from "./unified-registry.js";
export type { ToolDefinition, ToolResult, ToolCategory, ToolAgentType } from "./types.js";
```

- [ ] **Step 4: Check whether `wrapMutationTool` still has any importer**

Run: `grep -rn "wrapMutationTool" src/ tests/`
Expected: only the definition in `_shared/mutation-tool.ts` (all skills now use `mutationExecute`; the `.tool.ts` wrappers that used it are deleted). If ZERO importers, remove the `wrapMutationTool` export + its body from `_shared/mutation-tool.ts` in this commit; if a `.mutation.ts` or test still imports it, leave it.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — including `mutation-proposal.test.ts` (now exercising skills via `mutationExecute` only).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tools): delete 12 .tool.ts wrappers + registerAllTools (SKILLS-05 Phase 3)"
```

### Task 3.4: Orphan-reference verification (spec §5 Phase 3 grep gate)

- [ ] **Step 1: Run the orphan grep**

Run: `grep -rn "\.tool\.ts\|\.tool\.js\|registerAllTools\|class ToolRegistry\|class SkillRegistry\|from \"../tools/registry\|from \"../../tools/registry\|skill-registry\.js" src/ tests/`
Expected: ZERO hits (definitions deleted, all imports repointed). `skillToToolDefinition` now resolves only from `unified-registry.js`.

- [ ] **Step 2: Confirm tool count = 12 distinct tool names / 15 skills**

Run: `ls src/skills-builtin/{calendar,messaging,memory,knowledge}/ | grep -c .` (counts the 12 mirrored skill dirs) and `find src/skills-builtin -name manifest.yaml | wc -l` (expects 15).
Expected: 12 + 3 sales = 15 manifests.

- [ ] **Step 3: Commit (no-op gate)**

No change expected; if the grep surfaced a straggler, fix it and:

```bash
git add -A
git commit -m "fix(tools): remove final orphan registry reference (SKILLS-05 Phase 3)"
```

---

## Phase 4 — Docs & final validation

### Task 4.1: Update `src/skills-builtin/README.md`

**Files:**
- Modify: `src/skills-builtin/README.md`

- [ ] **Step 1: Replace the "Phase 8 transition" paragraph**

Replace lines 9-13 (the "During the Phase 8 transition ... re-exports the `execute` of the equivalent legacy tool ... will be removed in a follow-up PR") with:

```markdown
Each skill is self-contained (SKILLS-05): `index.ts` either inlines `execute`
(or imports a sibling `<name>.impl.ts`) for read/stop tools, or wires a
`MutationTool` via `mutationExecute(<mutation>)` for the 5 mutation tools
(`create-appointment`, `cancel-appointment`, `reschedule-appointment`,
`waitlist-add`, `send-message`). Mutation business logic lives in
`src/tools/<category>/<name>.mutation.ts`. The legacy `src/tools/**/*.tool.ts`
wrappers and the `ToolRegistry`/`SkillRegistry` pair were removed; the single
canonical store is `UnifiedToolRegistry`, populated at bootstrap stage 5.
```

- [ ] **Step 2: Commit**

```bash
git add src/skills-builtin/README.md
git commit -m "docs(skills): README reflects self-contained skills + UnifiedToolRegistry (SKILLS-05 Phase 4)"
```

### Task 4.2: Update `.claude/rules/harness-tools.md`

**Files:**
- Modify: `.claude/rules/harness-tools.md`

- [ ] **Step 1: Add a unification note + update the EM-03 POC section**

At the top of the file, after the categories list, add:

```markdown
## Registry (SKILLS-05)

Tools ARE skills (manifest-based). The single canonical store is
`UnifiedToolRegistry` (`src/tools/unified-registry.ts`) — it stores
`LoadedSkill` and exposes both a `ToolDefinition[]` view (`all()`/`resolve()`
for the executor) and a `LoadedSkill[]` view (`list()` for MCP outbound). The
legacy `ToolRegistry` + `SkillRegistry` pair and the per-tool `.tool.ts`
wrappers were removed. Each skill `index.ts` is self-contained; mutation
business logic stays in `src/tools/<cat>/<name>.mutation.ts` and is wired via
`mutationExecute(<mutation>)`.
```

Then update the "EM-03 wiring (issue #44 POC)" section: replace the "**Estado POC ... apenas `createAppointmentTool` adota o bridge** ... ainda usam o `ToolDefinition` legado e sempre executam" paragraph with a note that ALL 5 mutation tools now go through `executeOrPropose` via `mutationExecute` (C9 landed) — backend receives `proposals[]` for all 5 in draft modes.

> NOTE: This C9 statement is only accurate if the prior "mutation tool rollout" plan made all 5 mutation tools `MutationTool` subclasses (the assumed starting state). It is the precondition of this plan, so it holds.

- [ ] **Step 2: Commit**

```bash
git add .claude/rules/harness-tools.md
git commit -m "docs(rules): harness-tools reflects UnifiedToolRegistry + full mutation rollout (SKILLS-05 Phase 4)"
```

### Task 4.3: Update `.claude/rules/harness-payload.md`

**Files:**
- Modify: `.claude/rules/harness-payload.md`

- [ ] **Step 1: Update the Layer-2 derivation reference**

In the "Layer-2 permission model" section, update the bullet describing the allowlist complement so it states the complement is derived from `UnifiedToolRegistry.all()`:

```markdown
- **`skills` é uma allowlist plana** de tool names permitidos pela
  organização. Quando NÃO vazia, o harness deriva o complemento
  (`UnifiedToolRegistry.all()` \ `skills`) e o adiciona ao denylist final.
```

(Replace the prior `toolRegistry.all()` phrasing.)

- [ ] **Step 2: Commit**

```bash
git add .claude/rules/harness-payload.md
git commit -m "docs(rules): harness-payload allowlist resolves via UnifiedToolRegistry.all() (SKILLS-05 Phase 4)"
```

### Task 4.4: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the registries + bootstrap stage-5 mentions**

In the "Registries — Singleton pattern" block, replace `ToolRegistry.getInstance().register(tool)` with `UnifiedToolRegistry.getInstance().register(skill)` and note it is the single canonical store. In the bootstrap stage list, update stage 5 description to "load skills (15: 12 tools + 3 sales) into `UnifiedToolRegistry`; no legacy `registerAllTools`". In the directory-structure section, leave the tool inventory but note tools are defined as skills under `src/skills-builtin/`.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md reflects UnifiedToolRegistry single store (SKILLS-05 Phase 4)"
```

### Task 4.5: Final full validation gate

- [ ] **Step 1: Type-check + lint + full suite**

Run: `npm run build && npm run lint && npm test`
Expected: ALL PASS. `build` catches any missing `all()` / orphan import; `lint` catches unused-import / dead-code warnings (e.g. leftover `eslint-disable` comments above removed hacks — remove any flagged); `test` runs unit + integration incl. `mutation-proposal.test.ts`, `unified-registry.test.ts`, `stage5.test.ts`.

- [ ] **Step 2: Local bootstrap smoke (needs DB + Redis up)**

Run: `npm run dev` (let it reach stage 5, then Ctrl-C)
Expected: bootstrap completes stage 5 + MCP stage; log line reads `[bootstrap] Tools and permissions loaded: 15 skills registered` (with no external skills). If a DB/Redis is not available locally, skip this step and rely on the `stage5.test.ts` unit coverage of the load path.

- [ ] **Step 3: Final orphan grep (defense in depth)**

Run: `grep -rn "ToolRegistry\b\|SkillRegistry\b\|registerAllTools\|skillToToolDefinition\|\.tool\.ts" src/ tests/ | grep -v "UnifiedToolRegistry"`
Expected: only the `skillToToolDefinition` definition + its 2 importers (`unified-registry.ts` self, `mcp/adapters/permission-filter.ts`) and doc-comment mentions — NO live `ToolRegistry`/`SkillRegistry`/`registerAllTools`/`.tool.ts` references.

- [ ] **Step 4: Link the PR to the audit (SKILLS-05 DoD)**

When opening the PR, reference `runtime-gap-audit-2026-06-02.md:223` (SKILLS-05) and bernardTavares/bevox-harness#46 in the body, and add a comment on the audit doc / issue linking the PR.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task(s) |
|---|---|
| §4.3 `mutationExecute()` helper (metadata-free closure) | 0.1 |
| §6 Phase 0 `mutation-proposal.test.ts` for all 5 mutation tools (autonomous/draft/idempotency) | 0.2 |
| §4.3 / Phase 0: 5 mutation skills self-contained via `mutationExecute` | 0.3 |
| §4.3 / Phase 0: 7 read/stop skills move `execute` into skill (`read-calendar`, `list-appointments`, `search-faq`, `read-profile`, `write-profile`, `write-fact`, `request-human`) | 0.4–0.10 |
| §8 Risk 5: manifest↔tool parameter parity audit | 0.11 |
| §4.1 `UnifiedToolRegistry` (all/resolve/has/get/list/markUnavailable/isAvailable/getUnavailableNames/resetForTests/resolveOrThrow) | 1.2 |
| §6 Phase 1 `unified-registry.test.ts` (register/get/has/list, all() callable, parity, availability, reset) | 1.1 |
| §4.1 / §2 consumer: `execution-handler.ts` (:48,:253,:585,:896) | 2.2 |
| §2 consumer: `harness.ts` (:8,:17,:31) | 2.1 |
| §4.4 stage 5 rewrite (no registerAllTools, no mirror) + §4.5 MCP stage single-register + :602, ATOMIC | 2.3 |
| §4.6 `mcp/server.ts:62` + `mcp/bootstrap.ts:44` | 2.4 |
| §2 7 reset-hack test sites → `resetForTests()` + 2 SkillRegistry test importers | 2.5, 2.6 |
| §6 Phase 2 `stage5.test.ts` | 2.7 |
| §5 Phase 3 delete `skill-registry.ts` (move `skillToToolDefinition`) | 3.1 |
| §5 Phase 3 delete `registry.ts` | 3.2 |
| §5 Phase 3 delete 12 `.tool.ts` + clean `index.ts` + drop `registerAllTools`/`wrapMutationTool` if orphan | 3.3 |
| §5 Phase 3 orphan grep + count (12/15) | 3.4 |
| §5 Phase 4 docs (README, harness-tools, harness-payload, CLAUDE.md) + JSDoc on unified-registry | 4.1–4.4 (JSDoc in 1.2) |
| §5 Phase 4 validation (build/lint/test/dev shows 15) | 4.5 |

All spec sections mapped. No requirement left without a task.

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling"/"similar to Task N". Every code step contains complete code. The two "confirm before running" NOTEs (mutation export names, `stepIndex` field name) are verification instructions for facts that depend on the prior plan's landed shape — they point at exact files to check, not deferred work.

**3. Type consistency:** `UnifiedToolRegistry` methods (`all`, `resolve`, `resolveOrThrow`, `has`, `get`, `list`, `register`, `registerToolDefinition`, `markUnavailable`, `isAvailable`, `getUnavailableNames`, `resetForTests`) are used consistently across Tasks 1.1, 1.2, 2.1–2.7, 3.1. `skillToToolDefinition` signature `(skill: LoadedSkill) => ToolDefinition` is identical to the legacy one (preserves the `execute` bind), so the executor view is byte-compatible. `mutationExecute<P,R>(mutation: MutationTool<P,R>) => (params, context) => Promise<ToolDefResult>` matches the `SkillModule.execute` signature, so `export default { execute: mutationExecute(...) }` type-checks. `LoadedSkill` shape (manifest/module/manifestPath/skillDir) is used consistently in the synthetic-skill builder (1.2), test helpers (1.1), and stage5 test (2.7).

## Spec gaps & open questions surfaced during file verification

1. **Prior plan does NOT exist on disk yet.** `docs/superpowers/plans/2026-06-02-mutation-tool-rollout-idempotency-plan.md` is absent, and currently only `create-appointment.mutation.ts` exists — the other 4 mutation tools are still plain `.tool.ts` files, and `MutationPreconditionError` lives in `create-appointment.mutation.ts` (not yet in `mutation-tool.ts`). This plan is written to its stated precondition (prior plan landed: 5 `.mutation.ts` files + hardened base). If executed before the prior plan, Tasks 0.2/0.3 will fail at import of `cancel-appointment.mutation.js` etc. — **sequencing is mandatory.**
2. **Spec's "7 reset-hack sites" list is incomplete.** `tests/unit/runtime/harness.test.ts` (3 refs) also imports/uses `ToolRegistry` and is NOT in the spec §2 list; covered in Task 2.1. Several files also carry `let toolRegistry: ToolRegistry` type annotations (surface-context, correlation-probe, qualify-framework, execution-handler.flow) the spec didn't enumerate — covered in Task 2.6.
3. **Test registration ergonomics gap (not addressed by spec §4.1).** Tests register bare `ToolDefinition` via `toolRegistry.register(tool)` (e.g. `fakeQualifyTool`/`fakeOtherTool`). The spec's `register(LoadedSkill)` would break these. Resolved by adding `registerToolDefinition()` (Task 1.2) — a design addition beyond the spec's listed surface; flag for reviewer.
4. **Spec missed `src/mcp/adapters/permission-filter.ts`** as a `skillToToolDefinition` importer (spec §2 only lists `mcp/server.ts` + `mcp/bootstrap.ts` for SkillRegistry). When `skill-registry.ts` is deleted, this import must repoint to `unified-registry.js` — covered in Task 3.1. Also `workflow/subscriber.ts` / `workflow/resume-server.ts` matched the registry grep but import `WorkflowRegistry` (false positives) — NOT migrated.
5. **`send-message` reclassification.** Today `send-message.tool.ts` is a STOP-signal that does NOT call the backend (handler dispatches the final message). The spec + `harness-tools.md` classify it as a mutation tool requiring `executeOrPropose`. This plan assumes the prior plan converted it to a `MutationTool` (`sendMessageMutation`). If the prior plan left it as a non-mutation STOP tool, move Task 0.3 Step 5 to a read/stop-style relocation (like `request-human`) and drop the `send-message` block from `mutation-proposal.test.ts`. Flag for reviewer.
6. **Tool-count wording.** The spec asserts "12 tools / 15 skills". The `src/tools/<cat>/` tree currently has 12 distinct tool names (6 calendar incl. create-appointment, 2 messaging, 3 memory, 1 knowledge). With the prior plan, `create-appointment.tool.ts` is one of 5 mutation wrappers; total `.tool.ts` wrappers to delete in Phase 3 = 12. The Phase 3 grep gate confirms 12 names / 15 manifests.
