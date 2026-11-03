/**
 * Race condition tests for resume/cleanup guarded claims (Fase C §4.2, CF3).
 *
 * Uses FakeWorkflowStore (no DB required). Covers three scenarios:
 *
 *   Race A — resume wins: cleanup's tick() lists an expired row, but by the
 *             time it writes, resume has already claimed it. With the guarded
 *             claimForExpiry, the tick skips the row silently and the workflow
 *             stays completed (not failed). With a bare store.update() the row
 *             would be clobbered to failed — this test catches that regression.
 *
 *   Race B — cleanup wins: claimForExpiry claims the row first; a subsequent
 *             resumeWorkflow call for the same token → claimForResume returns
 *             false → engine BAILS (no executeFrom, no double-execute).
 *
 *   Idempotent preserved — resuming a row that is already 'running' still hits
 *             the pre-existing early-return (status≠'suspended') AHEAD of the
 *             claim; no state change, no claim, lock_version unchanged.
 */

import { describe, expect, it } from "vitest";

import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import { createStep, createWorkflow } from "../../../src/workflow/builder.js";
import { WorkflowCleanupJob } from "../../../src/workflow/cleanup.js";
import { resumeWorkflow, runWorkflow } from "../../../src/workflow/engine.js";
import { getHookBus, resetHookBusForTests } from "../../../src/runtime/hooks/index.js";
import type { WorkflowStateStore } from "../../../src/workflow/state-store.js";
import { FakeWorkflowStore } from "../../fakes/workflow-store.fake.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(executionId = "exec-race"): AgentExecutionContext {
  const noop = () => {};
  const childLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    child: () => childLogger,
  };
  return {
    executionId,
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    conversationKey: "conv-race",
    db: {} as never,
    logger: childLogger as never,
    llmClient: { complete: async () => ({ content: "", model: "fake" }) },
  };
}

const noopTool = async () => ({ success: true });

