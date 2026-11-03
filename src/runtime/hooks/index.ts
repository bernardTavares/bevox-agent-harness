export type { PostExecutionHook, PostExecutionHookInput } from "./types.js";
export { runPostExecutionHooks } from "./runner.js";
export { createEvalSamplingHook } from "./eval-sampling-hook.js";

export type LifecyclePayload = Record<string, unknown>;

export interface ExecutionLifecycleEvents {
  onWorkflowStatusChange?: (payload: LifecyclePayload) => void | Promise<void>;
  onWorkflowTerminal?: (payload: LifecyclePayload) => void | Promise<void>;
  onSuspended?: (payload: LifecyclePayload) => void | Promise<void>;
  onResumed?: (payload: LifecyclePayload) => void | Promise<void>;
}

class HookBus {
  private handlers: ExecutionLifecycleEvents[] = [];
  register(handler: ExecutionLifecycleEvents): void {
    this.handlers.push(handler);
  }
  clear(): void {
    this.handlers = [];
  }
  async emit(event: keyof ExecutionLifecycleEvents, payload: LifecyclePayload): Promise<void> {
    for (const h of this.handlers) {
      const fn = h[event];
      if (!fn) continue;
      try {
        await fn(payload);
      } catch {
        /* best-effort */
      }
    }
  }
}

let bus: HookBus | undefined;
export function getHookBus(): HookBus {
  if (!bus) bus = new HookBus();
  return bus;
}
export function resetHookBusForTests(): void {
  bus = new HookBus();
}
