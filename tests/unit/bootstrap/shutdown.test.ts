import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// shutdown.ts builds a module-private pino logger at import time
// (`const logger = pino({...})`). Mock the default export BEFORE importing the
// module so `logger.info/warn/error` are spies we can assert on (the module
// does NOT accept an injected logger — this is the only seam). vi.mock is
// hoisted above the imports below.
// `vi.hoisted` so `logSpies` is constructed in the hoisted scope and is
// therefore initialized BEFORE the hoisted `vi.mock("pino", ...)` factory runs
// (referencing a plain top-level const inside the factory hits a TDZ error
// under Vitest's hoisting — this is the canonical seam).
const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("pino", () => ({
  default: () => logSpies,
}));

// Collaborators the shutdown util imports at module top. All no-op by default.
vi.mock("../../../src/integration/bullmq-consumer.js", () => ({
  stopConsumer: vi.fn(async () => {}),
  getActiveWorker: vi.fn(() => null),
}));
vi.mock("../../../src/dev/ws-server.js", () => ({
  stopDevWsServer: vi.fn(async () => {}),
}));
vi.mock("../../../src/mcp/client-registry.js", () => ({
  McpClientRegistry: { getInstance: () => ({ closeAll: vi.fn(async () => {}) }) },
}));
vi.mock("../../../src/observability/tracer.js", () => ({
  shutdownTracer: vi.fn(async () => {}),
}));

import { registerShutdownHandlers } from "../../../src/bootstrap/shutdown.js";
import { stopConsumer } from "../../../src/integration/bullmq-consumer.js";

/** Thrown by the process.exit stub so the async shutdown() unwinds like a real exit. */
class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

// The production signal handlers are `() => void shutdown(signal)` — the
// returned promise is intentionally discarded (fire-and-forget). When the
// `process.exit` stub below throws `ExitError` to model a real exit, that
// rejection escapes the void-discarded promise and Vitest reports it as an
// unhandled rejection (failing the suite even though every assertion passes).
// A real `process.exit` would terminate the process before any rejection could
// surface, so this leak is a pure test-harness artifact. Swallow ONLY our own
// `ExitError` sentinel here; any other rejection still surfaces normally.
function ignoreExitErrorRejection(reason: unknown): void {
  if (!(reason instanceof ExitError)) {
    throw reason;
  }
}

/** Stub process.exit → record the code + throw to terminate shutdown(). */
function stubExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
}

