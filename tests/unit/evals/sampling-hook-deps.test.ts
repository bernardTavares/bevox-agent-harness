/**
 * Why this test exists
 * ====================
 *
 * `createEvalSamplingHook(deps)` accepts an optional `EvalSamplingHookDeps`
 * object that includes `queue`, `policy`, and `enabledScorers`. Today the
 * implementation in `src/runtime/hooks/eval-sampling-hook.ts` resolves the
 * queue with:
 *
 *   const queue = deps.queue ?? getEvalQueue();
 *
 * i.e. the explicit `deps.queue` override takes precedence over the
 * module-level singleton in `src/evals/registry.ts` (`setEvalQueue` /
 * `getEvalQueue`). The same pattern holds for `policy` and `enabledScorers`.
 *
 * PR 5b of the execution-handler split + DI refactor (see
 * `docs/superpowers/specs/2026-06-03-execution-handler-split-and-di-design.md`
 * §8 — locators of the hooks/evals subsystem) will move that singleton off
 * module scope and onto a per-execution `ctx.evals.queue`. When that refactor
 * lands, the contract that MUST NOT regress is:
 *
 *   When `deps.queue` is provided, `createEvalSamplingHook` enqueues into
 *   THAT queue and NEVER falls back to `getEvalQueue()`.
 *
 * If someone accidentally rewrites `run()` to fall back to the global as a
 * "defensive default" (or to dual-write), tenant isolation breaks: a test
 * setup could inject a tenant-A queue while the global still points at
 * tenant-B. This file pins the contract by:
 *
 *   1. Installing a SABOTAGE queue in the global slot via `setEvalQueue()`.
 *      Its `enqueue()` throws if called — so any code path that consults
 *      the global instead of the injected `deps.queue` fails loudly.
 *   2. Constructing the hook with a fresh mock `deps.queue`.
 *   3. Asserting the injected mock was called AND the sabotage was not.
 *
 * Sentinel guard precedes shape assertions: we first prove the injected
 * queue.enqueue was actually exercised (call count > 0), then check the
 * payload shape. That way a future "everything is undefined, every
 * assertion is vacuously true" regression cannot pass silently.
 *
 * Scope is intentionally tight — this is a regression guard for the
 * dependency-precedence contract, not a re-test of sampling semantics. The
 * broader behavioral coverage (always/never/tagged, runner-swallows-errors,
 * etc.) lives in `tests/unit/runtime/hooks/eval-sampling-hook.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvalQueue } from "../../../src/evals/eval-queue.js";
import { resetEvalRegistryForTests, setEvalQueue } from "../../../src/evals/registry.js";
import type { SamplingPolicy } from "../../../src/evals/sampler.js";
import { createEvalSamplingHook } from "../../../src/runtime/hooks/eval-sampling-hook.js";
import type { ExecutionPayload } from "../../../src/runtime/execution-handler.js";
import type { PostExecutionHookInput } from "../../../src/runtime/hooks/types.js";

const ORG_ID = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";

function makePayload(extra: Partial<ExecutionPayload> = {}): ExecutionPayload {
  return {
    execution_id: "77777777-7777-7777-7777-777777777777",
    execution_token: "x".repeat(40),
    messages: [{ role: "user", content: "Marcar consulta amanha" }],
    skills: [],
    account: { id: 99 },
    ...extra,
  } as unknown as ExecutionPayload;
}

function makeInput(overrides: Partial<PostExecutionHookInput> = {}): PostExecutionHookInput {
  return {
    payload: makePayload(),
    agentResponse: { answer: "ok, agendado para amanha 14h", strategy: "react" },
    finalResponse: "ok, agendado para amanha 14h",
    lastUserMessage: "Marcar consulta amanha",
    organizationId: ORG_ID,
    agentName: "scheduler",
    ...overrides,
  };
}

/**
 * A queue that throws on every operation. Used as the global tripwire — if
 * the hook ever falls back to `getEvalQueue()` instead of honoring
 * `deps.queue`, this surfaces the regression with a loud, named error.
 */
function makeSabotageQueue(): EvalQueue {
  return {
    name: "SABOTAGE-execution.evals",
    enqueue: vi.fn().mockImplementation(async () => {
      throw new Error(
        "REGRESSION: createEvalSamplingHook consulted the module-level " +
          "getEvalQueue() singleton instead of its injected deps.queue. " +
          "PR 5b contract violated (getEvalQueue() → ctx.evals.queue).",
      );
    }),
    close: vi.fn(),
  } as unknown as EvalQueue;
}

/**
 * A clean injectable queue with vi.fn enqueue. Distinct per test so the
 * mock.calls counter is isolated.
 */
