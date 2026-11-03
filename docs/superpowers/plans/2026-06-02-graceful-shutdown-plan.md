# Graceful Shutdown — Wire Real Resource Handles on SIGTERM/SIGINT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On SIGTERM/SIGINT the harness must drain the BullMQ worker, close the eval worker + condense queue + workflow cleanup timer, then close the bootstrap Redis client and pg `Pool` — in that order — instead of leaking every connection until the OS reaps the process (audit BOOT-002), and add the first unit test under `src/bootstrap/*` (audit BOOT-005).

**Architecture:** This is a **cabling fix**, not a new subsystem. `src/bootstrap/shutdown.ts` already drains the worker and closes redis/db *when handles are present* — but `src/index.ts:5` calls `registerShutdownHandlers({})` with an empty object **before** bootstrap runs, so the branches never fire. We (1) reorder `index.ts` so `runBootstrap()` runs first and threads the real `ctx` + three lazy registry getters into `registerShutdownHandlers`, and (2) widen `ShutdownResources` and insert ordered, `undefined`-guarded closes for the eval worker / condense queue / cleanup job between the existing worker-drain and the redis/db closes, plus a re-entrancy guard, a wall-clock watchdog, and structured shutdown log events. We reuse only the `stop()`/`close()` methods that already exist on each handle.

**Tech Stack:** Node.js 20, TypeScript 5.9 (ESM/NodeNext — all relative imports use `.js` extensions), Vitest 4. `npm run build` = `tsc && copy-skill-manifests`; `npm run typecheck` = `tsc --noEmit`; the test gate is `npm run test:unit` (= `vitest run tests/unit`). **Never** gate on `npm test` (runs everything) or the `RUN_INTEGRATION=1` integration suite.

---

## ⚠️ Founder decisions this plan surfaces but does NOT resolve

These came from the spec's §8 risks/open-questions and the design review. The code in this plan is written to be **safe by default** (the watchdog is a pure lock-backstop, armed only *after* the drain gets its own window — see Task 2), but the following remain owner decisions and are recorded in the DoD (Task 7), not silently closed:

- **(OQ e / risk 7) Watchdog × dedup-key collision.** A forced `exit(1)` mid-execution can land *after* the `SET harness:dedup:{id} EX 3600 NX` (`execution-handler.ts:851-862`) but *before* `sendComplete` — the BullMQ redeliver then hits the dedup wall (`acquired === null` → silent `return`, `:858-861`) and **no `/complete` is ever emitted**. This plan contains the blast radius by giving `stopConsumer()` a dedicated `drainGraceMs` window before the fatal watchdog arms (option (i)). The real fix — dedup-key TTL/retry semantics — lives in the handler/idempotency layer, **out of this spec's scope** (OQ (e) option (ii)); it is left as a follow-up with a DoD gate, NOT built here.
- **(risk 8) No shutdown-owned terminal callback on hard-abort.** The happy-path drain is fine (`worker.close()` waits for the handler to finish naturally and emit its own `/complete`). But a cost-abort-mid-stream / timeout-mid-tool-side-effect, or the watchdog `exit(1)`, emits **no** terminal `/complete` and **no** audit row. A real fix (shutdown-owned terminal callback on abort) is a **separate delivery** (tangent to audit J5/J8) — not in this plan.
- **(OQ f / risk 8) No DLQ substrate exists.** "Dead-letter path when Redis is down" is moot — there is no DLQ at all. A SIGTERM while Redis is unreachable means `redis.quit()` fails, the watchdog forces `exit(1)`, and the in-flight job has no safe landing. Instrumenting stalled/failed-queue depth requires queue instrumentation that does not exist. Left as the highest-leverage follow-up (OQ (f)); this plan ships only **structured log events** (`shutdown.graceful_complete` / `shutdown.forced_exit` / `shutdown.error`) so a log-based alert is possible without a metrics layer.
- **(OQ c / audit J8) AbortController-per-execution is deferred.** Until J8 lands, "drain" can only **wait** for in-flight executions, never cleanly **abort** a cost-overrun or stuck LLM stream within the grace window — the watchdog's `exit(1)` is the only escape hatch (the blunt instrument risk 7 warns about). Whether J8 precedes or accompanies this delivery is a founder decision. This plan leaves the extension point clear (between `stopConsumer` and the watchdog) but does **not** implement it.

