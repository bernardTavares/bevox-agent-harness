/**
 * Regression guard: `src/workflow/engine.ts` emits lifecycle events via the
 * runtime HookBus (`getHookBus().emit(...)`) at every documented transition
 * (`onSuspended`, `onResumed`, `onWorkflowTerminal:{completed,failed}`).
 *
 * Why this test exists
 * --------------------
 * The PR 4 refactor of coverage-uplift will migrate `getHookBus()` (process
 * singleton) to `ctx.hookBus` (per-execution bus injected via the agent
 * execution context). The engine's only observable contract with the rest
 * of the runtime — beyond persisting rows in the WorkflowStateStore — is
 * the bus emission. If a future change silently drops the `await
 * getHookBus().emit(...)` call (or fails to wire `ctx.hookBus`), every
 * downstream projection (`correlation-projection.hook.ts`, scheduler
 * telemetry, future SDR cadence projections, …) silently goes dark. The
 * existing `engine.test.ts` only exercises persistence + return values; it
 * happily passes with the bus removed.
 *
 * Sentinel-guard pattern (per Task 6 reviewer)
 * --------------------------------------------
 * Each `it` asserts `emitCount > 0` BEFORE asserting per-event shape, so
 * the test fails loudly (not vacuously) if the engine's bus call is ever
 * removed or unwired.
 *
 * Event catalogue policy
 * ----------------------
 * Test pins ONE canonical event per lifecycle transition (the smallest
 * mandatory surface needed for the C.3 correlation projection to function):
 *   - suspend  → `onSuspended` with `{ executionId, workflowExecutionId,
 *                  suspendToken, resumeOn, organizationId, workflowVersion }`
 *   - resume   → `onResumed`   with `{ executionId, workflowExecutionId,
 *                  suspendToken, organizationId }`
 *   - complete → `onWorkflowTerminal` with `status: "completed"`
 *   - fail     → `onWorkflowTerminal` with `status: "failed"`
 * Additional fields (e.g. `contactKey`, `timeoutAt`) are allowed-but-not-
 * required so the engine can grow the payload without breaking this guard.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import {
  type ExecutionLifecycleEvents,
  type LifecyclePayload,
  getHookBus,
  resetHookBusForTests,
} from "../../../src/runtime/hooks/index.js";
import { createStep, createWorkflow } from "../../../src/workflow/builder.js";
import { resumeWorkflow, runWorkflow } from "../../../src/workflow/engine.js";
import type { WorkflowStateStore } from "../../../src/workflow/state-store.js";
import { FakeWorkflowStore } from "../../fakes/workflow-store.fake.js";

// ---------------------------------------------------------------------------
// Test constants — kept local (not in invariant-harness) because the workflow
// engine path doesn't share the handleExecution stub surface. The UUIDv7 below
// matches the value `engine.test.ts` already uses so anyone grepping for
// "organizationId in workflow tests" lands on a single canonical literal.
// ---------------------------------------------------------------------------
const ORG_ID = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";
const EXEC_ID = "exec-hook-bus";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): AgentExecutionContext {
  return {
    executionId: EXEC_ID,
    organizationId: ORG_ID,
    conversationKey: "conv-hook-bus",
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

/**
 * Record every event emitted on the bus, with the event name and payload.
 * Returned `events` array is the sentinel-guard target: `events.length > 0`
 * proves the engine actually called `bus.emit(...)`.
 */
interface RecordedEvent {
  readonly event: keyof ExecutionLifecycleEvents;
  readonly payload: LifecyclePayload;
}

function makeRecorder(): {
  handler: ExecutionLifecycleEvents;
  events: RecordedEvent[];
} {
  const events: RecordedEvent[] = [];
  const record =
    (event: keyof ExecutionLifecycleEvents) => async (payload: LifecyclePayload) => {
      events.push({ event, payload });
    };
  const handler: ExecutionLifecycleEvents = {
    onSuspended: record("onSuspended"),
    onResumed: record("onResumed"),
    onWorkflowTerminal: record("onWorkflowTerminal"),
    onWorkflowStatusChange: record("onWorkflowStatusChange"),
  };
  return { handler, events };
}

