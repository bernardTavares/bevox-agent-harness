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

export function registerShutdownHandlers(resources: ShutdownResources): void {
  let isShuttingDown = false; // per-registration re-entrancy guard (risk 2)

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      logger.warn({ signal }, "Shutdown already in progress — ignoring repeat signal");
      return;
    }
    isShuttingDown = true;
    // OQ (f): we previously logged a best-effort `activeJobs` count here, but
    // BullMQ's `Worker` (5.76.x) does NOT expose `getActiveCount()` — that
    // getter lives on `Queue` (QueueGetters), and the harness never holds a
    // Queue handle. The structural probe therefore NEVER matched and always
    // logged `activeJobs: undefined` (zero operator signal). Dropped the
    // misleading field rather than ship a constant-undefined. The in-flight
    // count can be surfaced honestly once a metrics layer / Queue accessor
    // exists.
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
    } catch (err) {
      clearTimers();
      logger.error({ event: "shutdown.error", signal, err }, "Error during shutdown");
      process.exit(1);
      return;
    }
    // exit OUTSIDE the try so a real process.exit(0) (or the test stub that
    // models it) never unwinds into the catch and mislabels success as an
    // error. A real exit terminates the process here; the return is for tests.
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
