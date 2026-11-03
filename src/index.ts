import { runBootstrap } from "./bootstrap/runner.js";
import { registerShutdownHandlers } from "./bootstrap/shutdown.js";
import { getWorkflowCleanupJob } from "./bootstrap/stages.js";
import { getHarnessConfig } from "./config/harness-config.js";
import { getEvalWorker } from "./evals/registry.js";
import { getCondenseQueue } from "./memory/registry.js";

/**
 * Grace added on top of the max execution budget before the shutdown watchdog
 * force-exits. Keeps the force-exit window strictly >= the budget so a healthy
 * in-flight execution (LLM + tools + /complete) is never cut mid-flight; the
 * watchdog stays a pure lock-backstop.
 */
const WATCHDOG_FORCE_EXIT_GRACE_MS = 5_000;

const main = async (): Promise<void> => {
  // 1. Bootstrap FIRST so the owning resources (pg Pool, bootstrap Redis) and
  //    the opt-in lifecycle handles exist before we register signal handlers.
  const ctx = await runBootstrap();

  // 2. Thread the REAL handles. db/redis are the bootstrap-owned connections;
  //    the three getters resolve opt-in handles lazily at signal time (each is
  //    undefined when its feature flag is off — every close in shutdown.ts is
  //    guarded). Fixes BOOT-002: previously `registerShutdownHandlers({})`
  //    meant redis.quit()/db.end() never ran.
  // Cap the watchdog's force-exit window at the execution budget (+grace) so
  // it never undercuts a healthy in-flight execution. Without this, the
  // default forceExitAfterMs (10s) is < the max execution budget (90s) and a
  // long-but-healthy execution gets exit(1) mid-flight.
  const { maxExecutionTimeMs } = getHarnessConfig().harness;

  registerShutdownHandlers({
    db: ctx.db,
    redis: ctx.redis,
    getEvalWorker,
    getCondenseQueue,
    getWorkflowCleanupJob,
    forceExitAfterMs: maxExecutionTimeMs + WATCHDOG_FORCE_EXIT_GRACE_MS,
  });

  console.log("Agent Harness is running");
};

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
