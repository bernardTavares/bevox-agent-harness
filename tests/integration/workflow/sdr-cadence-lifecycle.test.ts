/**
 * Gated lifecycle integration test for sdr-cadence WorkflowDefinition (Fase C C.6).
 *
 * Gated by RUN_INTEGRATION=1.
 *
 * Uses FakeWorkflowStore (no real DB required — lifecycle exercised in-memory).
 * Exercises the multi-suspend round-trip:
 *
 *   1. start → init → touch-1 → suspend(reply:inbound)
 *   2. resume(positive) → qualify gate → handoff → suspend(callback:ae.requalified)
 *   3. Also: start → ... → resume(optOut) → Nurture:Dead (workflow completes)
 *   4. Also: run all 7 touches with no qualifying reply → Nurture:Quarterly
 *
 * Assertions mirror the unit tests but prove the engine-level lifecycle
 * with the real runWorkflow / resumeWorkflow functions and FakeWorkflowStore.
 */

import { describe, expect, it } from "vitest";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import { runWorkflow, resumeWorkflow } from "../../../src/workflow/engine.js";
import type { WorkflowStateStore } from "../../../src/workflow/state-store.js";
import { FakeWorkflowStore } from "../../fakes/workflow-store.fake.js";
import { REPLY_RESUMABLE } from "../../../src/workflow/correlation-store.js";
import {
  sdrCadenceWorkflow,
  AE_REQUALIFY_RESUME_ON,
} from "../../../src/workflow/definitions/sdr-cadence.js";

const RUN = process.env.RUN_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(organizationId = 1): AgentExecutionContext {
  const noop = () => {};
  const childLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    child: () => childLogger,
  };
  return {
    executionId: "exec-lifecycle",
    organizationId,
    conversationKey: "conv-lifecycle",
    db: {} as never,
    logger: childLogger as never,
    llmClient: {
      complete: async () => {
        throw new Error("llmClient.complete must NOT be called in sdr-cadence guards");
      },
    },
  };
}

const noopTool = async () => ({ success: true });

/**
 * Run until suspended (or completed/failed), then resume with given payload.
 * Repeats up to maxResumes times.
 */
async function runUntilTerminal(
  store: WorkflowStateStore,
  payloads: unknown[],
  organizationId: number,
): Promise<{ status: string; stepOutputs: Record<string, unknown>; suspend?: { resumeOn?: string; token?: string } | undefined }> {
  const ctx = makeCtx(organizationId);
  let result = await runWorkflow({
    definition: sdrCadenceWorkflow,
    input: { organizationId, contactKey: `contact-${organizationId}` },
    context: ctx,
    store,
    executionId: `exec-${organizationId}-${Date.now()}`,
    organizationId,
    toolExecutor: noopTool,
  });

  let payloadIdx = 0;
  while (result.status === "suspended" && payloadIdx < payloads.length) {
    const token = result.suspend!.token;
    result = await resumeWorkflow(
      store,
      token,
      organizationId,
      payloads[payloadIdx++],
      { definition: sdrCadenceWorkflow, context: ctx, toolExecutor: noopTool },
    ) as typeof result;
  }

  return result as typeof result & { suspend?: { resumeOn?: string; token?: string } };
}

