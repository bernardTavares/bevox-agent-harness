import { describe, expect, it } from "vitest";

import { emptyState } from "../../../src/workflow/types.js";
import { FakeWorkflowStore } from "../../fakes/workflow-store.fake.js";

describe("WorkflowStateStore (Fake)", () => {
  it("creates and loads a row", async () => {
    const store = new FakeWorkflowStore();
    const id = await store.create({
      executionId: "e1",
      workflowId: "foo",
      workflowVersion: 1,
      accountId: 42,
      status: "running",
      state: emptyState(),
      currentStep: "a",
      suspendToken: null,
      suspendReason: null,
      resumeEvent: null,
      resumePayload: null,
      timeoutAt: null,
      error: null,
    });
    const row = await store.load(id);
    expect(row?.workflowId).toBe("foo");
  });

  it("listExpired returns only suspended + past timeout", async () => {
    const store = new FakeWorkflowStore();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    await store.create({
      executionId: "e1",
      workflowId: "foo",
      workflowVersion: 1,
      accountId: 1,
      status: "suspended",
      state: emptyState(),
      currentStep: null,
      suspendToken: "tok-past",
      suspendReason: null,
      resumeEvent: null,
      resumePayload: null,
      timeoutAt: past,
      error: null,
    });
    await store.create({
      executionId: "e2",
      workflowId: "foo",
      workflowVersion: 1,
      accountId: 1,
      status: "suspended",
      state: emptyState(),
      currentStep: null,
      suspendToken: "tok-future",
      suspendReason: null,
      resumeEvent: null,
      resumePayload: null,
      timeoutAt: future,
      error: null,
    });
    await store.create({
      executionId: "e3",
      workflowId: "foo",
      workflowVersion: 1,
      accountId: 1,
      status: "completed",
      state: emptyState(),
      currentStep: null,
      suspendToken: null,
      suspendReason: null,
      resumeEvent: null,
      resumePayload: null,
      timeoutAt: past,
      error: null,
    });

    const expired = await store.listExpired(new Date(), 10);
    expect(expired.map((r) => r.suspendToken)).toEqual(["tok-past"]);
  });

  it("listActiveVersions filters by status IN (running, suspended)", async () => {
    const store = new FakeWorkflowStore();
    await store.create({
      executionId: "e1",
      workflowId: "foo",
      workflowVersion: 1,
      accountId: 1,
      status: "running",
      state: emptyState(),
      currentStep: null,
      suspendToken: null,
      suspendReason: null,
      resumeEvent: null,
      resumePayload: null,
      timeoutAt: null,
      error: null,
    });
    await store.create({
      executionId: "e2",
      workflowId: "foo",
      workflowVersion: 2,
      accountId: 1,
      status: "completed",
      state: emptyState(),
      currentStep: null,
      suspendToken: null,
      suspendReason: null,
      resumeEvent: null,
      resumePayload: null,
      timeoutAt: null,
      error: null,
    });
    const versions = await store.listActiveVersions("foo");
    expect(versions).toEqual([1]);
  });
});
