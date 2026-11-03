/**
 * Shared setup for runtime-invariant tests under
 * `tests/unit/runtime/invariants/`.
 *
 * Background: the invariant tests all drive `handleExecution` end-to-end with
 * the same stubbed seams (bevox-callback, llm-gateway factory, strategy-router)
 * and the same dummy agents/registries. Extracted from `perm-03-ordering` and
 * `ctx-02-budget-enforce` after coverage-uplift Task 2.5 (PR 0); subsequent
 * tasks (3-12) consume this surface so we don't grow N copies of the same
 * boilerplate.
 *
 * Vitest hoisting note (CRITICAL — read before adding helpers):
 *   - `vi.hoisted(...)` values CANNOT be exported from this module. Vitest's
 *     transformer rejects with "Cannot export hoisted variable".
 *   - Wrapping a factory call from this module inside the consumer's
 *     `vi.hoisted(() => createCallbackMock())` ALSO fails — vitest hoists the
 *     `vi.hoisted` block above the top-level imports of this module, so the
 *     factory reference is `undefined` at hoist-time
 *     ("Cannot access '__vi_import_2__' before initialization").
 *   - Async `vi.hoisted` with `await import(...)` would return a Promise to
 *     the consumer's `vi.mock` factory, which won't auto-await.
 *
 *   This was RE-VERIFIED experimentally in Task 4 (coverage-uplift PR 0,
 *   2026-06-03). The hypothesis "factory-call-in-hoisted works because the
 *   factory module is resolved by import time" is WRONG. Vitest hoists
 *   `vi.hoisted(...)` blocks above the consumer file's top-level imports,
 *   so the imported factory reference (e.g. `makeCallbackMock`) is still in
 *   its TDZ when the hoisted body executes. All three invariant tests
 *   (perm-03 / ctx-02 / em-03) failed identically with
 *   "Cannot access '__vi_import_2__' before initialization" when refactored
 *   to `vi.hoisted(() => makeCallbackMock())`. Do not re-attempt this
 *   extraction without a fundamentally different mechanism (e.g.
 *   vitest setup-files that mutate a shared mock registry before any
 *   `vi.hoisted` runs — and that has its own pitfalls).
 *
 *   Net: the three standard hoisted mocks (`callbackMock`, `gatewayMock`,
 *   `routerMock`) stay duplicated inline in each consumer test file. Only
 *   non-hoisted helpers live here. This trade is documented to spare the
 *   next person re-discovering it.
 *
 * YAGNI: keep this surface tight. If a future invariant test needs a new
 * shared piece (e.g. mutation-tool registration helpers), prefer to keep it
 * local until a SECOND consumer needs it.
 */

import { AgentRegistry } from "../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../src/tools/unified-registry.js";
import { BaseAgent } from "../../src/agents/base-agent.js";
import type { AgentResult } from "../../src/agents/types.js";
import type { AgentExecutionContext } from "../../src/agents/execution-context.js";

// ---------------------------------------------------------------------------
// Stub agents — same shape as execution-handler.flow.test.ts.
// `StubSurfaceAgent` accepts an optional `required` permissions array so
// tests that exercise the runtime permission gate (PERM-03 needs
// `["waitlist-add"]`) can opt in; default `[]` matches the CTX-02 case.
// ---------------------------------------------------------------------------

export class StubMessageAnalyzer extends BaseAgent {
  constructor() {
    super({
      name: "message-analyzer",
      type: "pipeline",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    });
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return {
      success: true,
      output: {
        intent: "scheduling",
        sentiment: "neutral",
        sentimentConfidence: 0.9,
        topics: [],
        urgency: "medium",
      },
    };
  }
}

export class StubSurfaceAgent extends BaseAgent {
  constructor(required: string[] = []) {
    super({
      name: "scheduler",
      type: "surface",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required, denied: [] },
    });
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return { success: true, output: "ok" };
  }
}

// ---------------------------------------------------------------------------
// Fresh registry pattern — copied verbatim from
// `tests/unit/runtime/execution-handler.flow.test.ts`. Tests call this in
// `beforeEach` to get clean singleton instances per test.
// ---------------------------------------------------------------------------

export function freshRegistries(): {
  agentRegistry: AgentRegistry;
  toolRegistry: UnifiedToolRegistry;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (AgentRegistry as any).instance = undefined;
  UnifiedToolRegistry.resetForTests();
  return {
    agentRegistry: AgentRegistry.getInstance(),
    toolRegistry: UnifiedToolRegistry.getInstance(),
  };
}

// ---------------------------------------------------------------------------
// Test constants + base payload builder.
// ---------------------------------------------------------------------------

export const VALID_UUID = "11111111-1111-4111-8111-111111111111";
export const VALID_TOKEN = "a-very-long-token-value-1234567890";

/**
 * Minimal valid execution payload. Pass `over` to inject test-specific bits
 * (e.g. `messages`, `sdr_profile`, headers).
 */
export function basePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_id: VALID_UUID,
    execution_token: VALID_TOKEN,
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    messages: [{ role: "user", content: "hi" }],
    ...over,
  };
}