/** Emit a signal and let the async shutdown() handler settle. */
async function emitSignal(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  process.emit(signal as NodeJS.Signals);
  // Flush macrotasks so the async shutdown() handler runs to completion. The
  // `process.exit` stub throws `ExitError`, which escapes the void-discarded
  // promise as an unhandled rejection — caught + ignored by the
  // `ignoreExitErrorRejection` listener registered in beforeEach.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

interface FakeRedis {
  quit: ReturnType<typeof vi.fn>;
}
interface FakePool {
  end: ReturnType<typeof vi.fn>;
}

function makeFakeRedis(): FakeRedis {
  return { quit: vi.fn(async () => "OK") };
}
function makeFakePool(): FakePool {
  return { end: vi.fn(async () => {}) };
}

describe("registerShutdownHandlers — db+redis close in order (Gap 1)", () => {
  let exitSpy: ReturnType<typeof stubExit>;

  beforeEach(() => {
    exitSpy = stubExit();
    process.on("unhandledRejection", ignoreExitErrorRejection);
    logSpies.info.mockClear();
    logSpies.warn.mockClear();
    logSpies.error.mockClear();
    vi.mocked(stopConsumer).mockClear();
  });

  afterEach(() => {
    process.removeListener("unhandledRejection", ignoreExitErrorRejection);
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.restoreAllMocks();
  });

  it("drains worker, then quits redis, then ends db, then exit(0)", async () => {
    const redis = makeFakeRedis();
    const db = makeFakePool();
    registerShutdownHandlers({
      db: db as never,
      redis: redis as never,
    });

    await emitSignal("SIGTERM");

    expect(stopConsumer).toHaveBeenCalledTimes(1);
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(db.end).toHaveBeenCalledTimes(1);
    // ordering: stopConsumer → redis.quit → db.end
    const drainOrder = vi.mocked(stopConsumer).mock.invocationCallOrder[0]!;
    const quitOrder = redis.quit.mock.invocationCallOrder[0]!;
    const endOrder = db.end.mock.invocationCallOrder[0]!;
    expect(drainOrder).toBeLessThan(quitOrder);
    expect(quitOrder).toBeLessThan(endOrder);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("registerShutdownHandlers — opt-in lifecycle handles (Gap 2)", () => {
  let exitSpy: ReturnType<typeof stubExit>;

  beforeEach(() => {
    exitSpy = stubExit();
    process.on("unhandledRejection", ignoreExitErrorRejection);
    logSpies.info.mockClear();
    logSpies.warn.mockClear();
    logSpies.error.mockClear();
    vi.mocked(stopConsumer).mockClear();
  });

  afterEach(() => {
    process.removeListener("unhandledRejection", ignoreExitErrorRejection);
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.restoreAllMocks();
  });

  it("closes evalWorker → condenseQueue → cleanup.stop, all BEFORE redis.quit", async () => {
    const redis = makeFakeRedis();
    const db = makeFakePool();
    const evalWorker = { close: vi.fn(async () => {}) };
    const condenseQueue = { close: vi.fn(async () => {}) };
    const cleanupJob = { stop: vi.fn(() => {}) };

    registerShutdownHandlers({
      db: db as never,
      redis: redis as never,
      getEvalWorker: () => evalWorker as never,
      getCondenseQueue: () => condenseQueue as never,
      getWorkflowCleanupJob: () => cleanupJob,
    });

    await emitSignal("SIGTERM");

    expect(evalWorker.close).toHaveBeenCalledTimes(1);
    expect(condenseQueue.close).toHaveBeenCalledTimes(1);
    expect(cleanupJob.stop).toHaveBeenCalledTimes(1);

    const evalOrder = evalWorker.close.mock.invocationCallOrder[0]!;
    const queueOrder = condenseQueue.close.mock.invocationCallOrder[0]!;
    const cleanupOrder = cleanupJob.stop.mock.invocationCallOrder[0]!;
    const quitOrder = redis.quit.mock.invocationCallOrder[0]!;
    const drainOrder = vi.mocked(stopConsumer).mock.invocationCallOrder[0]!;

    expect(drainOrder).toBeLessThan(evalOrder);
    expect(evalOrder).toBeLessThan(queueOrder);
    expect(queueOrder).toBeLessThan(cleanupOrder);
    expect(cleanupOrder).toBeLessThan(quitOrder);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("skips absent opt-in handles (getters undefined / returning undefined) without throwing", async () => {
    const redis = makeFakeRedis();
    const db = makeFakePool();
    registerShutdownHandlers({
      db: db as never,
      redis: redis as never,
      // all-flags-off: getters return undefined
      getEvalWorker: () => undefined,
      getCondenseQueue: () => null,
      getWorkflowCleanupJob: () => undefined,
    });

    await emitSignal("SIGTERM");

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpies.error).not.toHaveBeenCalled();
  });

  it("re-entrancy: a second SIGTERM during shutdown does not re-run teardown", async () => {
    const redis = makeFakeRedis();
    const db = makeFakePool();
    registerShutdownHandlers({ db: db as never, redis: redis as never });

    process.emit("SIGTERM" as NodeJS.Signals);
    process.emit("SIGTERM" as NodeJS.Signals);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopConsumer).toHaveBeenCalledTimes(1);
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(logSpies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM" }),
      expect.stringContaining("already in progress"),
    );
  });

  it("watchdog forces exit(1) when the drain never resolves (lock-backstop)", async () => {
    vi.useFakeTimers();
    const redis = makeFakeRedis();
    const db = makeFakePool();
    // stopConsumer hangs forever → drain window elapses → watchdog fires.
    vi.mocked(stopConsumer).mockImplementationOnce(() => new Promise<void>(() => {}));

    registerShutdownHandlers({
      db: db as never,
      redis: redis as never,
      drainGraceMs: 20,
      forceExitAfterMs: 30,
    });

    process.emit("SIGTERM" as NodeJS.Signals);
    // Let the synchronous part of shutdown() (arming timers) run.
    await Promise.resolve();
    // Advance past drainGraceMs + forceExitAfterMs.
    expect(() => vi.advanceTimersByTime(60)).toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpies.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "shutdown.forced_exit" }),
      expect.any(String),
    );
    vi.useRealTimers();
  });

  it("watchdog window wired to the execution budget never cuts a healthy in-flight execution (FIX 1)", async () => {
    // FIX 1: src/index.ts wires forceExitAfterMs = maxExecutionTimeMs (90000)
    // + a small grace, so the force-exit window is >= the max execution budget.
    // Pin the invariant here with the wired value: a healthy execution that
    // runs the FULL budget (drain resolves just before the budget elapses) must
    // finish gracefully (exit(0)), and the watchdog must NOT fire at exit(1).
    vi.useFakeTimers();
    const redis = makeFakeRedis();
    const db = makeFakePool();
    const MAX_EXECUTION_TIME_MS = 90_000;
    const GRACE_MS = 5_000;
    const wiredForceExitAfterMs = MAX_EXECUTION_TIME_MS + GRACE_MS; // 95000

    // Model a healthy drain that takes the full execution budget then resolves.
    vi.mocked(stopConsumer).mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, MAX_EXECUTION_TIME_MS)),
    );

    registerShutdownHandlers({
      db: db as never,
      redis: redis as never,
      // drainGraceMs default 0 → watchdog arms immediately; the only thing
      // keeping it from cutting the healthy execution is forceExitAfterMs >= budget.
      forceExitAfterMs: wiredForceExitAfterMs,
    });

    process.emit("SIGTERM" as NodeJS.Signals);
    await Promise.resolve();

    // Advance to exactly the budget: drain resolves, watchdog has NOT fired
    // (its window is budget + grace > budget), so no forced exit(1).
    await vi.advanceTimersByTimeAsync(MAX_EXECUTION_TIME_MS);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(logSpies.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "shutdown.forced_exit" }),
      expect.any(String),
    );
    vi.useRealTimers();
  });

  it("a failing close → exit(1) with event shutdown.error", async () => {
    const redis = makeFakeRedis();
    const db = makeFakePool();
    db.end.mockRejectedValueOnce(new Error("pool drain failed"));
    registerShutdownHandlers({ db: db as never, redis: redis as never });

    await emitSignal("SIGTERM");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpies.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "shutdown.error" }),
      expect.any(String),
    );
  });

  it("redis.quit is called EXACTLY once even with shared-connection eval worker + condense queue (risk 4 invariant)", async () => {
    const redis = makeFakeRedis();
    const db = makeFakePool();
    // Both opt-in handles SHARE this same redis (stages.ts:564 / :493). Their
    // .close() must NOT quit it — only step-2 redis.quit() does (BullMQ
    // shared:true gate). Pin the invariant against BullMQ upgrades.
    const evalWorker = { close: vi.fn(async () => {}) };
    const condenseQueue = { close: vi.fn(async () => {}) };
    registerShutdownHandlers({
      db: db as never,
      redis: redis as never,
      getEvalWorker: () => evalWorker as never,
      getCondenseQueue: () => condenseQueue as never,
    });

    await emitSignal("SIGTERM");

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("happy path emits event shutdown.graceful_complete", async () => {
    const redis = makeFakeRedis();
    const db = makeFakePool();
    registerShutdownHandlers({ db: db as never, redis: redis as never });

    await emitSignal("SIGINT");

    expect(logSpies.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "shutdown.graceful_complete", signal: "SIGINT" }),
      expect.any(String),
    );
  });

  it("signal-received line carries the signal but NOT a (dead) active-job count", async () => {
    // FIX 2: the old `activeJobs` field probed `worker.getActiveCount()`, which
    // BullMQ 5.76 Worker never exposes (it lives on Queue), so it always logged
    // `undefined` — zero operator signal. The field was dropped. Pin that the
    // signal-received line logs `signal` and does NOT carry an `activeJobs` key.
    const redis = makeFakeRedis();
    const db = makeFakePool();
    registerShutdownHandlers({ db: db as never, redis: redis as never });

    await emitSignal("SIGTERM");

    const signalReceivedCall = logSpies.info.mock.calls.find(
      ([, msg]) => msg === "Shutdown signal received",
    );
    expect(signalReceivedCall).toBeDefined();
    expect(signalReceivedCall![0]).toEqual({ signal: "SIGTERM" });
    expect(signalReceivedCall![0]).not.toHaveProperty("activeJobs");
  });
});