function makeInjectedQueue(): EvalQueue {
  return {
    name: "injected-execution.evals",
    enqueue: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  } as unknown as EvalQueue;
}

describe("createEvalSamplingHook — deps.queue precedence over global (PR 5b contract)", () => {
  beforeEach(() => {
    // Plant a tripwire in the global slot. If the SUT touches it, the test fails.
    setEvalQueue(makeSabotageQueue());
  });

  afterEach(() => {
    resetEvalRegistryForTests();
    vi.clearAllMocks();
  });

  it("enqueues into deps.queue and NEVER consults getEvalQueue()", async () => {
    const depsQueue = makeInjectedQueue();
    const depsEnqueue = depsQueue.enqueue as ReturnType<typeof vi.fn>;
    const policy: SamplingPolicy = { type: "always" };

    const hook = createEvalSamplingHook({
      queue: depsQueue,
      policy,
      enabledScorers: ["no-pii"],
    });

    // If this throws, the SUT fell back to the sabotage global — that IS
    // the regression we are guarding against.
    await hook.run(makeInput());

    // ── Sentinel guard: prove the injected queue actually flowed.
    //    This must hold BEFORE any shape assertion — otherwise the test
    //    could pass vacuously if the SUT silently no-op'd.
    expect(depsEnqueue.mock.calls.length).toBeGreaterThan(0);

    // ── Shape: payload received by the injected queue carries the
    //    sampling reason from the injected policy + the org/exec metadata
    //    from the hook input.
    expect(depsEnqueue).toHaveBeenCalledTimes(1);
    const payload = depsEnqueue.mock.calls[0][0];
    expect(payload.sampling_reason).toBe("policy:always");
    expect(payload.input.meta.organization_id).toBe(ORG_ID);
    expect(payload.input.meta.execution_id).toBe(
      "77777777-7777-7777-7777-777777777777",
    );
    expect(payload.input.meta.reasoning_engine).toBe("react");
    expect(payload.input.input).toBe("Marcar consulta amanha");
    expect(payload.input.output).toBe("ok, agendado para amanha 14h");
    expect(payload.scorers_enabled).toEqual(["no-pii"]);
  });

  it("two hook instances with distinct deps.queue do not cross-contaminate via the global", async () => {
    // Tenant-A wiring.
    const queueA = makeInjectedQueue();
    const enqueueA = queueA.enqueue as ReturnType<typeof vi.fn>;
    const hookA = createEvalSamplingHook({
      queue: queueA,
      policy: { type: "always" },
      enabledScorers: ["scorer-a"],
    });

    // Tenant-B wiring — distinct queue, distinct scorers.
    const queueB = makeInjectedQueue();
    const enqueueB = queueB.enqueue as ReturnType<typeof vi.fn>;
    const hookB = createEvalSamplingHook({
      queue: queueB,
      policy: { type: "always" },
      enabledScorers: ["scorer-b"],
    });

    const inputA = makeInput({
      organizationId: "018f3a2b-aaaa-7e1f-9a2b-3c4d5e6f7a8b",
      payload: makePayload({ execution_id: "aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa" }),
    });
    const inputB = makeInput({
      organizationId: "018f3a2b-bbbb-7e1f-9a2b-3c4d5e6f7a8b",
      payload: makePayload({ execution_id: "bbbbbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb" }),
    });

    await hookA.run(inputA);
    await hookB.run(inputB);

    // ── Sentinel guard: each instance touched ONLY its own queue. The
    //    sabotage global stays untouched (else the await above threw).
    expect(enqueueA).toHaveBeenCalledTimes(1);
    expect(enqueueB).toHaveBeenCalledTimes(1);

    // ── Per-instance payloads carry the per-instance metadata unchanged
    //    — proves the deps closure, not the global, supplied the queue.
    const payloadA = enqueueA.mock.calls[0][0];
    const payloadB = enqueueB.mock.calls[0][0];

    expect(payloadA.scorers_enabled).toEqual(["scorer-a"]);
    expect(payloadB.scorers_enabled).toEqual(["scorer-b"]);

    expect(payloadA.input.meta.organization_id).toBe(
      "018f3a2b-aaaa-7e1f-9a2b-3c4d5e6f7a8b",
    );
    expect(payloadB.input.meta.organization_id).toBe(
      "018f3a2b-bbbb-7e1f-9a2b-3c4d5e6f7a8b",
    );

    // Cross-check: A's queue never saw B's execution and vice versa.
    expect(payloadA.input.meta.execution_id).toBe(
      "aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
    );
    expect(payloadB.input.meta.execution_id).toBe(
      "bbbbbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
    );
  });
});