// ---------------------------------------------------------------------------
// Tests (gated by RUN_INTEGRATION=1 — use FakeWorkflowStore, no real DB)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN)("sdr-cadence lifecycle integration", () => {
  // -------------------------------------------------------------------------
  // 1. Start → first touch → suspend(reply:inbound)
  // -------------------------------------------------------------------------
  it("start → init → touch-1 → suspend with resumeOn=reply:inbound", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    const ctx = makeCtx(1);

    const result = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-001" },
      context: ctx,
      store,
      executionId: "exec-lc-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(result.status).toBe("suspended");
    expect(result.suspend?.resumeOn).toBe("reply:inbound");
    expect(REPLY_RESUMABLE).toContain(result.suspend!.resumeOn);
    // init step should have stashed contactKey + organizationId
    expect(result.stepOutputs["init"]).toMatchObject({ organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-001" });
  });

  // -------------------------------------------------------------------------
  // 2. Positive reply → qualify gate → handoff → suspend(callback:ae.requalified)
  // -------------------------------------------------------------------------
  it("positive reply with full PACT evidence → qualify gate passes → AE handoff suspend", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    const ctx = makeCtx(2);

    const first = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-002" },
      context: ctx,
      store,
      executionId: "exec-lc-2",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(first.status).toBe("suspended");
    expect(first.suspend?.resumeOn).toBe("reply:inbound");

    // Resume with positive signal + full PACT evidence (qualify gate must PASS)
    const second = await resumeWorkflow(
      store,
      first.suspend!.token,
      2,
      {
        positive: true,
        replied: true,
        pain: { description: "We lose 20 hours/week to manual reconciliation", evidenceType: "prospect_stated" },
        authority: { description: "I am the CFO and approved budget owner", evidenceType: "economic_buyer" },
        consequence: { description: "Estimated $200k/year in rework costs", evidenceType: "quantified_impact" },
        targetProfile: { icpMatchCount: 5, personaMatch: true },
      },
      { definition: sdrCadenceWorkflow, context: ctx, toolExecutor: noopTool },
    );

    // Should suspend on AE-requalification (NOT reply:inbound)
    expect(second.status).toBe("suspended");
    expect(second.suspend?.resumeOn).toBe(AE_REQUALIFY_RESUME_ON);
    expect(REPLY_RESUMABLE).not.toContain(second.suspend!.resumeOn);
  });

  // -------------------------------------------------------------------------
  // 3. Opt-out reply → Nurture:Dead (workflow completes)
  // -------------------------------------------------------------------------
  it("opt-out reply → Nurture:Dead → workflow completes", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    const ctx = makeCtx(3);

    const first = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-003" },
      context: ctx,
      store,
      executionId: "exec-lc-3",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(first.status).toBe("suspended");

    const second = await resumeWorkflow(
      store,
      first.suspend!.token,
      3,
      { optOut: true, replied: true },
      { definition: sdrCadenceWorkflow, context: ctx, toolExecutor: noopTool },
    );

    // Workflow should complete (Nurture:Dead terminal state)
    expect(second.status).toBe("completed");
    expect(JSON.stringify(second.output)).toContain("Dead");
  });

  // -------------------------------------------------------------------------
  // 4. No qualifying reply across all 7 touches → Nurture:Quarterly
  // -------------------------------------------------------------------------
  it("7 soft-no replies (no positive, no opt-out) → Nurture:Quarterly", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;

    // Provide 7 soft-no payloads (no positive, no optOut)
    const softNo = { replied: true, softNo: true };
    const payloads = Array(7).fill(softNo);

    const result = await runUntilTerminal(store, payloads, 4);

    // After all 7 touches exhausted, workflow completes with Nurture:Quarterly
    expect(result.status).toBe("completed");
    expect(JSON.stringify(result.output)).toContain("Quarterly");
  });

  // -------------------------------------------------------------------------
  // 5. Positive reply but qualify gate FAILS → Nurture:Active
  // -------------------------------------------------------------------------
  it("positive reply but PACT evidence insufficient → qualify gate fails → Nurture:Active", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    const ctx = makeCtx(5);

    const first = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-005" },
      context: ctx,
      store,
      executionId: "exec-lc-5",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(first.status).toBe("suspended");

    // Resume with positive=true but NO PACT evidence → qualify gate FAILS
    const second = await resumeWorkflow(
      store,
      first.suspend!.token,
      5,
      { positive: true, replied: true /* no pain, no authority */ },
      { definition: sdrCadenceWorkflow, context: ctx, toolExecutor: noopTool },
    );

    // Qualify gate fails → Nurture:Active → workflow completes
    expect(second.status).toBe("completed");
    expect(JSON.stringify(second.output)).toContain("Active");
  });

  // -------------------------------------------------------------------------
  // 6. Deterministic guards — llmClient must NEVER be called
  // -------------------------------------------------------------------------
  it("no LLM call across the full positive → qualify → handoff path", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    let llmCalled = false;
    const ctx: AgentExecutionContext = {
      executionId: "exec-lc-6",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      conversationKey: "conv-6",
      db: {} as never,
      logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
      } as never,
      llmClient: {
        complete: async () => {
          llmCalled = true;
          return { content: "", model: "fake" };
        },
      },
    };

    const first = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-006" },
      context: ctx,
      store,
      executionId: "exec-lc-6",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    if (first.status === "suspended") {
      await resumeWorkflow(
        store,
        first.suspend!.token,
        6,
        {
          positive: true,
          replied: true,
          pain: { description: "Pain stated", evidenceType: "prospect_stated" },
          authority: { description: "I am the DM", evidenceType: "economic_buyer" },
          consequence: { description: "Costs us $50k/yr", evidenceType: "quantified_impact" },
          targetProfile: { icpMatchCount: 4, personaMatch: true },
        },
        { definition: sdrCadenceWorkflow, context: ctx, toolExecutor: noopTool },
      );
    }

    expect(llmCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 7. AE_REQUALIFY_RESUME_ON must not be in REPLY_RESUMABLE
  // -------------------------------------------------------------------------
  it("AE_REQUALIFY_RESUME_ON is not in REPLY_RESUMABLE", () => {
    expect(REPLY_RESUMABLE).not.toContain(AE_REQUALIFY_RESUME_ON);
    expect(AE_REQUALIFY_RESUME_ON).toBe("callback:ae.requalified");
  });

  // -------------------------------------------------------------------------
  // 8. Positive → qualify → handoff → AE requalification → workflow completes
  //    (regression: set-qualified must set ctx.stepOutputs["account-status"]
  //     so that touch-(N+1) isTerminal() guard fires and does NOT re-suspend
  //     with reply:inbound)
  // -------------------------------------------------------------------------
  it("AE requalification resume → workflow completes (no reply:inbound re-suspend)", async () => {
    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;
    const ctx = makeCtx(8);

    // Step 1: start → touch-1 → suspend(reply:inbound)
    const first = await runWorkflow({
      definition: sdrCadenceWorkflow,
      input: { organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", contactKey: "c-008" },
      context: ctx,
      store,
      executionId: "exec-lc-8",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(first.status).toBe("suspended");
    expect(first.suspend?.resumeOn).toBe("reply:inbound");

    // Step 2: positive reply + full PACT evidence → qualify passes → handoff → suspend(callback:ae.requalified)
    const second = await resumeWorkflow(
      store,
      first.suspend!.token,
      8,
      {
        positive: true,
        replied: true,
        pain: { description: "We lose 20 hours/week to manual reconciliation", evidenceType: "prospect_stated" },
        authority: { description: "I am the CFO and approved budget owner", evidenceType: "economic_buyer" },
        consequence: { description: "Estimated $200k/year in rework costs", evidenceType: "quantified_impact" },
        targetProfile: { icpMatchCount: 5, personaMatch: true },
      },
      { definition: sdrCadenceWorkflow, context: ctx, toolExecutor: noopTool },
    );

    expect(second.status).toBe("suspended");
    expect(second.suspend?.resumeOn).toBe(AE_REQUALIFY_RESUME_ON);

    // Step 3: AE requalification callback → workflow must COMPLETE (Qualified terminal)
    //         It must NOT re-suspend with reply:inbound (which would indicate the bug:
    //         isTerminal() returned false because account-status was never set to "Qualified")
    const third = await resumeWorkflow(
      store,
      second.suspend!.token,
      8,
      { requalified: true, organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b" },
      { definition: sdrCadenceWorkflow, context: ctx, toolExecutor: noopTool },
    );

    // Must complete — not suspend again with reply:inbound
    expect(third.status).toBe("completed");
    expect(third.suspend?.resumeOn).not.toBe("reply:inbound");
    // The account-status absorbing flag must be "Qualified"
    expect(third.stepOutputs?.["account-status"]).toBe("Qualified");
  });
});
