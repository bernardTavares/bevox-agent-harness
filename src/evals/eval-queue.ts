import { Queue } from "bullmq";
import type { Redis } from "ioredis";

import { getEnv } from "../config/env.js";

import type { ScorerInput } from "./scorer.js";

export interface EvalJobPayload {
  input: ScorerInput;
  sampling_reason: string;
  scorers_enabled: string[];
}

/**
 * Producer wrapper around BullMQ. The secondary `execution.evals` queue is
 * dedicated and MUST NOT compete with `bevox.execution.dispatch`.
 * Retries are deliberately conservative — eval failures are not incidents.
 */
export class EvalQueue {
  private readonly queue: Queue<EvalJobPayload>;
  private readonly queueName: string;

  constructor(connection: Redis, queueName?: string) {
    this.queueName = queueName ?? getEnv().EVALS_QUEUE_NAME;
    this.queue = new Queue<EvalJobPayload>(this.queueName, { connection });
  }

  get name(): string {
    return this.queueName;
  }

  async enqueue(payload: EvalJobPayload): Promise<void> {
    await this.queue.add("evaluate", payload, {
      removeOnComplete: 1000,
      removeOnFail: 100,
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
