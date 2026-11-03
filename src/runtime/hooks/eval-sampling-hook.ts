import { getHarnessConfig } from "../../config/harness-config.js";
import { createLogger } from "../../config/logger.js";
import type { EvalQueue } from "../../evals/eval-queue.js";
import { getEnabledScorers, getEvalQueue, getSamplingPolicy } from "../../evals/registry.js";
import { shouldSample, type SamplingPolicy } from "../../evals/sampler.js";

import type { PostExecutionHook, PostExecutionHookInput } from "./types.js";

const logger = createLogger({
  name: "eval-sampling-hook",
  level: getHarnessConfig().harness.logLevel,
});

export interface EvalSamplingHookDeps {
  /** Override for testing. Falls back to module singleton in production. */
  queue?: EvalQueue;
  policy?: SamplingPolicy;
  enabledScorers?: string[];
}

/**
 * Samples completed executions according to the configured SamplingPolicy and
 * enqueues them into `execution.evals`. Failures are swallowed by the hook
 * runner — never propagated back to the handler.
 */
export function createEvalSamplingHook(deps: EvalSamplingHookDeps = {}): PostExecutionHook {
  return {
    name: "eval-sampling",
    async run(input: PostExecutionHookInput): Promise<void> {
      const queue = deps.queue ?? getEvalQueue();
      const policy = deps.policy ?? getSamplingPolicy();
      if (!queue || !policy) {
        // Subsystem disabled — silent no-op.
        return;
      }

      const tagsRaw = (input.payload as unknown as { tags?: unknown }).tags;
      const tags: string[] | undefined = Array.isArray(tagsRaw)
        ? tagsRaw.filter((t): t is string => typeof t === "string")
        : undefined;

      const decision = shouldSample(policy, { execution_id: input.payload.execution_id, tags });
      if (!decision.sample) {
        logger.debug(
          { execution_id: input.payload.execution_id, reason: decision.reason },
          "eval_sample_skipped",
        );
        return;
      }

      const scorers = deps.enabledScorers ?? getEnabledScorers();
      await queue.enqueue({
        input: {
          input: input.lastUserMessage,
          output: input.finalResponse,
          // Context layers come from the context builder — Sprint A.2 ships
          // without builder integration. Default to empty until the builder
          // exposes a "lastBuiltContext" accessor (backlog).
          context: undefined,
          meta: {
            execution_id: input.payload.execution_id,
            organization_id: input.organizationId,
            agent_name: input.agentName,
            reasoning_engine: input.agentResponse.strategy,
          },
        },
        sampling_reason: decision.reason,
        scorers_enabled: scorers,
      });

      logger.info(
        {
          execution_id: input.payload.execution_id,
          reason: decision.reason,
          scorers: scorers.length,
        },
        "eval_enqueued",
      );
    },
  };
}
