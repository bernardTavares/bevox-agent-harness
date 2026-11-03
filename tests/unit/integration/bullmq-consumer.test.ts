import { describe, it, expect, vi, afterEach } from "vitest";

// Re-export a REAL UnrecoverableError so `extends UnrecoverableError` in
// execution-handler resolves to a real class and `instanceof` works under the mock.
vi.mock("bullmq", () => {
  class UnrecoverableError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  }
  class FakeWorker {
    listeners: Record<string, (...args: unknown[]) => void> = {};
    constructor(
      public queue: string,
      public processor: (job: { data: unknown; id?: string }) => Promise<void>,
      public options: Record<string, unknown>,
    ) {}
    on(event: string, fn: (...args: unknown[]) => void): this {
      this.listeners[event] = fn;
      return this;
    }
    async close(): Promise<void> {}
  }
  return { Worker: FakeWorker, UnrecoverableError };
});

// Spy on the metrics + the dead-letter signal callback. The dead-letter metric
// and the transient-failure metric are DISTINCT surfaces and spied separately.
const metricMock = vi.hoisted(() => ({
  recordDeadLetter: vi.fn(),
  recordTransientFailure: vi.fn(),
}));
vi.mock("../../../src/observability/dead-letter-metrics", () => metricMock);

const callbackMock = vi.hoisted(() => ({ updateStatus: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../src/integration/bevox-callback", () => callbackMock);

// handleExecution is mocked so the processor can be driven without real infra.
const handlerMock = vi.hoisted(() => ({ handleExecution: vi.fn() }));
vi.mock("../../../src/runtime/execution-handler", async () => {
  const actual = await vi.importActual<typeof import("../../../src/runtime/execution-handler")>(
    "../../../src/runtime/execution-handler",
  );
  return { ...actual, handleExecution: handlerMock.handleExecution };
});

import { UnrecoverableError } from "bullmq";
import { UnprocessablePayloadError } from "../../../src/runtime/execution-handler.js";
import {
  startConsumer,
  stopConsumer,
  getActiveWorker,
} from "../../../src/integration/bullmq-consumer.js";
import { MutationTool } from "../../../src/tools/_shared/mutation-tool.js";
import type { ToolContext } from "../../../src/tools/_shared/mutation-tool.js";

const VALID_TOKEN = "a-very-long-token-value-1234567890";

describe("bullmq-consumer", () => {
  afterEach(async () => {
    await stopConsumer();
    metricMock.recordDeadLetter.mockReset();
    metricMock.recordTransientFailure.mockReset();
    callbackMock.updateStatus.mockReset();
    handlerMock.handleExecution.mockReset();
    vi.restoreAllMocks();
  });

  it("startConsumer returns a worker and registers it as active", async () => {
    const worker = await startConsumer({} as never);
    expect(worker).toBeDefined();
    expect(getActiveWorker()).toBe(worker);
  });

  it("sets retention options + maxStalledCount, and NO attempts/backoff", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { options: Record<string, unknown> };
    expect(fake.options.removeOnFail).toMatchObject({ age: 86_400 });
    expect(fake.options.removeOnComplete).toMatchObject({ age: 3600, count: 1000 });
    expect(fake.options.maxStalledCount).toBe(1);
    expect(fake.options.attempts).toBeUndefined();
    expect(fake.options.backoff).toBeUndefined();
  });

  it("processor rethrows handler errors (poison reaches failed set)", async () => {
    handlerMock.handleExecution.mockRejectedValueOnce(new UnprocessablePayloadError("poison"));
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as {
      processor: (job: { data: unknown; id?: string }) => Promise<void>;
    };
    let thrown: unknown;
    await fake.processor({ data: {}, id: "j1" }).catch((e) => {
      thrown = e;
    });
    expect(thrown).toBeInstanceOf(UnprocessablePayloadError);
  });

  it("registers a failed listener and an error listener", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    expect(typeof fake.listeners.failed).toBe("function");
    expect(typeof fake.listeners.error).toBe("function");
  });

  it("poison → records 'poison' + writes dead_letter when id+token salvageable", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    const poison = new UnprocessablePayloadError("bad", {
      executionId: "11111111-1111-4111-8111-111111111111",
      executionToken: VALID_TOKEN,
    });
    await fake.listeners.failed({ id: "j2", attemptsMade: 1, opts: { attempts: 7 } }, poison);
    expect(metricMock.recordDeadLetter).toHaveBeenCalledWith({ category: "poison" });
    expect(callbackMock.updateStatus).toHaveBeenCalledTimes(1);
    const [id, token, status, meta] = callbackMock.updateStatus.mock.calls[0];
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
    expect(token).toBe(VALID_TOKEN);
    expect(status).toBe("dead_letter");
    expect(meta).toMatchObject({ action: "retry_exhausted" });
    // C10 (mutation-stack): the dead-letter key is the canonical content-derived
    // sha256 (ADR-015 `deriveIdempotencyKey`), NOT the legacy plaintext key.
    // Derive it the SAME way the production dead-letter path does — same context
    // shape `{ execution_id, organization_id: "", step_index: 0 }`, same op name
    // `"dead-letter"`, same `{}` params — so the assertion tracks the canonical
    // formula instead of pinning a literal that drifts.
    const expectedKey = MutationTool.deriveIdempotencyKey(
      {
        execution_id: "11111111-1111-4111-8111-111111111111",
        organization_id: "",
        step_index: 0,
      } as ToolContext,
      "dead-letter",
      {},
    );
    expect(meta.idempotencyKey).toBe(expectedKey);
    // Contract guard: 64-char hex sha256 (passes the backend's opaque-key regex),
    // and explicitly NOT the old plaintext key.
    expect(meta.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.idempotencyKey).not.toBe(
      "harness:11111111-1111-4111-8111-111111111111:0:dead-letter",
    );
  });

  it("transient FINAL attempt → records 'retry_exhausted' + writes dead_letter", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    const job = {
      id: "j3",
      attemptsMade: 7,
      opts: { attempts: 7 },
      failedReason: "backend 503",
      data: { execution_id: "22222222-2222-4222-8222-222222222222", execution_token: VALID_TOKEN },
    };
    await fake.listeners.failed(job, new Error("backend 503"));
    expect(metricMock.recordDeadLetter).toHaveBeenCalledWith({ category: "retry_exhausted" });
    expect(callbackMock.updateStatus).toHaveBeenCalledTimes(1);
    expect(callbackMock.updateStatus.mock.calls[0][2]).toBe("dead_letter");
  });

  it("transient NON-final attempt → records on the SEPARATE transient metric, NOT the dead-letter metric, and does NOT write dead_letter", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    const job = {
      id: "j4",
      attemptsMade: 3,
      opts: { attempts: 7 },
      data: { execution_id: "33333333-3333-4333-8333-333333333333", execution_token: VALID_TOKEN },
    };
    await fake.listeners.failed(job, new Error("transient"));
    // A non-final attempt is per-attempt flakiness, NOT a dead-letter: it must
    // land on the distinct transient counter and never inflate the dead-letter SLO.
    expect(metricMock.recordTransientFailure).toHaveBeenCalledTimes(1);
    expect(metricMock.recordDeadLetter).not.toHaveBeenCalled();
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
  });

  it("abort (ExecutionAbortError by name) → records 'aborted', NEVER writes dead_letter (§8 open #11)", async () => {
    const worker = await startConsumer({} as never);
    const fake = worker as unknown as { listeners: Record<string, (...a: unknown[]) => void> };
    const abortErr = new Error("wall-clock timeout");
    abortErr.name = "ExecutionAbortError";
    const job = {
      id: "j5",
      attemptsMade: 7, // even on the FINAL attempt, abort must not become retry_exhausted
      opts: { attempts: 7 },
      data: { execution_id: "44444444-4444-4444-8444-444444444444", execution_token: VALID_TOKEN },
    };
    await fake.listeners.failed(job, abortErr);
    expect(metricMock.recordDeadLetter).toHaveBeenCalledWith({ category: "aborted" });
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
  });

  it("stopConsumer closes worker and clears active reference", async () => {
    await startConsumer({} as never);
    expect(getActiveWorker()).not.toBeNull();
    await stopConsumer();
    expect(getActiveWorker()).toBeNull();
  });

  it("stopConsumer is a no-op when no worker is active", async () => {
    await stopConsumer();
    await expect(stopConsumer()).resolves.toBeUndefined();
  });
});
