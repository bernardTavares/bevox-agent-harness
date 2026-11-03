import { createLogger } from "../config/logger.js";

import type { WorkflowStateStore } from "./state-store.js";

const logger = createLogger({ name: "workflow-cleanup" });

export interface CleanupOptions {
  store: WorkflowStateStore;
  /** Max rows to expire per tick. */
  batchSize?: number;
  /** Polling interval in ms. */
  intervalMs?: number;
}

/**
 * Background sweep that fails workflows whose `timeout_at` has passed.
 * Single-process implementation — for multi-worker deployments coordinate
 * via Redis lock (out of scope for V1).
 */
export class WorkflowCleanupJob {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: CleanupOptions) {}

  start(): void {
    const interval = this.opts.intervalMs ?? 5 * 60 * 1000;
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.error({ err }, "workflow cleanup tick failed"));
    }, interval);
    // Don't keep the event loop alive for this alone.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<number> {
    const expired = await this.opts.store.listExpired(new Date(), this.opts.batchSize ?? 100);
    for (const row of expired) {
      const claimed = await this.opts.store.claimForExpiry(row.id, {
        reason: "timeout",
        resumeOn: row.resumeEvent,
      });
      if (!claimed) {
        // Lost the race — a concurrent resume already claimed this row.
        // Skip silently; do NOT log as error (this is expected behaviour).
        continue;
      }
      logger.info(
        { workflowExecutionId: row.id, workflowId: row.workflowId },
        "workflow expired by cleanup job",
      );
    }
    return expired.length;
  }
}