function only(events: RecordedEvent[], name: keyof ExecutionLifecycleEvents): RecordedEvent[] {
  return events.filter((e) => e.event === name);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("workflow engine HookBus emission (regression guard)", () => {
  beforeEach(() => {
    // Isolate from any prior test's registrations — without this, a global
    // handler from another suite could swallow the events we want to see and
    // make us think the engine isn't emitting.
    resetHookBusForTests();
  });

  it("emits onSuspended via the HookBus when a step calls ctx.suspend()", async () => {
    const { handler, events } = makeRecorder();
    getHookBus().register(handler);

    const wf = createWorkflow("hook-bus-suspend")
      .step(
        createStep("wait", async (_input, ctx) => {
          ctx.suspend({ resumeOn: "callback:hook-bus-test", timeoutMs: 60_000 });
        }),
      )
      .build("hook-bus suspend regression guard");

    const store = new FakeWorkflowStore();
    const res = await runWorkflow({
      definition: wf,
      input: null,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: EXEC_ID,
      organizationId: ORG_ID,
      toolExecutor: noopTool,
    });

    // Engine must reach the suspended state...
    expect(res.status).toBe("suspended");
    expect(res.suspend?.token).toBeTruthy();

    // ...AND the bus must have fired. The sentinel guard: if a refactor
    // dropped `getHookBus().emit("onSuspended", …)` from `persistSuspend`,
    // this fails before we even inspect the payload.
    expect(events.length).toBeGreaterThan(0);

    const suspended = only(events, "onSuspended");
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.payload).toMatchObject({
      executionId: EXEC_ID,
      workflowExecutionId: expect.any(String),
      suspendToken: res.suspend!.token,
      resumeOn: "callback:hook-bus-test",
      organizationId: ORG_ID,
      workflowVersion: wf.version,
    });
  });

  it("emits onResumed via the HookBus after a successful claimForResume", async () => {
    const { handler, events } = makeRecorder();
    getHookBus().register(handler);

    const wf = createWorkflow("hook-bus-resume")
      .step(createStep("pre", async () => ({ ok: true })))
      .step(
        createStep("wait", async (_input, ctx) => {
          ctx.suspend({ resumeOn: "callback:hook-bus-test", timeoutMs: 60_000 });
        }),
      )
      .step(createStep("post", async (input) => input))
      .build("hook-bus resume regression guard");

    const store = new FakeWorkflowStore();
    const ctx = makeCtx();
    const first = await runWorkflow({
      definition: wf,
      input: null,
      context: ctx,
      store: store as unknown as WorkflowStateStore,
      executionId: EXEC_ID,
      organizationId: ORG_ID,
      toolExecutor: noopTool,
    });
    expect(first.status).toBe("suspended");

    const resumed = await resumeWorkflow(
      store as unknown as WorkflowStateStore,
      first.suspend!.token,
      ORG_ID,
      { resumed: true },
      {
        definition: wf,
        context: ctx,
        toolExecutor: noopTool,
      },
    );
    expect(resumed.status).toBe("completed");

    // Sentinel guard.
    expect(events.length).toBeGreaterThan(0);

    const onResumed = only(events, "onResumed");
    expect(onResumed).toHaveLength(1);
    expect(onResumed[0]!.payload).toMatchObject({
      executionId: EXEC_ID,
      workflowExecutionId: first.workflowExecutionId,
      suspendToken: first.suspend!.token,
      organizationId: ORG_ID,
    });
  });

  it("emits onWorkflowTerminal with status='completed' on successful run", async () => {
    const { handler, events } = makeRecorder();
    getHookBus().register(handler);

    const wf = createWorkflow("hook-bus-complete")
      .step(createStep("only", async () => "done"))
      .build("hook-bus complete regression guard");

    const store = new FakeWorkflowStore();
    const res = await runWorkflow({
      definition: wf,
      input: null,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: EXEC_ID,
      organizationId: ORG_ID,
      toolExecutor: noopTool,
    });

    expect(res.status).toBe("completed");

    // Sentinel guard.
    expect(events.length).toBeGreaterThan(0);

    const terminal = only(events, "onWorkflowTerminal");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.payload).toMatchObject({
      executionId: EXEC_ID,
      workflowExecutionId: res.workflowExecutionId,
      status: "completed",
      organizationId: ORG_ID,
    });
  });

  it("emits onWorkflowTerminal with status='failed' when a step throws", async () => {
    const { handler, events } = makeRecorder();
    getHookBus().register(handler);

    const wf = createWorkflow("hook-bus-fail")
      .step(
        createStep("boom", async () => {
          throw new Error("kaboom");
        }),
      )
      .build("hook-bus fail regression guard");

    const store = new FakeWorkflowStore();
    const res = await runWorkflow({
      definition: wf,
      input: null,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: EXEC_ID,
      organizationId: ORG_ID,
      toolExecutor: noopTool,
    });

    expect(res.status).toBe("failed");
    expect(res.error).toContain("kaboom");

    // Sentinel guard.
    expect(events.length).toBeGreaterThan(0);

    const terminal = only(events, "onWorkflowTerminal");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.payload).toMatchObject({
      executionId: EXEC_ID,
      workflowExecutionId: res.workflowExecutionId,
      status: "failed",
      organizationId: ORG_ID,
    });
  });

  it("fans out to every registered handler (multi-subscriber contract)", async () => {
    // Documents the contract that PR 4's `ctx.hookBus` must preserve: every
    // registered handler receives every emission. If the future bus
    // accidentally implements last-writer-wins, this test catches it.
    const a = makeRecorder();
    const b = makeRecorder();
    getHookBus().register(a.handler);
    getHookBus().register(b.handler);

    const wf = createWorkflow("hook-bus-fanout")
      .step(createStep("only", async () => "ok"))
      .build("hook-bus fanout regression guard");

    const store = new FakeWorkflowStore();
    await runWorkflow({
      definition: wf,
      input: null,
      context: makeCtx(),
      store: store as unknown as WorkflowStateStore,
      executionId: EXEC_ID,
      organizationId: ORG_ID,
      toolExecutor: noopTool,
    });

    // Sentinel guard on BOTH recorders — if either is empty, the bus dropped
    // a subscriber.
    expect(a.events.length).toBeGreaterThan(0);
    expect(b.events.length).toBeGreaterThan(0);

    expect(only(a.events, "onWorkflowTerminal")).toHaveLength(1);
    expect(only(b.events, "onWorkflowTerminal")).toHaveLength(1);
  });
});