---

## File Structure

**Modified:**
- `src/bootstrap/shutdown.ts` — widen `ShutdownResources` (3 lazy getters + `drainGraceMs` + `forceExitAfterMs`); add `isShuttingDown` re-entrancy guard; add the deferred-arm watchdog; insert ordered guarded closes (eval worker → condense queue → cleanup job) between the tracer flush and the redis close; emit the 3 structured log events.
- `src/index.ts` — reorder so `const ctx = await runBootstrap()` runs first, then `registerShutdownHandlers({ db, redis, getEvalWorker, getCondenseQueue, getWorkflowCleanupJob })`.

**Created:**
- `tests/unit/bootstrap/shutdown.test.ts` — first unit test under `tests/unit/bootstrap/` (dir does not exist today; closes BOOT-005).

**NOT touched (verified — already correct):**
- `src/integration/bullmq-consumer.ts` — `stopConsumer()` (`:45-49`) already does `activeWorker.close()` (drain). The main Worker owns its own internal Redis connection (`:32` `connection: { url: config.redis.url }`), closed by `worker.close()`.
- `src/workflow/cleanup.ts` — `stop()` (`:34-39`) already exists; timer already `.unref()`'d (`:31`). We only *call* it.
- `src/observability/tracer.ts`, `src/dev/ws-server.ts`, `src/mcp/client-registry.ts` — their teardown branches already run in `shutdown.ts:28-47`.

---

## Phase 1 — Widen `ShutdownResources` + ordered teardown + watchdog + log events

### Task 1: Add the structured-log helper + widen `ShutdownResources` (compiles, behavior unchanged)

This task makes the type surface and the `pino`-default-export mock seam exist so Phase-1 tests can be written against them. Behavior is unchanged until Task 2 wires the new closes.

**Files:**
- Modify: `src/bootstrap/shutdown.ts`
- Test: `tests/unit/bootstrap/shutdown.test.ts` (NEW)

- [ ] **Step 1: Write the failing test** — create `tests/unit/bootstrap/shutdown.test.ts` (the directory `tests/unit/bootstrap/` does not exist yet — creating this file creates it). This first cut asserts only the type/shape seam: that `registerShutdownHandlers` accepts the widened resources and that a happy-path SIGTERM with `db`+`redis` closes both in order and exits 0. The `pino` default export is mocked so the module-private `logger` is a spy.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// shutdown.ts builds a module-private pino logger at import time
// (`const logger = pino({...})`). Mock the default export BEFORE importing the
// module so `logger.info/warn/error` are spies we can assert on (the module
// does NOT accept an injected logger — this is the only seam). vi.mock is
// hoisted above the imports below.
const logSpies = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock("pino", () => ({
  default: () => logSpies,
}));

