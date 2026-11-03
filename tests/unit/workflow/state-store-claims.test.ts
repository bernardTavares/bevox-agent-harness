import { describe, expect, it } from "vitest";

import { emptyState, type WorkflowState } from "../../../src/workflow/types.js";
import { FakeWorkflowStore } from "../../fakes/workflow-store.fake.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBase() {
  return {
    executionId: "e1",
    workflowId: "foo",
    workflowVersion: 1,
    accountId: 42,
    state: emptyState(),
    currentStep: "wait",
    suspendToken: "tok-abc",
    suspendReason: null,
    resumeEvent: "callback:x",
    resumePayload: null,
    error: null,
  } as const;
}

// ---------------------------------------------------------------------------
// claimForResume
// ---------------------------------------------------------------------------

describe("FakeWorkflowStore.claimForResume", () => {
  it("returns true and transitions row when status=suspended + token matches", async () => {
    const store = new FakeWorkflowStore();
    const past = new Date(Date.now() + 60_000); // not expired
    const id = await store.create({
      ...makeBase(),
      status: "suspended",
      timeoutAt: past,
    });

    const result = await store.claimForResume(id, "tok-abc", {
      state: emptyState(),
      resumePayload: null,
    });

    expect(result).toBe(true);
    const row = await store.load(id);
    expect(row?.status).toBe("running");
    expect(row?.suspendToken).toBeNull();
    expect(row?.lockVersion).toBeGreaterThanOrEqual(1);
  });

  it("returns false and leaves row unchanged when status is already running (race)", async () => {
    const store = new FakeWorkflowStore();
    const id = await store.create({
      ...makeBase(),
      status: "running",
      suspendToken: null,
      timeoutAt: null,
    });

    const rowBefore = await store.load(id);
    const result = await store.claimForResume(id, "tok-abc", {
      state: emptyState(),
      resumePayload: null,
    });

    expect(result).toBe(false);
    const rowAfter = await store.load(id);
    // Row must be identical — no mutation
    expect(rowAfter?.status).toBe("running");
    expect(rowAfter?.lockVersion).toBe(rowBefore?.lockVersion);
  });

  it("returns false when token does not match", async () => {
    const store = new FakeWorkflowStore();
    const id = await store.create({
      ...makeBase(),
      status: "suspended",
      timeoutAt: new Date(Date.now() + 60_000),
    });

    const result = await store.claimForResume(id, "WRONG-TOKEN", {
      state: emptyState(),
      resumePayload: null,
    });

    expect(result).toBe(false);
    const row = await store.load(id);
    expect(row?.status).toBe("suspended"); // unchanged
  });

  it("atomically writes state+resumePayload+clears suspend_reason/resume_event/timeout_at in one call", async () => {
    const store = new FakeWorkflowStore();
    const id = await store.create({
      ...makeBase(),
      status: "suspended",
      suspendReason: "callback:x",
      resumeEvent: "callback:x",
      timeoutAt: new Date(Date.now() + 60_000),
    });

    const newState: WorkflowState = { ...emptyState(), cursor: 1, stepOutputs: { wait: "done" } };
    const newPayload = { ack: true };

    const result = await store.claimForResume(id, "tok-abc", {
      state: newState,
      resumePayload: newPayload,
    });

    expect(result).toBe(true);
    const row = await store.load(id);
    expect(row?.status).toBe("running");
    expect(row?.suspendToken).toBeNull();
    // Full patch written atomically
    expect(row?.state).toEqual(newState);
    expect(row?.resumePayload).toEqual(newPayload);
    expect(row?.suspendReason).toBeNull();
    expect(row?.resumeEvent).toBeNull();
    expect(row?.timeoutAt).toBeNull();
    expect(row?.lockVersion).toBeGreaterThanOrEqual(1);
  });

  it("does NOT partially write on lost race — state unchanged when token mismatches", async () => {
    const store = new FakeWorkflowStore();
    const originalState = emptyState();
    const id = await store.create({
      ...makeBase(),
      status: "suspended",
      suspendReason: "callback:x",
      resumeEvent: "callback:x",
      timeoutAt: new Date(Date.now() + 60_000),
      state: originalState,
    });

    const newState: WorkflowState = { ...emptyState(), cursor: 5, stepOutputs: { x: "changed" } };
    const result = await store.claimForResume(id, "WRONG-TOKEN", {
      state: newState,
      resumePayload: { ack: true },
    });

    expect(result).toBe(false);
    const row = await store.load(id);
    // No partial write — state must remain original
    expect(row?.state).toEqual(originalState);
    expect(row?.suspendReason).toBe("callback:x");
    expect(row?.resumeEvent).toBe("callback:x");
    expect(row?.timeoutAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// claimForExpiry
// ---------------------------------------------------------------------------

describe("FakeWorkflowStore.claimForExpiry", () => {
  it("returns true and marks row failed when suspended + timeout_at <= now", async () => {
    const store = new FakeWorkflowStore();
    const past = new Date(Date.now() - 1_000);
    const id = await store.create({
      ...makeBase(),
      status: "suspended",
      timeoutAt: past,
    });

    const result = await store.claimForExpiry(id);

    expect(result).toBe(true);
    const row = await store.load(id);
    expect(row?.status).toBe("failed");
    expect(row?.suspendToken).toBeNull();
    expect(row?.lockVersion).toBeGreaterThanOrEqual(1);
  });

  it("returns false when row was already resumed (status=running) — does NOT clobber", async () => {
    const store = new FakeWorkflowStore();
    const past = new Date(Date.now() - 1_000);
    const id = await store.create({
      ...makeBase(),
      status: "running",
      suspendToken: null,
      timeoutAt: past,
    });

    const result = await store.claimForExpiry(id);

    expect(result).toBe(false);
    const row = await store.load(id);
    // Must NOT have been flipped to failed
    expect(row?.status).toBe("running");
  });

  it("returns false when timeout_at is in the future", async () => {
    const store = new FakeWorkflowStore();
    const future = new Date(Date.now() + 60_000);
    const id = await store.create({
      ...makeBase(),
      status: "suspended",
      timeoutAt: future,
    });

    const result = await store.claimForExpiry(id);

    expect(result).toBe(false);
    const row = await store.load(id);
    expect(row?.status).toBe("suspended");
  });

  it("returns false when timeout_at is null", async () => {
    const store = new FakeWorkflowStore();
    const id = await store.create({
      ...makeBase(),
      status: "suspended",
      timeoutAt: null,
    });

    const result = await store.claimForExpiry(id);

    expect(result).toBe(false);
    const row = await store.load(id);
    expect(row?.status).toBe("suspended");
  });
});

// ---------------------------------------------------------------------------
// update() bumps lock_version
// ---------------------------------------------------------------------------

describe("FakeWorkflowStore.update bumps lockVersion", () => {
  it("increments lockVersion on each update call", async () => {
    const store = new FakeWorkflowStore();
    const id = await store.create({
      ...makeBase(),
      status: "running",
      timeoutAt: null,
    });

    const before = await store.load(id);
    expect(before?.lockVersion).toBe(0);

    await store.update(id, { status: "running" }); // any patch
    const after1 = await store.load(id);
    expect(after1?.lockVersion).toBe(1);

    await store.update(id, { status: "running" });
    const after2 = await store.load(id);
    expect(after2?.lockVersion).toBe(2);
  });
});
