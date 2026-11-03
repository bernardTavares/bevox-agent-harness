import { describe, expect, it } from "vitest";

import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import { createStep, createWorkflow } from "../../../src/workflow/builder.js";
import { resumeWorkflow, runWorkflow } from "../../../src/workflow/engine.js";
import type { WorkflowStateStore } from "../../../src/workflow/state-store.js";
import { FakeWorkflowStore } from "../../fakes/workflow-store.fake.js";

function makeCtx(): AgentExecutionContext {
  return {
    executionId: "exec-1",
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    conversationKey: "conv-1",
    db: {} as never,
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
      }),
    } as never,
    llmClient: { complete: async () => ({ content: "", model: "fake" }) },
  };
}

const noopTool = async () => ({ success: true });

describe("runWorkflow", () => {
  it("runs sequential steps to completion", async () => {
    const wf = createWorkflow("seq")
      .step(createStep("add", async (input: number) => input + 1))
      .step(createStep("mul", async (input: number) => input * 10))
      .build("desc");

    const store = new FakeWorkflowStore();
    const res = await runWorkflow({
      definition: wf,
      input: 1,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: "exec-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(res.status).toBe("completed");
    expect(res.output).toBe(20);
    expect(res.stepOutputs).toMatchObject({ add: 2, mul: 20 });
  });

  it("captures step errors as status=failed", async () => {
    const wf = createWorkflow("err")
      .step(createStep("bad", async () => {
        throw new Error("boom");
      }))
      .build("desc");

    const store = new FakeWorkflowStore();
    const res = await runWorkflow({
      definition: wf,
      input: null,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: "exec-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(res.status).toBe("failed");
    expect(res.error).toContain("boom");
  });

  it("retries with backoff and succeeds on second attempt", async () => {
    let calls = 0;
    const wf = createWorkflow("retry")
      .step(
        createStep("flaky", async () => {
          calls++;
          if (calls < 2) throw new Error("transient");
          return "ok";
        }, { retry: { maxAttempts: 3, baseDelayMs: 1 } }),
      )
      .build("desc");

    const store = new FakeWorkflowStore();
    const res = await runWorkflow({
      definition: wf,
      input: null,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: "exec-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(calls).toBe(2);
    expect(res.status).toBe("completed");
  });

  it("branch picks the truthy arm", async () => {
    const wf = createWorkflow("br")
      .step(createStep("seed", async () => "in"))
      .branch(
        "pick",
        () => true,
        [createStep("t1", async () => "T")],
        [createStep("f1", async () => "F")],
      )
      .build("desc");

    const store = new FakeWorkflowStore();
    const res = await runWorkflow({
      definition: wf,
      input: null,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: "exec-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(res.status).toBe("completed");
    expect(res.stepOutputs["t1"]).toBe("T");
    expect(res.stepOutputs["f1"]).toBeUndefined();
  });

  it("parallel returns array of results", async () => {
    const wf = createWorkflow("par")
      .parallel("p", [
        createStep("a", async () => 1),
        createStep("b", async () => 2),
      ])
      .build("desc");

    const store = new FakeWorkflowStore();
    const res = await runWorkflow({
      definition: wf,
      input: null,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: "exec-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(res.status).toBe("completed");
    expect(res.stepOutputs["p"]).toEqual([1, 2]);
  });

  it("suspend/resume round-trips through the store", async () => {
    const wf = createWorkflow("susp")
      .step(createStep("pre", async () => ({ ok: true })))
      .step(
        createStep("wait", async (_input, ctx) => {
          ctx.suspend({ resumeOn: "callback:test", timeoutMs: 60_000 });
        }),
      )
      .step(
        createStep("post", async (_input, ctx) => {
          return ctx.stepOutputs["__resume__"];
        }),
      )
      .build("desc");

    const store = new FakeWorkflowStore();
    const ctx = makeCtx();
    const first = await runWorkflow({
      definition: wf,
      input: null,
      context: ctx,
      store: store as unknown as WorkflowStateStore,
      executionId: "exec-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(first.status).toBe("suspended");
    expect(first.suspend?.token).toBeTruthy();
    expect(first.suspend?.resumeOn).toBe("callback:test");

    const resumed = await resumeWorkflow(
      store as unknown as WorkflowStateStore,
      first.suspend!.token,
      "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      { paid: true },
      {
        definition: wf,
        context: ctx,
        toolExecutor: noopTool,
      },
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.output).toEqual({ paid: true });
  });

  it("loadBySuspendToken requires matching organizationId (anti-enumeration)", async () => {
    const wf = createWorkflow("susp2")
      .step(
        createStep("wait", async (_input, ctx) => {
          ctx.suspend({ resumeOn: "x", timeoutMs: 1000 });
        }),
      )
      .build("desc");

    const store = new FakeWorkflowStore();
    const res = await runWorkflow({
      definition: wf,
      input: null,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: "exec-2",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      toolExecutor: noopTool,
    });

    expect(res.status).toBe("suspended");

    // Wrong account should NOT find the row.
    const wrong = await store.loadBySuspendToken(res.suspend!.token, "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8c");
    expect(wrong).toBeNull();

    // Correct account does.
    const correct = await store.loadBySuspendToken(res.suspend!.token, "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
    expect(correct).not.toBeNull();
  });
});