// Collaborators the shutdown util imports at module top. All no-op by default.
vi.mock("../../../src/integration/bullmq-consumer.js", () => ({
  stopConsumer: vi.fn(async () => {}),
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

/** Stub process.exit → record the code + throw to terminate shutdown(). */
function stubExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
}

/** Emit a signal and let the async shutdown() handler settle. */
async function emitSignal(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  process.emit(signal as NodeJS.Signals);
  // Flush microtasks until the exit stub throws (caught inside the handler's
  // own try/catch path or swallowed by `void shutdown(...)`).
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
    logSpies.info.mockClear();
    logSpies.warn.mockClear();
    logSpies.error.mockClear();
    vi.mocked(stopConsumer).mockClear();
  });

  afterEach(() => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- shutdown`
Expected: FAIL — the test file did not exist, and `registerShutdownHandlers({ db, redis })` already works in the current code, BUT this run also proves the `pino` mock seam + ordering harness compile and execute. If it unexpectedly PASSES, that is fine for *this* assertion (current code already closes db/redis when passed) — the point of Phase 1 is the widened type + new closes in Task 2. Confirm the test RUNS (not a compile/import error) before proceeding.

> **Note:** the spec's Gap 1 is that `index.ts` passes `{}` — the `shutdown.ts` branches themselves already work when handles are present. This test pins that contract so Task 2's reordering of the body cannot regress it.

- [ ] **Step 3: Write minimal implementation** — in `src/bootstrap/shutdown.ts`, widen the interface and add the `bullmq` type import. Replace the import block top + the interface (current `:1-17`). Replace:

```typescript
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import pino from "pino";

import { getHarnessConfig } from "../config/harness-config.js";
import { stopDevWsServer } from "../dev/ws-server.js";
import { stopConsumer } from "../integration/bullmq-consumer.js";
import { McpClientRegistry } from "../mcp/client-registry.js";
import { shutdownTracer } from "../observability/tracer.js";

const config = getHarnessConfig();
const logger = pino({ level: config.harness.logLevel, name: "shutdown" });

export interface ShutdownResources {
  db?: Pool;
  redis?: Redis;
}
```

with:

```typescript
import type { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import pino from "pino";

import { getHarnessConfig } from "../config/harness-config.js";
import { stopDevWsServer } from "../dev/ws-server.js";
import { stopConsumer } from "../integration/bullmq-consumer.js";
import { McpClientRegistry } from "../mcp/client-registry.js";
import { shutdownTracer } from "../observability/tracer.js";

const config = getHarnessConfig();
const logger = pino({ level: config.harness.logLevel, name: "shutdown" });

export interface ShutdownResources {
  db?: Pool;
  redis?: Redis;
  /**
   * Lazy getters — evaluated at signal time, so robust to bootstrap stage
   * reordering. Every handle is opt-in (feature-flag gated) and may be
   * null/undefined; each close is guarded.
   */
  getEvalWorker?: () => Worker | null | undefined;
  getCondenseQueue?: () => Queue | null | undefined;
  getWorkflowCleanupJob?: () => { stop(): void } | null | undefined;
  /**
   * Window (ms) given to the worker drain (`stopConsumer`) BEFORE the fatal
   * watchdog arms. Keeps the watchdog a pure lock-backstop, not a cutter of a
   * healthy in-flight execution (risk 7 / OQ (e) option (i)). Default 0 =
   * arm watchdog immediately (legacy behavior; tests override).
   */
  drainGraceMs?: number;
  /** Watchdog: forced exit(1) this many ms after the drain window (default 10s). */
  forceExitAfterMs?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- shutdown`
Expected: PASS — the widened interface compiles; the db+redis ordering test is green (behavior unchanged in this task).

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/shutdown.ts tests/unit/bootstrap/shutdown.test.ts
git commit -m "feat(bootstrap): widen ShutdownResources for lifecycle handles + first bootstrap unit test (BOOT-002/005)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Ordered teardown of opt-in handles + re-entrancy guard + deferred-arm watchdog + log events

**Files:**
- Modify: `src/bootstrap/shutdown.ts`
- Test: `tests/unit/bootstrap/shutdown.test.ts`

- [ ] **Step 1: Write the failing test** — append these `describe` blocks to `tests/unit/bootstrap/shutdown.test.ts` (after the existing `describe`, before EOF). They cover opt-in closes + ordering, absent handles, re-entrancy, watchdog forced exit, error→exit(1), the single-quit invariant, and the structured log events.

```typescript
describe("registerShutdownHandlers — opt-in lifecycle handles (Gap 2)", () => {
  let exitSpy: ReturnType<typeof stubExit>;

  beforeEach(() => {
    exitSpy = stubExit();
    logSpies.info.mockClear();
    logSpies.warn.mockClear();
    logSpies.error.mockClear();
    vi.mocked(stopConsumer).mockClear();
  });

  afterEach(() => {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- shutdown`
Expected: FAIL — the opt-in closes do not run (`evalWorker.close`/`condenseQueue.close`/`cleanup.stop` never called), there is no re-entrancy guard (second SIGTERM re-runs teardown), no watchdog (`drainGraceMs`/`forceExitAfterMs` ignored), and no `event:` fields on the log lines.

- [ ] **Step 3: Write minimal implementation** — replace the ENTIRE `registerShutdownHandlers` function body (current `:19-71`) with the version below. It adds the module-level `isShuttingDown` guard, the deferred-arm watchdog (drain window → fatal timer), the three guarded opt-in closes between the tracer flush and the redis close, `clearTimeout` on both exits, and the three structured log events. The existing dev-ws / MCP / tracer guarded blocks are preserved verbatim.

```typescript
let isShuttingDown = false; // module-level re-entrancy guard (risk 2)

export function registerShutdownHandlers(resources: ShutdownResources): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      logger.warn({ signal }, "Shutdown already in progress — ignoring repeat signal");
      return;
    }
    isShuttingDown = true;
    logger.info({ signal }, "Shutdown signal received");

    // Watchdog (risk 7 / OQ (e) option (i)): arm the FATAL exit(1) only AFTER
    // the drain has had its own `drainGraceMs` window, so a healthy in-flight
    // execution finishing and emitting its own /complete is never cut. The
    // watchdog covers only real locks (redis half-open, a close that hangs).
    const drainGraceMs = resources.drainGraceMs ?? 0;
    const forceMs = resources.forceExitAfterMs ?? 10_000;
    let watchdog: NodeJS.Timeout | undefined;
    const armWatchdog = setTimeout(() => {
      watchdog = setTimeout(() => {
        logger.error(
          { event: "shutdown.forced_exit", signal, drainGraceMs, forceMs },
          "Shutdown timed out — forcing exit(1)",
        );
        process.exit(1);
      }, forceMs);
      if (typeof watchdog.unref === "function") watchdog.unref();
    }, drainGraceMs);
    if (typeof armWatchdog.unref === "function") armWatchdog.unref();

    const clearTimers = (): void => {
      clearTimeout(armWatchdog);
      if (watchdog) clearTimeout(watchdog);
    };

    try {
      // 1. Drain the main BullMQ Worker (waits for in-flight jobs). ALREADY EXISTED.
      await stopConsumer();

      // 1a. Stop dev playground WS server (if running)
      try {
        await stopDevWsServer();
      } catch (err) {
        logger.warn({ err }, "Error stopping dev ws server (continuing)");
      }

      // 1a'. Close external MCP client connections (Sprint B.2). No-op when
      // MCP_CLIENT_ENABLED=false. Also cancels the health heartbeat timer.
      try {
        await McpClientRegistry.getInstance().closeAll();
      } catch (err) {
        logger.warn({ err }, "Error closing MCP clients (continuing)");
      }

      // 1b. Flush + shut down OpenTelemetry SDK (no-op if disabled)
      try {
        await shutdownTracer();
      } catch (err) {
        logger.warn({ err }, "Error shutting down tracer (continuing)");
      }

      // 1c. Close eval worker (BullMQ Worker). Opt-in (EVALS_WORKER_ENABLED).
      //     SHARES ctx.redis (stages.ts:564) but BullMQ marks the command
      //     connection shared:true, so .close() does NOT quit ctx.redis
      //     (risk 4). Close BEFORE redis.quit.
      try {
        const evalWorker = resources.getEvalWorker?.();
        if (evalWorker) {
          logger.info("Closing eval worker");
          await evalWorker.close();
        }
      } catch (err) {
        logger.warn({ err }, "Error closing eval worker (continuing)");
      }

      // 1d. Close condense queue (BullMQ Queue). Opt-in (MEMORY_*).
      //     Also shares ctx.redis (stages.ts:493); same shared:true gate.
      try {
        const condenseQueue = resources.getCondenseQueue?.();
        if (condenseQueue) {
          logger.info("Closing condense queue");
          await condenseQueue.close();
        }
      } catch (err) {
        logger.warn({ err }, "Error closing condense queue (continuing)");
      }

      // 1e. Stop the workflow cleanup timer (already .unref()'d; stop for
      //     hygiene so no tick races a half-closed pool). Opt-in.
      try {
        resources.getWorkflowCleanupJob?.()?.stop();
      } catch (err) {
        logger.warn({ err }, "Error stopping workflow cleanup job (continuing)");
      }

      // 2. Close Redis connection (bootstrap client). ALREADY EXISTED.
      if (resources.redis) {
        logger.info("Closing Redis connection");
        await resources.redis.quit();
      }

      // 3. Close DB pool. ALREADY EXISTED.
      if (resources.db) {
        logger.info("Closing DB pool");
        await resources.db.end();
      }

      clearTimers();
      logger.info(
        { event: "shutdown.graceful_complete", signal },
        "Graceful shutdown complete",
      );
      process.exit(0);
    } catch (err) {
      clearTimers();
      logger.error({ event: "shutdown.error", signal, err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
```

> **Watchdog mechanics (matches the test):** the outer `armWatchdog` waits `drainGraceMs`, then schedules the fatal `watchdog` to fire `forceMs` later. With `drainGraceMs: 20` + `forceExitAfterMs: 30`, the fatal `exit(1)` fires at ~50ms — the test advances 60ms. With the defaults (`drainGraceMs: 0`, `forceExitAfterMs: 10_000`) the watchdog arms immediately and fires at 10s, identical to a single 10s timer. The `isShuttingDown` flag is module-level (not reset between handler registrations) — acceptable because the process exits anyway; the test re-entrancy case relies on it within one process.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- shutdown`
Expected: PASS — all opt-in ordering, absent-handle, re-entrancy, watchdog, error, single-quit-invariant, and structured-log cases green.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/shutdown.ts tests/unit/bootstrap/shutdown.test.ts
git commit -m "feat(bootstrap): ordered teardown of lifecycle handles + re-entrancy guard + watchdog + log events (BOOT-002)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Cable the real handles from `index.ts` (closes Gap 1) + gate

### Task 3: Reorder `index.ts` — bootstrap first, then register handlers with real `ctx` + getters

**Files:**
- Modify: `src/index.ts`

> **Why getters, not values (spec §4.1 / OQ (b)):** the opt-in handles are written into their registries *during* bootstrap stages. Passing lazy getters (evaluated at signal time) is robust to any future stage reordering and keeps `shutdown.ts` decoupled from the creation call-sites. The getters' types match `ShutdownResources` exactly: `getEvalWorker(): Worker | null` (evals/registry.ts:26), `getCondenseQueue(): Queue | undefined` (memory/registry.ts:38), `getWorkflowCleanupJob(): WorkflowCleanupJob | undefined` (stages.ts:84). `WorkflowCleanupJob` structurally satisfies `{ stop(): void }`.

- [ ] **Step 1: Write the implementation** — replace the ENTIRE contents of `src/index.ts`. (This is a wiring change in the process entrypoint, which is not unit-tested directly — the behavioral contract it depends on is fully covered by `shutdown.test.ts`; we verify via build/typecheck in Task 4. No separate failing test is written because `index.ts` boots the real process — exercising it requires the integration harness, which is not a gate.)

```typescript
import { runBootstrap } from "./bootstrap/runner.js";
import { getWorkflowCleanupJob } from "./bootstrap/stages.js";
import { registerShutdownHandlers } from "./bootstrap/shutdown.js";
import { getEvalWorker } from "./evals/registry.js";
import { getCondenseQueue } from "./memory/registry.js";

const main = async (): Promise<void> => {
  // 1. Bootstrap FIRST so the owning resources (pg Pool, bootstrap Redis) and
  //    the opt-in lifecycle handles exist before we register signal handlers.
  const ctx = await runBootstrap();

  // 2. Thread the REAL handles. db/redis are the bootstrap-owned connections;
  //    the three getters resolve opt-in handles lazily at signal time (each is
  //    undefined when its feature flag is off — every close in shutdown.ts is
  //    guarded). Fixes BOOT-002: previously `registerShutdownHandlers({})`
  //    meant redis.quit()/db.end() never ran.
  registerShutdownHandlers({
    db: ctx.db,
    redis: ctx.redis,
    getEvalWorker,
    getCondenseQueue,
    getWorkflowCleanupJob,
  });

  console.log("Agent Harness is running");
};

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Build + typecheck to verify it compiles**

Run: `npm run typecheck`
Expected: exits 0 — the getter signatures unify with the `ShutdownResources` optional getter types (`Worker | null`, `Queue | undefined`, `WorkflowCleanupJob | undefined` all satisfy `... | null | undefined`).

- [ ] **Step 3: Confirm no signal-handler ordering regression** — read the diff to confirm `await runBootstrap()` precedes `registerShutdownHandlers(...)`:

Run: `git diff src/index.ts`
Expected: the diff shows `const ctx = await runBootstrap();` BEFORE `registerShutdownHandlers({...})`, and the empty `{}` argument is gone.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "fix(bootstrap): thread real db/redis + lifecycle getters into shutdown handlers (BOOT-002 Gap 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Phase gate — full build + full unit suite

**Files:** none (verification only)

- [ ] **Step 1: Build (includes tsc + skill-manifest copy)**

Run: `npm run build`
Expected: exits 0, no TypeScript errors, no new warnings.

- [ ] **Step 2: Run the full unit suite (the gate)**

Run: `npm run test:unit`
Expected: PASS — the new `tests/unit/bootstrap/shutdown.test.ts` plus all pre-existing unit suites green. (Do NOT run `npm test` or set `RUN_INTEGRATION=1` — the integration suite is not a gate.)

- [ ] **Step 3: Lint the touched source**

Run: `npm run lint`
Expected: exits 0 — `src/bootstrap/shutdown.ts` and `src/index.ts` clean.

- [ ] **Step 4: Commit (no-op if clean)**

```bash
git add -A
git commit -m "chore: phase gate — build clean, unit suite green, lint clean (BOOT-002/005)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Phase 3 — Optional observability: active-job count in the shutdown signal log (OQ (f), minimal)

> This is the cheapest slice of OQ (f): no metrics layer, no DLQ — just enrich the "Shutdown signal received" log with the count of active jobs at signal time, so a log-based alert can proxy "how many executions were in-flight when we shut down". `getActiveWorker(): Worker | null` already exists (`bullmq-consumer.ts:53`). If the founder defers OQ (f) entirely, **skip this phase** — it is additive and non-blocking. Mark the decision in the DoD.

### Task 5: Log active-job count at signal time (additive)

**Files:**
- Modify: `src/bootstrap/shutdown.ts`
- Test: `tests/unit/bootstrap/shutdown.test.ts`

- [ ] **Step 1: Write the failing test** — append this case to the second `describe` block in `tests/unit/bootstrap/shutdown.test.ts`. It mocks `getActiveWorker` to expose a fake worker with an async `getActiveCount()` and asserts the count is logged on the signal line. Add `getActiveWorker` to the existing `bullmq-consumer.js` mock at the TOP of the file first — replace:

```typescript
vi.mock("../../../src/integration/bullmq-consumer.js", () => ({
  stopConsumer: vi.fn(async () => {}),
}));
```

with:

```typescript
vi.mock("../../../src/integration/bullmq-consumer.js", () => ({
  stopConsumer: vi.fn(async () => {}),
  getActiveWorker: vi.fn(() => null),
}));
```

and add this import near the other imports at the top:

```typescript
import { getActiveWorker } from "../../../src/integration/bullmq-consumer.js";
```

then append the case:

```typescript
  it("logs active-job count on the signal-received line (OQ f proxy)", async () => {
    const redis = makeFakeRedis();
    const db = makeFakePool();
    vi.mocked(getActiveWorker).mockReturnValueOnce({
      getActiveCount: vi.fn(async () => 3),
    } as never);
    registerShutdownHandlers({ db: db as never, redis: redis as never });

    await emitSignal("SIGTERM");

    expect(logSpies.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", activeJobs: 3 }),
      "Shutdown signal received",
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- shutdown`
Expected: FAIL — the signal-received log line currently logs only `{ signal }`, not `activeJobs`.

- [ ] **Step 3: Write minimal implementation** — in `src/bootstrap/shutdown.ts`, add `getActiveWorker` to the bullmq-consumer import. Replace:

```typescript
import { stopConsumer } from "../integration/bullmq-consumer.js";
```

with:

```typescript
import { getActiveWorker, stopConsumer } from "../integration/bullmq-consumer.js";
```

Then replace the signal-received log line (inside `shutdown`, currently `logger.info({ signal }, "Shutdown signal received");`) with:

```typescript
    isShuttingDown = true;
    // OQ (f): best-effort active-job count — log-only proxy for "executions
    // in-flight at shutdown" (no metrics layer / DLQ exists). Never throws.
    let activeJobs: number | undefined;
    try {
      const worker = getActiveWorker();
      if (worker) activeJobs = await worker.getActiveCount();
    } catch {
      // ignore — observability must never block the drain
    }
    logger.info({ signal, activeJobs }, "Shutdown signal received");
```

> **Note:** this replaces the two lines `isShuttingDown = true;` and `logger.info({ signal }, "Shutdown signal received");` from Task 2 with the block above (the `isShuttingDown = true;` assignment moves into this block, unchanged).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- shutdown`
Expected: PASS — `activeJobs: 3` appears on the signal line; cases where `getActiveWorker()` returns `null` log `activeJobs: undefined` (still passes the earlier `objectContaining({ signal })` assertions).

- [ ] **Step 5: Build + commit**

```bash
npm run build && \
git add src/bootstrap/shutdown.ts tests/unit/bootstrap/shutdown.test.ts && \
git commit -m "feat(bootstrap): log active-job count at shutdown signal (OQ f log-proxy)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Final gate — full build + full unit suite + lint

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 2: Full unit suite**

Run: `npm run test:unit`
Expected: PASS — entire `tests/unit` suite green, including `tests/unit/bootstrap/shutdown.test.ts`.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: exits 0.

- [ ] **Step 4: Commit (no-op if clean)**

```bash
git add -A
git commit -m "chore: final gate — build + unit + lint green (BOOT-002/005)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Definition of Done

- [ ] **Gap 1 (BOOT-002):** `src/index.ts` runs `const ctx = await runBootstrap()` BEFORE `registerShutdownHandlers`, which receives `{ db, redis, getEvalWorker, getCondenseQueue, getWorkflowCleanupJob }`. The empty `{}` is gone. SIGTERM/SIGINT now close the pg `Pool` + bootstrap Redis.
- [ ] **Gap 2:** SIGTERM/SIGINT close the eval worker + condense queue + workflow cleanup timer (each `undefined`-guarded for the all-flags-off path), ordered between the worker drain and the redis/db close.
- [ ] **Invariants tested:** ordering (drain → evalWorker → condenseQueue → cleanup → redis → db), absent-handle no-throw, re-entrancy single-fire, watchdog → exit(1), error → exit(1), redis.quit called exactly once (risk 4), structured `event:` on all three exit paths.
- [ ] **BOOT-005:** first unit test under `tests/unit/bootstrap/` exists and passes.
- [ ] `npm run build` clean; `npm run typecheck` clean; `npm run lint` clean; `npm run test:unit` green. (Integration suite is NOT a gate.)
- [ ] **FOUNDER DECISION REQUIRED — OQ (e) / risk 7 (watchdog × dedup collision):** BOOT-002 is NOT to be announced "closed without regressions" until the founder accepts ONE of: (i) the dedicated `drainGraceMs` window before the fatal watchdog arms — *built here, defaults to 0 unless set at the `registerShutdownHandlers` call-site* (note: `index.ts` does NOT set `drainGraceMs`/`forceExitAfterMs`, so production currently arms the watchdog immediately at the 10s default — the founder must set a conservative `forceExitAfterMs` ≥ p99-execution + termination-grace, and a non-zero `drainGraceMs`, at the call-site); or (iii) explicitly accept the tail with a documented conservative `forceExitAfterMs`. The dedup-key TTL/retry semantics fix (option (ii)) is OUT of this spec's scope and owned by the handler/idempotency layer.
- [ ] **NOTED, NOT BUILT — risk 8 (no shutdown-owned terminal callback on hard-abort):** cost-abort-mid-stream / watchdog `exit(1)` emit no `/complete` and no audit row. Separate delivery (J5/J8 tangent).
- [ ] **NOTED, NOT BUILT — OQ (f) / risk 8 (no DLQ; queue-depth instrumentation):** highest-leverage follow-up; only the structured log events + optional active-job-count log ship here. Founder decides whether Phase 3 is included.
- [ ] **NOTED, NOT BUILT — OQ (c) / J8 (AbortController-per-execution):** drain can only wait, never abort, within the grace window. Founder decides whether J8 precedes or accompanies this delivery.
- [ ] No regression to the happy path: `worker.close()` still lets each `handleExecution` finish naturally and emit its own `/complete` — shutdown does not cut an execution that would complete within the drain window.

---

## Self-Review (run against the spec)

**1. Spec coverage:**
- §4.1 (`index.ts` reorder + getters) → Task 3. ✓
- §4.2 (widen `ShutdownResources`) → Task 1. ✓
- §4.2 (ordered teardown, re-entrancy guard, watchdog, structured logs) → Task 2. ✓
- §5 Phase 1 → Tasks 1–3; Phase 2 (tests, BOOT-005) → Tasks 1, 2, 5 (tests co-built with impl per TDD). ✓
- §6 Testing strategy (ordering via `invocationCallOrder`, guard/re-entrancy/watchdog/exit-code) → Task 2 cases. ✓
- §6 single-quit invariant (risk 4) → Task 2 case "redis.quit called EXACTLY once". ✓
- §9 DoD items → mirrored in the DoD section above, including the four founder-decision/noted-not-built items. ✓
- OQ (f) minimal log-proxy → Phase 3 (Tasks 5–6), marked optional. ✓

**2. Placeholder scan:** No "TBD"/"similar to Task N"/"add error handling". Every code step shows complete code. ✓

**3. Type consistency:** `getEvalWorker`/`getCondenseQueue`/`getWorkflowCleanupJob` names match across `index.ts` (Task 3), `ShutdownResources` (Task 1), and the test getters (Task 2). The watchdog uses `drainGraceMs`/`forceExitAfterMs` consistently in the interface (Task 1), the body (Task 2), and the watchdog test (Task 2). `getActiveWorker` import/mock consistent across Task 5. The `ExitError` test helper is defined once at the top of the test file (Task 1) and reused. ✓

**Resolved during review:**
- The spec's suggested test mock list included `vi.mock` of `getHarnessConfig` — *dropped*, because `tests/setup.ts` already provides the envs `getHarnessConfig()` needs, so the real config loads fine. The only mock seam needed for log assertions is mocking the `pino` default export (the module-private logger cannot be injected) — verified against `shutdown.ts:12`.
- The spec's `forceExitAfterMs`-only watchdog was split into `drainGraceMs` + `forceExitAfterMs` (deferred-arm) to implement OQ (e) option (i) directly, so the watchdog is a pure lock-backstop by construction. Defaults preserve legacy single-timer behavior when `drainGraceMs` is unset.
