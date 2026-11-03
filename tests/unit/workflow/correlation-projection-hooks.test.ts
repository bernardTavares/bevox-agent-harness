/**
 * Tests for correlation-projection.hook.ts
 * Verifies: hook handler maps lifecycle events → store ops correctly;
 * no-ops gracefully when organizationId/contactKey absent.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { resetHookBusForTests, getHookBus } from "../../../src/runtime/hooks/index.js";
import { makeCorrelationProjectionHandler } from "../../../src/workflow/correlation-projection.hook.js";
import type { CorrelationStore } from "../../../src/workflow/correlation-store.js";

function makeStoreMock(): CorrelationStore {
  return {
    upsertSuspended: vi.fn().mockResolvedValue(undefined),
    markRunning: vi.fn().mockResolvedValue(undefined),
    markTerminal: vi.fn().mockResolvedValue(undefined),
    resolveActive: vi.fn().mockResolvedValue(null),
    _testOnlySetAlarmFn: vi.fn(),
  } as unknown as CorrelationStore;
}

beforeEach(() => {
  resetHookBusForTests();
});

describe("makeCorrelationProjectionHandler", () => {
  it("onSuspended with organizationId+contactKey → calls upsertSuspended", async () => {
    const store = makeStoreMock();
    const handler = makeCorrelationProjectionHandler(store);
    const bus = getHookBus();
    bus.register(handler);

    await bus.emit("onSuspended", {
      executionId: "exec-1",
      workflowExecutionId: "wf-1",
      suspendToken: "tok-1",
      resumeOn: "reply:inbound",
      timeoutAt: new Date(),
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactKey: "c-100",
      workflowVersion: 1,
    });

    expect(store.upsertSuspended).toHaveBeenCalledOnce();
    expect(store.upsertSuspended).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        contactKey: "c-100",
        workflowExecutionId: "wf-1",
        suspendToken: "tok-1",
        resumeEvent: "reply:inbound",
      }),
    );
    expect(store.markRunning).not.toHaveBeenCalled();
    expect(store.markTerminal).not.toHaveBeenCalled();
  });

  it("onResumed with organizationId+contactKey → calls markRunning", async () => {
    const store = makeStoreMock();
    const handler = makeCorrelationProjectionHandler(store);
    const bus = getHookBus();
    bus.register(handler);

    await bus.emit("onResumed", {
      executionId: "exec-1",
      workflowExecutionId: "wf-1",
      suspendToken: "tok-1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactKey: "c-100",
    });

    expect(store.markRunning).toHaveBeenCalledOnce();
    expect(store.markRunning).toHaveBeenCalledWith("wf-1");
    expect(store.upsertSuspended).not.toHaveBeenCalled();
    expect(store.markTerminal).not.toHaveBeenCalled();
  });

  it("onWorkflowTerminal with organizationId+contactKey → calls markTerminal", async () => {
    const store = makeStoreMock();
    const handler = makeCorrelationProjectionHandler(store);
    const bus = getHookBus();
    bus.register(handler);

    await bus.emit("onWorkflowTerminal", {
      executionId: "exec-1",
      workflowExecutionId: "wf-1",
      status: "completed",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactKey: "c-100",
    });

    expect(store.markTerminal).toHaveBeenCalledOnce();
    expect(store.markTerminal).toHaveBeenCalledWith("wf-1", "completed");
    expect(store.upsertSuspended).not.toHaveBeenCalled();
    expect(store.markRunning).not.toHaveBeenCalled();
  });

  it("onWorkflowTerminal with failed status → calls markTerminal with failed", async () => {
    const store = makeStoreMock();
    const handler = makeCorrelationProjectionHandler(store);
    const bus = getHookBus();
    bus.register(handler);

    await bus.emit("onWorkflowTerminal", {
      executionId: "exec-1",
      workflowExecutionId: "wf-1",
      status: "failed",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactKey: "c-100",
    });

    expect(store.markTerminal).toHaveBeenCalledWith("wf-1", "failed");
  });

  describe("graceful no-op when organizationId or contactKey absent (non-SDR workflow)", () => {
    it("onSuspended missing organizationId → no-op, no throw", async () => {
      const store = makeStoreMock();
      const handler = makeCorrelationProjectionHandler(store);
      const bus = getHookBus();
      bus.register(handler);

      await expect(
        bus.emit("onSuspended", {
          executionId: "exec-1",
          workflowExecutionId: "wf-1",
          suspendToken: "tok-1",
          resumeOn: "reply:inbound",
          timeoutAt: new Date(),
          // organizationId: MISSING
          contactKey: "c-100",
        }),
      ).resolves.toBeUndefined();

      expect(store.upsertSuspended).not.toHaveBeenCalled();
    });

    it("onSuspended missing contactKey → no-op, no throw", async () => {
      const store = makeStoreMock();
      const handler = makeCorrelationProjectionHandler(store);
      const bus = getHookBus();
      bus.register(handler);

      await expect(
        bus.emit("onSuspended", {
          executionId: "exec-1",
          workflowExecutionId: "wf-1",
          suspendToken: "tok-1",
          resumeOn: "reply:inbound",
          timeoutAt: new Date(),
          organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
          // contactKey: MISSING
        }),
      ).resolves.toBeUndefined();

      expect(store.upsertSuspended).not.toHaveBeenCalled();
    });

    it("onResumed missing organizationId → no-op", async () => {
      const store = makeStoreMock();
      const handler = makeCorrelationProjectionHandler(store);
      const bus = getHookBus();
      bus.register(handler);

      await bus.emit("onResumed", {
        executionId: "exec-1",
        workflowExecutionId: "wf-1",
        suspendToken: "tok-1",
        // organizationId: MISSING
        contactKey: "c-100",
      });

      expect(store.markRunning).not.toHaveBeenCalled();
    });

    it("onWorkflowTerminal missing contactKey → no-op", async () => {
      const store = makeStoreMock();
      const handler = makeCorrelationProjectionHandler(store);
      const bus = getHookBus();
      bus.register(handler);

      await bus.emit("onWorkflowTerminal", {
        executionId: "exec-1",
        workflowExecutionId: "wf-1",
        status: "completed",
        organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        // contactKey: MISSING
      });

      expect(store.markTerminal).not.toHaveBeenCalled();
    });
  });
});
