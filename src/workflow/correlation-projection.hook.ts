/**
 * Correlation projection hook handler (Fase C §5).
 *
 * Maps the 3 lifecycle events → correlation-store ops:
 *   onSuspended    → upsertSuspended
 *   onResumed      → markRunning
 *   onWorkflowTerminal → markTerminal
 *
 * No-ops gracefully when organizationId or contactKey are absent (non-SDR workflow).
 *
 * NOTE: This handler is NOT registered here. Registration happens in C.4
 * (bootstrap). Do NOT add bus.register() calls here.
 */

import type { ExecutionLifecycleEvents, LifecyclePayload } from "../runtime/hooks/index.js";
import type { CorrelationStore } from "./correlation-store.js";

/**
 * Create a lifecycle hook handler that projects correlation events into the
 * `workflow_correlation` store.
 *
 * @param store - The CorrelationStore instance to write to.
 * @returns An ExecutionLifecycleEvents handler object ready to be registered
 *          on the hook bus via `getHookBus().register(handler)` (done in C.4).
 */
export function makeCorrelationProjectionHandler(
  store: CorrelationStore,
): ExecutionLifecycleEvents {
  return {
    async onSuspended(payload: LifecyclePayload): Promise<void> {
      const organizationId = payload["organizationId"];
      const contactKey = payload["contactKey"];

      // No-op gracefully for non-SDR workflows that lack these fields.
      if (organizationId == null || contactKey == null) return;

      const workflowExecutionId = payload["workflowExecutionId"] as string;
      const suspendToken = (payload["suspendToken"] as string | undefined) ?? null;
      const resumeEvent = (payload["resumeOn"] as string | undefined) ?? "";
      const workflowVersion = (payload["workflowVersion"] as number | undefined) ?? 0;

      await store.upsertSuspended({
        organizationId: organizationId as string,
        contactKey: contactKey as string,
        workflowExecutionId,
        suspendToken,
        resumeEvent,
        workflowVersion,
      });
    },

    async onResumed(payload: LifecyclePayload): Promise<void> {
      const organizationId = payload["organizationId"];
      const contactKey = payload["contactKey"];

      // No-op gracefully for non-SDR workflows.
      if (organizationId == null || contactKey == null) return;

      const workflowExecutionId = payload["workflowExecutionId"] as string;
      await store.markRunning(workflowExecutionId);
    },

    async onWorkflowTerminal(payload: LifecyclePayload): Promise<void> {
      const organizationId = payload["organizationId"];
      const contactKey = payload["contactKey"];

      // No-op gracefully for non-SDR workflows.
      if (organizationId == null || contactKey == null) return;

      const workflowExecutionId = payload["workflowExecutionId"] as string;
      const status = payload["status"] as "completed" | "failed";
      await store.markTerminal(workflowExecutionId, status);
    },
  };
}