/** Build a one-step suspend workflow, run it, and return {store, token, fake, wf}. */
async function buildSuspendedWorkflow(label: string) {
  const fake = new FakeWorkflowStore();
  const store = fake as unknown as WorkflowStateStore;

  const wf = createWorkflow(`race-wf-${label}`, 1)
    .step(
      createStep("wait", async (_input, ctx) => {
        ctx.suspend({ resumeOn: `callback:${label}`, timeoutMs: 1 });
      }),
    )
    .step(createStep("done", async () => ({ finished: true })))
    .build("race test workflow");

  const result = await runWorkflow({
    definition: wf,
    input: {},
    context: makeCtx(),
    store,
    executionId: `exec-${label}`,
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    toolExecutor: noopTool,
  });

  expect(result.status).toBe("suspended");
  const token = result.suspend!.token;

  // Force timeoutAt into the past so listExpired / claimForExpiry see it as expired.
  for (const row of fake.rows.values()) {
    if (row.status === "suspended") {
      row.timeoutAt = new Date(Date.now() - 5_000);
    }
  }

  return { fake, store, wf, token };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("resume-vs-cleanup race (guarded claims)", () => {
  /**
   * Race A — resume wins.
   *
   * Interleaving we must close:
   *   1. cleanup.tick() calls listExpired → returns the suspended row.
   *   2. (race!) resumeWorkflow runs to completion — row is now 'completed'.
   *   3. cleanup.tick() calls the write-back for that row.
   *
   * With bare store.update(), step 3 silently clobbers completed → failed.
   * With store.claimForExpiry(), step 3 returns false → skipped → stays completed.
   *
   * We simulate by subclassing FakeWorkflowStore to inject a resume call between
   * listExpired and the subsequent write, then confirming the row ends completed.
   */
  it("Race A — resume wins: cleanup tick is a no-op after resume claims", async () => {
    const { fake, store, wf, token } = await buildSuspendedWorkflow("race-a");

    let resumeDone = false;

    // Wrap claimForExpiry to inject the resume after listExpired but before the
    // guarded write — this is the exact interleaving we are guarding against.
    const originalClaimForExpiry = fake.claimForExpiry.bind(fake);
    fake.claimForExpiry = async (id: string, error?: unknown) => {
      if (!resumeDone) {
        resumeDone = true;
        // Resume claims the row while cleanup is "about to write".
        const resumeResult = await resumeWorkflow(store, token, "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", { ack: true }, {
          definition: wf,
          context: makeCtx(),
          toolExecutor: noopTool,
        });
        expect(resumeResult.status).toBe("completed");
      }
      return originalClaimForExpiry(id, error);
    };

    // Now run the cleanup tick — it will interleave with the injected resume.
    const job = new WorkflowCleanupJob({ store, batchSize: 10 });
    const expired = await job.tick();

    // cleanup.tick() found 1 expired row but claimForExpiry returned false (lost race).
    // tick() must return the count from listExpired (1), but the row must NOT be failed.
    expect(expired).toBe(1);

    // THE CRITICAL ASSERTION: workflow must stay completed, not get clobbered to failed.
    const rows = [...fake.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("completed");
  });

  /**
   * Race B — cleanup wins.
   *
   * Cleanup calls tick() → claims expiry (suspended→failed).
   * resumeWorkflow is then called for the same token → claimForResume returns false
   * (status≠suspended) → engine BAILS with a no-op result.
   * No additional state mutations; no executeFrom; lock_version unchanged after bail.
   */
  it("Race B — cleanup wins: resumeWorkflow bails with no-op, no double-execute", async () => {
    const { fake, store, wf, token } = await buildSuspendedWorkflow("race-b");

    const rowId = [...fake.rows.keys()][0]!;

    // Cleanup tick runs first.
    const job = new WorkflowCleanupJob({ store, batchSize: 10 });
    const expired = await job.tick();
    expect(expired).toBe(1);
    expect(fake.rows.get(rowId)!.status).toBe("failed");

    const lockVersionAfterCleanup = fake.rows.get(rowId)!.lockVersion;

    // Track executeFrom via step execution.
    let doneStepExecutions = 0;
    const wfWithSpy = createWorkflow(`race-wf-race-b`, 1)
      .step(
        createStep("wait", async (_input, ctx) => {
          ctx.suspend({ resumeOn: "callback:race-b", timeoutMs: 1 });
        }),
      )
      .step(
        createStep("done", async () => {
          doneStepExecutions++;
          return { finished: true };
        }),
      )
      .build("race test workflow");

    // Resume attempt after cleanup claimed the row.
    // claimForExpiry cleared the suspend_token → loadBySuspendToken returns null →
    // engine returns failed/no-op early (before reaching claimForResume).
    const resumeResult = await resumeWorkflow(store, token, "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", { ack: true }, {
      definition: wfWithSpy,
      context: makeCtx(),
      toolExecutor: noopTool,
    });

    // Must NOT have proceeded to executeFrom.
    expect(doneStepExecutions).toBe(0);

    // Result reflects terminal/no-op — not running, not completed.
    expect(resumeResult.status).not.toBe("running");
    expect(resumeResult.status).not.toBe("completed");

    // No further state mutation after cleanup's claim.
    const lockVersionAfterResume = fake.rows.get(rowId)!.lockVersion;
    expect(lockVersionAfterResume).toBe(lockVersionAfterCleanup);
  });

  /**
   * Race B (onResumed timing) — on the lost-race bail path NO onResumed fires;
   * on the win path onResumed fires exactly once AFTER the claim succeeds.
   */
  it("onResumed fires exactly once AFTER claim on win path, NOT at all on bail path", async () => {
    // ── Win path ────────────────────────────────────────────────────────────
    {
      resetHookBusForTests();
      const { fake, store, wf, token } = await buildSuspendedWorkflow("onresumed-win");
      const rowId = [...fake.rows.keys()][0]!;

      const onResumedEvents: { claimDoneAtEmit: boolean }[] = [];
      getHookBus().register({
        onResumed: () => {
          const row = fake.rows.get(rowId);
          onResumedEvents.push({ claimDoneAtEmit: row?.status === "running" });
        },
      });

      await resumeWorkflow(store, token, "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", { ack: true }, {
        definition: wf,
        context: makeCtx("exec-onresumed-win"),
        toolExecutor: noopTool,
      });

      expect(onResumedEvents).toHaveLength(1);
      // Must have fired AFTER the claim (row already 'running' at emit time)
      expect(onResumedEvents[0]!.claimDoneAtEmit).toBe(true);
    }

    // ── Bail path ───────────────────────────────────────────────────────────
    {
      resetHookBusForTests();
      const { fake, store, wf, token } = await buildSuspendedWorkflow("onresumed-bail");

      // Make the row look 'running' so the idempotent early-return fires
      // (status !== 'suspended') — onResumed must NOT be emitted.
      for (const [id, row] of fake.rows.entries()) {
        if (row.status === "suspended") {
          // Preserve suspend_token so loadBySuspendToken still finds it but
          // status is NOT 'suspended' → early-return fires, no claim attempted.
          fake.rows.set(id, { ...row, status: "running" });
        }
      }

      let onResumedCount = 0;
      getHookBus().register({ onResumed: () => { onResumedCount++; } });

      await resumeWorkflow(store, token, "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", { ack: true }, {
        definition: wf,
        context: makeCtx("exec-onresumed-bail"),
        toolExecutor: noopTool,
      });

      expect(onResumedCount).toBe(0);
    }
  });

  /**
   * Idempotent preserved: resuming a row that is already 'running' hits the
   * pre-existing early-return (status≠'suspended') BEFORE the claim.
   * No state changes, no claim, lock_version unchanged.
   */
  it("Idempotent preserved: resuming a running row hits early-return before claim", async () => {
    const { fake, store, wf, token } = await buildSuspendedWorkflow("idempotent");

    // Force the row to 'running' (simulate a concurrent resume that already won).
    for (const [id, row] of fake.rows.entries()) {
      if (row.status === "suspended") {
        // Keep the suspendToken so loadBySuspendToken still finds it.
        fake.rows.set(id, { ...row, status: "running" });
      }
    }

    const lockVersionBefore = [...fake.rows.values()][0]!.lockVersion;

    // Resume attempt — must hit the idempotent early-return (status≠'suspended').
    const result = await resumeWorkflow(store, token, "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", { ack: true }, {
      definition: wf,
      context: makeCtx(),
      toolExecutor: noopTool,
    });

    // Idempotent result: returns current status without executing.
    expect(result.status).toBe("running");
    expect(result.workflowExecutionId).toBeTruthy();

    // No state change — lock_version must be unchanged.
    const lockVersionAfter = [...fake.rows.values()][0]!.lockVersion;
    expect(lockVersionAfter).toBe(lockVersionBefore);
  });
});
