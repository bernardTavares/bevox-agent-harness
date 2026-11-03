import { describe, expect, it } from "vitest";

import type { AgentExecutionContext } from "../../src/agents/execution-context.js";
import { createStep, createWorkflow } from "../../src/workflow/builder.js";
import { resumeWorkflow, runWorkflow } from "../../src/workflow/engine.js";
import { WorkflowCleanupJob } from "../../src/workflow/cleanup.js";
import type { WorkflowStateStore } from "../../src/workflow/state-store.js";
import { FakeWorkflowStore } from "../fakes/workflow-store.fake.js";

function makeCtx(): AgentExecutionContext {
  const noop = () => {};
  const childLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    child: () => childLogger,
  };
  return {
    executionId: "exec-1",
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    conversationKey: "conv-1",
    db: {} as never,
    logger: childLogger as never,
    llmClient: { complete: async () => ({ content: "", model: "fake" }) },
  };
}

const noopTool = async () => ({ success: true });

describe("workflow suspend/resume integration", () => {
  it("full lifecycle: run → suspend → fake webhook resumes → completes", async () => {
    const wf = createWorkflow("book-flow", 1)
      .step(createStep("reserve", async () => ({ appointmentId: "appt-1" })))
      .step(
        createStep("wait-payment", async (_input, ctx) => {
          ctx.suspend({ resumeOn: "callback:payment.confirmed", timeoutMs: 60_000 });
        }),
      )
      .step(
        createStep("confirm", async (_input, ctx) => {
          const payload = ctx.stepOutputs["__resume__"] as { paid?: boolean } | undefined;
          if (!payload?.paid) throw new Error("not paid");
          return { confirmed: true };
        }),
      )
      .build("desc");

    const store = new FakeWorkflowStore() as unknown as WorkflowStateStore;

    const first = await runWorkflow({
      definition: wf,
      input: {},
      context: makeCtx(),
      store,
      executionId: "exec-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });
    expect(first.status).toBe("suspended");
    expect(first.suspend?.token).toBeTruthy();

    // Simulate webhook from Bevox publishing a resume event.
    const second = await resumeWorkflow(store, first.suspend!.token, "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b", { paid: true }, {
      definition: wf,
      context: makeCtx(),
      toolExecutor: noopTool,
    });

    expect(second.status).toBe("completed");
    expect(second.output).toEqual({ confirmed: true });
  });

  it("cleanup job expires zombie workflows past timeout", async () => {
    const fake = new FakeWorkflowStore();
    const wf = createWorkflow("z", 1)
      .step(
        createStep("wait", async (_input, ctx) => {
          ctx.suspend({ resumeOn: "callback:x", timeoutMs: 1 });
        }),
      )
      .build("desc");

    await runWorkflow({
      definition: wf,
      input: {},
      context: makeCtx(),
      store: fake as unknown as WorkflowStateStore,
      executionId: "exec-z",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    // Force timeout to be in the past.
    for (const row of fake.rows.values()) {
      if (row.status === "suspended") {
        row.timeoutAt = new Date(Date.now() - 1000);
      }
    }

    const job = new WorkflowCleanupJob({
      store: fake as unknown as WorkflowStateStore,
      batchSize: 10,
    });
    const expired = await job.tick();
    expect(expired).toBe(1);

    const stillSuspended = [...fake.rows.values()].filter((r) => r.status === "suspended");
    expect(stillSuspended.length).toBe(0);
  });

  it("resume with wrong organizationId fails closed", async () => {
    const fake = new FakeWorkflowStore();
    const wf = createWorkflow("acc", 1)
      .step(
        createStep("wait", async (_input, ctx) => {
          ctx.suspend({ resumeOn: "callback:x", timeoutMs: 60_000 });
        }),
      )
      .build("desc");

    const first = await runWorkflow({
      definition: wf,
      input: {},
      context: makeCtx(),
      store: fake as unknown as WorkflowStateStore,
      executionId: "exec-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    const wrong = await resumeWorkflow(
      fake as unknown as WorkflowStateStore,
      first.suspend!.token,
      "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8c", // wrong organizationId
      { paid: true },
      { definition: wf, context: makeCtx(), toolExecutor: noopTool },
    );
    expect(wrong.status).toBe("failed");
    expect(wrong.error).toContain("suspend_token not found");
  });
});
