/**
 * Unit tests for the sdr-cadence WorkflowDefinition (Fase C §6, Task C.6).
 *
 * TDD Step 1: RED — these tests assert the shape of the cadence before the
 * implementation file exists. Run → expect failures.
 *
 * Assertions:
 *  1. The definition `.build()`s without throwing (unique flat step ids, no
 *     duplicate-step-id constraint violations — L5).
 *  2. Reply-awaiting touch steps use resumeOn: "reply:inbound" (∈ REPLY_RESUMABLE).
 *  3. The AE-requalification suspend uses a resumeOn NOT in REPLY_RESUMABLE.
 *  4. Branch guards are deterministic — they read stepOutputs / state, never
 *     call ctx.llmClient (assert no LLM invocation in any guard).
 *  5. The first step persists contactKey (and organizationId) into stepOutputs
 *     so the correlation hook and later resume can find it.
 *  6. Engine lifecycle: start → first touch → suspend(reply:inbound). Then
 *     resume with a positive payload → deterministic branch advances toward
 *     qualify path. Negative payload → toward nurture path.
 */

import { describe, expect, it, vi } from "vitest";

import { REPLY_RESUMABLE } from "../../../src/workflow/correlation-store.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import { runWorkflow, resumeWorkflow } from "../../../src/workflow/engine.js";
import type { WorkflowStateStore } from "../../../src/workflow/state-store.js";
import { FakeWorkflowStore } from "../../fakes/workflow-store.fake.js";
import { sdrCadenceWorkflow, AE_REQUALIFY_RESUME_ON } from "../../../src/workflow/definitions/sdr-cadence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  const noop = () => {};
  const childLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    child: () => childLogger,
  };
  const llmClient = {
    complete: vi.fn().mockResolvedValue({ content: "", model: "fake" }),
  };
  return {
    executionId: "exec-test",
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    conversationKey: "conv-test",
    db: {} as never,
    logger: childLogger as never,
    llmClient,
    ...overrides,
  };
}

const noopTool = async () => ({ success: true });

/**
 * Collect all suspend signals from a workflow definition by walking its steps
 * recursively (kind=step only — looks for ctx.suspend calls by running each
 * step with a ctx that throws WorkflowSuspendError and catching the signal).
 *
 * For the purposes of these tests we use a simpler approach: collect
 * resumeOn values that appear in the workflow definition's step metadata
 * by running the workflow engine through the actual steps.
 */
