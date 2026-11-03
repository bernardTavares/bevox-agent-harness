import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import { getEnv } from "../config/env.js";

import type { EvalJobPayload } from "./eval-queue.js";
import type { EvalRunner } from "./runner.js";
import type { EvalResultsRepository } from "./repository.js";

export interface EvalWorkerDeps {
  connection: Redis;
  runner: EvalRunner;
  repo: EvalResultsRepository;
  logger: Logger;
}

/**
 * Consumes `execution.evals` jobs, runs scorers, persists results.
 * Currently runs in-process when EVALS_WORKER_ENABLED=true (architecture note:
 * future deployments can isolate by running a separate process with only
 * this flag set).
 */
export function startEvalWorker(deps: EvalWorkerDeps): Worker<EvalJobPayload> {
  const env = getEnv();
  const queueName = env.EVALS_QUEUE_NAME;

  const worker = new Worker<EvalJobPayload>(
    queueName,
    async (job: Job<EvalJobPayload>) => {
      const { input, sampling_reason, scorers_enabled } = job.data;

      // Filter runner scorers to those enabled for this job (best-effort).
      const enabledSet = new Set(scorers_enabled);
      const enabledScorers = deps.runner.registeredScorers.filter((s) => enabledSet.has(s.name));

      // Build a transient runner if subset differs.
      const runner =
        enabledScorers.length === deps.runner.registeredScorers.length
          ? deps.runner
          : new (await import("./runner.js")).EvalRunner(enabledScorers, deps.logger);

      const results = await runner.run(input);

      for (const r of results) {
        if ("error" in r.result) continue;
        await deps.repo.insert({
          executionId: input.meta.execution_id,
          organizationId: input.meta.organization_id,
          scorerName: r.scorer,
          scorerKind: r.kind,
          score: r.result.score,
          reasoning: r.result.reasoning,
          modelUsed: r.result.model_used,
          samplingReason: sampling_reason,
        });
      }

      deps.logger.info(
        {
          execution_id: input.meta.execution_id,
          scorers_run: results.length,
          sampling_reason,
        },
        "evals_completed",
      );
    },
    { connection: deps.connection, concurrency: env.EVALS_WORKER_CONCURRENCY },
  );

  worker.on("failed", (job, err) => {
    deps.logger.warn(
      {
        job_id: job?.id,
        execution_id: job?.data?.input?.meta?.execution_id,
        err: err.message,
      },
      "eval_job_failed",
    );
  });

  return worker;
}
