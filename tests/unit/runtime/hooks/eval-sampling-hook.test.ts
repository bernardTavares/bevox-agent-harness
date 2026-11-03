import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEvalSamplingHook } from "../../../../src/runtime/hooks/eval-sampling-hook.js";
import { runPostExecutionHooks } from "../../../../src/runtime/hooks/runner.js";
import type { EvalQueue } from "../../../../src/evals/eval-queue.js";
import type { SamplingPolicy } from "../../../../src/evals/sampler.js";
import type { PostExecutionHookInput } from "../../../../src/runtime/hooks/types.js";
import type { ExecutionPayload } from "../../../../src/runtime/execution-handler.js";

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
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    agentName: "scheduler",
    ...overrides,
  };
}

function makeQueue(): EvalQueue {
  return {
    name: "execution.evals",
    enqueue: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  } as unknown as EvalQueue;
}

describe("eval-sampling-hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues when policy says sample", async () => {
    const queue = makeQueue();
    const policy: SamplingPolicy = { type: "always" };
    const hook = createEvalSamplingHook({
      queue,
      policy,
      enabledScorers: ["no-pii"],
    });
    await hook.run(makeInput());
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const payload = (queue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.sampling_reason).toBe("policy:always");
    expect(payload.input.meta.organization_id).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
    expect(payload.input.meta.reasoning_engine).toBe("react");
    expect(payload.input.input).toBe("Marcar consulta amanha");
    expect(payload.input.output).toBe("ok, agendado para amanha 14h");
    expect(payload.scorers_enabled).toEqual(["no-pii"]);
  });

  it("skips enqueue when policy says never", async () => {
    const queue = makeQueue();
    const policy: SamplingPolicy = { type: "never" };
    const hook = createEvalSamplingHook({ queue, policy, enabledScorers: ["no-pii"] });
    await hook.run(makeInput());
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("is a no-op when queue/policy not configured", async () => {
    const hook = createEvalSamplingHook({}); // no deps → singletons null in test
    await expect(hook.run(makeInput())).resolves.toBeUndefined();
  });

  it("runPostExecutionHooks swallows enqueue errors", async () => {
    const queue = {
      name: "execution.evals",
      enqueue: vi.fn().mockRejectedValue(new Error("redis down")),
      close: vi.fn(),
    } as unknown as EvalQueue;
    const hook = createEvalSamplingHook({
      queue,
      policy: { type: "always" },
      enabledScorers: ["no-pii"],
    });
    // Through the runner — must NOT throw.
    await expect(
      runPostExecutionHooks([hook], makeInput()),
    ).resolves.toBeUndefined();
  });

  it("tagged policy matches when payload.tags includes the tag", async () => {
    const queue = makeQueue();
    const hook = createEvalSamplingHook({
      queue,
      policy: { type: "tagged", tag: "high-risk" },
      enabledScorers: ["no-pii"],
    });
    const input = makeInput({
      payload: makePayload({
        // tags is not in the schema; we pass it through passthrough()
        ...({ tags: ["high-risk"] } as unknown as Partial<ExecutionPayload>),
      }),
    });
    await hook.run(input);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});
