/**
 * Sprint D.3 — Condense queue helpers.
 *
 * Producer-side: `enqueueCondense` deduplicates by jobId so at most ONE
 * pending condense job exists per (organization, contact). BullMQ ignores `add`
 * when a job with the same `jobId` is already in the queue.
 *
 * Consumer-side: `createCondenseWorker` is the BullMQ Worker that the
 * dedicated `worker:condense` process boots. It delegates to
 * `ObservationalCondenser.maybeCondense()` which performs the heuristic
 * + LLM call + DB writes.
 */

import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";

import { getEnv } from "../config/env.js";
import { createLogger } from "../config/logger.js";
import type { ObservationalCondenser } from "../memory/observational-condenser.js";

export interface CondenseJobData {
  organizationId: string;
  /** bigint as string — BullMQ serializes job data via JSON which has no bigint. */
  contactId: string;
}

export function getCondenseQueueName(): string {
  return getEnv().MEMORY_CONDENSE_QUEUE_NAME;
}

export function createCondenseQueue(connection: ConnectionOptions): Queue<CondenseJobData> {
  return new Queue<CondenseJobData>(getCondenseQueueName(), { connection });
}

export async function enqueueCondense(
  queue: Queue<CondenseJobData>,
  organizationId: string,
  contactId: bigint,
): Promise<void> {
  const jobId = `condense:${organizationId}:${contactId.toString()}`;
  await queue.add(
    "condense",
    { organizationId, contactId: contactId.toString() },
    {
      jobId,
      removeOnComplete: true,
      removeOnFail: { age: 3600 },
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
    },
  );
}

export interface CondenseWorkerOptions {
  connection: ConnectionOptions;
  condenser: ObservationalCondenser;
  concurrency?: number;
}

export function createCondenseWorker(opts: CondenseWorkerOptions): Worker<CondenseJobData> {
  const logger = createLogger({ name: "condense-worker", level: "info" });
  const concurrency = opts.concurrency ?? getEnv().MEMORY_CONDENSE_WORKER_CONCURRENCY;

  return new Worker<CondenseJobData>(
    getCondenseQueueName(),
    async (job: Job<CondenseJobData>) => {
      const organizationId = job.data.organizationId;
      const contactId = BigInt(job.data.contactId);
      const result = await opts.condenser.maybeCondense(organizationId, contactId);
      logger.info({ organizationId, contactId: contactId.toString(), result }, "condense job done");
      return result;
    },
    {
      connection: opts.connection,
      concurrency,
    },
  );
}
