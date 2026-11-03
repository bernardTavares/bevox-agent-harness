import { getHarnessConfig } from "../../config/harness-config.js";
import { createLogger } from "../../config/logger.js";

import type { PostExecutionHook, PostExecutionHookInput } from "./types.js";

const logger = createLogger({
  name: "post-execution-hooks",
  level: getHarnessConfig().harness.logLevel,
});

/**
 * Runs every registered post-execution hook with strict error containment.
 * Hook errors are logged at WARN level and swallowed.
 */
export async function runPostExecutionHooks(
  hooks: PostExecutionHook[],
  input: PostExecutionHookInput,
): Promise<void> {
  await Promise.all(
    hooks.map(async (hook) => {
      try {
        await hook.run(input);
      } catch (err) {
        logger.warn(
          {
            hook: hook.name,
            err: err instanceof Error ? err.message : String(err),
            execution_id: input.payload.execution_id,
          },
          "post_execution_hook_failed_swallowed",
        );
      }
    }),
  );
}
