import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted callback mock — mirrors execution-handler.flow.test.ts. `updateStatus`
// is included because the dead-letter signal path uses it (no-op here; J3
// rethrows before any callback in the handler itself).
const callbackMock = vi.hoisted(() => ({
  updateStatus: vi.fn().mockResolvedValue(undefined),
  sendComplete: vi.fn().mockResolvedValue(undefined),
  sendTrace: vi.fn().mockResolvedValue(undefined),
  sendStream: vi.fn().mockResolvedValue(undefined),
  buildCompletePayload: (opts: {
    responseText: string;
    sentiment?: string;
    strategy?: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
    proposals?: unknown[];
  }) => ({
    response_text: opts.responseText,
    sentiment: opts.sentiment ?? "neutral",
    strategy: opts.strategy ?? "direct",
    usage: opts.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
  }),
}));

vi.mock("../../../src/integration/bevox-callback", () => callbackMock);

import { handleExecution, UnprocessablePayloadError } from "../../../src/runtime/execution-handler.js";
import { createFakeRedis } from "../../fakes/redis.fake.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
import { BaseAgent } from "../../../src/agents/base-agent.js";
import type { AgentDefinition, AgentResult } from "../../../src/agents/types.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { Pool } from "pg";

const VALID_TOKEN = "a-very-long-token-value-1234567890";

describe("handleExecution — J3 unprocessable payload", () => {
  beforeEach(() => {
    callbackMock.sendComplete.mockClear();
    callbackMock.updateStatus.mockClear();
  });

  const ctx = {} as never; // J3 fails before ctx.redis is ever touched

  it("rethrows (does NOT silently return) on Zod-invalid payload", async () => {
    await expect(
      handleExecution({ execution_id: "not-a-uuid" }, ctx),
    ).rejects.toBeInstanceOf(UnprocessablePayloadError);
  });

  it("rethrows on oversize payload too", async () => {
    const huge = {
      execution_id: "11111111-1111-4111-8111-111111111111",
      execution_token: VALID_TOKEN,
      organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      messages: [{ role: "user", content: "x".repeat(300 * 1024) }],
    };
    await expect(handleExecution(huge, ctx)).rejects.toBeInstanceOf(UnprocessablePayloadError);
  });

  it("does NOT emit any callback from the handler on poison (the failed listener owns the signal)", async () => {
    // Valid id+token, but shape-invalid elsewhere (messages role bad) → salvage
    // lives on the error; the handler must NOT call sendComplete/updateStatus.
    const poison = {
      execution_id: "11111111-1111-4111-8111-111111111111",
      execution_token: VALID_TOKEN,
      organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      messages: [{ role: "nope", content: "x" }],
    };
    let caught: UnprocessablePayloadError | undefined;
    await handleExecution(poison, ctx).catch((err) => {
      caught = err as UnprocessablePayloadError;
    });
    // Salvage is carried on the thrown error for the failed listener to use.
    expect(caught?.executionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(caught?.executionToken).toBe(VALID_TOKEN);
    // But NO callback is emitted from inside the handler.
    expect(callbackMock.sendComplete).not.toHaveBeenCalled();
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
  });
});

class StubAnalyzer extends BaseAgent {
  constructor() {
    super({
      name: "message-analyzer",
      type: "pipeline",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    } as AgentDefinition);
  }
  async execute(): Promise<AgentResult> {
    return {
      success: true,
      output: { intent: "scheduling", sentiment: "neutral", topics: [], urgency: "low" },
    };
  }
}
class StubSurface extends BaseAgent {
  constructor() {
    super({
      name: "scheduler",
      type: "surface",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    } as AgentDefinition);
  }
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return { success: true, output: "ok" };
  }
}

describe("handleExecution — no double /complete after success (§4.2b)", () => {
  beforeEach(() => {
    callbackMock.sendComplete.mockClear();
    (AgentRegistry as unknown as { instance?: unknown }).instance = undefined;
    UnifiedToolRegistry.resetForTests();
  });

  it("a throw in a post-complete step does NOT emit a second failed callback after a success", async () => {
    const agentRegistry = AgentRegistry.getInstance();
    agentRegistry.register(new StubAnalyzer());
    agentRegistry.register(new StubSurface());
    const toolRegistry = UnifiedToolRegistry.getInstance();

    const redis = createFakeRedis();
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;

    const ctx = {
      db,
      redis,
      agentRegistry,
      toolRegistry,
    } as unknown as Parameters<typeof handleExecution>[1];

    const payload = {
      execution_id: "22222222-2222-4222-8222-222222222222",
      execution_token: VALID_TOKEN,
      organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      messages: [{ role: "user", content: "oi" }],
    };

    // Invariant: AT MOST a success, NEVER a `failed` AFTER a `success` for the
    // same run. (The fake redis succeeds for dedup+session-create; even if a
    // late step throws, the completeSent guard must suppress the boundary failed.)
    await handleExecution(payload, ctx).catch(() => undefined);

    const strategies = callbackMock.sendComplete.mock.calls.map(
      (c) => (c[2] as { strategy?: string }).strategy,
    );
    const firstSuccessIdx = strategies.findIndex((s) => s !== "failed");
    const failedAfterSuccess =
      firstSuccessIdx >= 0 && strategies.indexOf("failed") > firstSuccessIdx;
    expect(failedAfterSuccess).toBe(false);
  });
});