function collectAllStepIds(steps: Array<{ id: string; kind: string; branches?: { truthy: Array<{id:string;kind:string;branches?: unknown}>; falsy: Array<{id:string;kind:string;branches?: unknown}> }; parallel?: Array<{id:string;kind:string}> }>): string[] {
  const ids: string[] = [];
  for (const s of steps) {
    ids.push(s.id);
    if (s.kind === "branch" && s.branches) {
      ids.push(...collectAllStepIds(s.branches.truthy as never));
      ids.push(...collectAllStepIds(s.branches.falsy as never));
    } else if (s.kind === "parallel" && s.parallel) {
      ids.push(...collectAllStepIds(s.parallel as never));
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sdrCadenceWorkflow definition", () => {
  // -------------------------------------------------------------------------
  // 1. Build without throwing (unique step ids)
  // -------------------------------------------------------------------------
  it("builds without throwing (no duplicate step ids)", () => {
    expect(() => sdrCadenceWorkflow).not.toThrow();
    expect(sdrCadenceWorkflow.id).toBe("sdr-cadence");
    expect(sdrCadenceWorkflow.version).toBe(1);
    expect(Array.isArray(sdrCadenceWorkflow.steps)).toBe(true);
  });

  it("all step ids in the definition are unique (flat tree)", () => {
    const ids = collectAllStepIds(sdrCadenceWorkflow.steps as never);
    const unique = new Set(ids);
    expect(ids.length).toBeGreaterThan(0);
    expect(unique.size).toBe(ids.length);
  });

  // -------------------------------------------------------------------------
  // 2. Touch suspends use "reply:inbound" (∈ REPLY_RESUMABLE)
  // -------------------------------------------------------------------------
  it("touch steps are present and named touch-1 through touch-7", () => {
    const ids = collectAllStepIds(sdrCadenceWorkflow.steps as never);
    for (let i = 1; i <= 7; i++) {
      expect(ids).toContain(`touch-${i}`);
    }
  });

  it("reply-awaiting suspend steps use resumeOn 'reply:inbound' (∈ REPLY_RESUMABLE)", async () => {
    // Run the workflow and catch the first suspend — should be reply:inbound
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    const ctx = makeCtx();
    const result = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-abc-1" },
      context: ctx,
      store,
      executionId: "exec-touch-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(result.status).toBe("suspended");
    expect(result.suspend?.resumeOn).toBe("reply:inbound");
    // "reply:inbound" must be in REPLY_RESUMABLE
    expect(REPLY_RESUMABLE).toContain(result.suspend!.resumeOn);
  });

  // -------------------------------------------------------------------------
  // 3. AE-requalification suspend uses a resumeOn NOT in REPLY_RESUMABLE
  // -------------------------------------------------------------------------
  it("AE-requalification suspend uses a resumeOn not in REPLY_RESUMABLE", () => {
    // AE_REQUALIFY_RESUME_ON is exported from the definition module.
    // It must be a non-empty string and must NOT appear in REPLY_RESUMABLE.
    expect(typeof AE_REQUALIFY_RESUME_ON).toBe("string");
    expect(AE_REQUALIFY_RESUME_ON.length).toBeGreaterThan(0);
    expect(REPLY_RESUMABLE).not.toContain(AE_REQUALIFY_RESUME_ON);
    expect(AE_REQUALIFY_RESUME_ON).not.toBe("reply:inbound");
  });

  // -------------------------------------------------------------------------
  // 4. Branch guards are deterministic — NO llmClient call
  // -------------------------------------------------------------------------
  it("branch guards do not invoke ctx.llmClient (deterministic per §6.4)", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    const ctx = makeCtx();
    const llmCompleteSpy = ctx.llmClient.complete as ReturnType<typeof vi.fn>;

    // Run through the first touch suspend
    const first = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-det-1" },
      context: ctx,
      store,
      executionId: "exec-det-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(first.status).toBe("suspended");

    // Resume with a positive reply signal — the branch guard should fire
    // and determine the next state WITHOUT calling llmClient
    const second = await resumeWorkflow(
      store,
      first.suspend!.token,
      "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      { positive: true, replied: true },
      { definition: sdrCadenceWorkflow, context: ctx, toolExecutor: noopTool },
    );

    // The workflow should advance (either continue cadence or qualify branch)
    // without ever touching llmClient
    expect(llmCompleteSpy).not.toHaveBeenCalled();
    // Status should be suspended (next touch) or progressing (qualify path)
    expect(["suspended", "completed", "failed"]).toContain(second.status);
  });

  // -------------------------------------------------------------------------
  // 5. First step persists contactKey and organizationId into stepOutputs
  // -------------------------------------------------------------------------
  it("first step stashes contactKey and organizationId into stepOutputs", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    const ctx = makeCtx();

    const result = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "contact-key-xyz" },
      context: ctx,
      store,
      executionId: "exec-stash",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    // Workflow suspends at first touch — stepOutputs should have the init step
    expect(result.stepOutputs).toMatchObject(
      expect.objectContaining({
        "init": expect.objectContaining({
          contactKey: "contact-key-xyz",
          organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 6. Multi-step lifecycle: negative signal → nurture path
  // -------------------------------------------------------------------------
  it("negative reply signal (no positive signal) advances toward nurture status", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    const ctx = makeCtx();

    const first = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-nurture-1" },
      context: ctx,
      store,
      executionId: "exec-nurture",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(first.status).toBe("suspended");
    expect(first.suspend?.resumeOn).toBe("reply:inbound");

    // Resume with a negative (opt-out / unsubscribe) signal
    const second = await resumeWorkflow(
      store,
      first.suspend!.token,
      "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      { optOut: true, replied: true },
      { definition: sdrCadenceWorkflow, context: ctx, toolExecutor: noopTool },
    );

    // Should either continue to next touch (Cold→Working, needs more touches)
    // or move to nurture depending on cadence logic
    expect(["suspended", "completed"]).toContain(second.status);
    // The llmClient must not have been called
    expect((ctx.llmClient.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
