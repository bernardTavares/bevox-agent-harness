import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import IORedis from "ioredis";
import { Pool } from "pg";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { setupInfra, applyMigrations } from "../helpers/integration-setup.js";

const RUN = process.env.RUN_INTEGRATION === "1";

// Hoisted mocks for outbound effects — match unit test pattern
const callbackMock = vi.hoisted(() => ({
  updateStatus: vi.fn().mockResolvedValue(undefined),
  sendComplete: vi.fn().mockResolvedValue(undefined),
  sendTrace: vi.fn().mockResolvedValue(undefined),
  sendStream: vi.fn().mockResolvedValue(undefined),
  // Real impl pass-through (helper é pure, post-2026-06-02 C2/C3 fix).
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
    ...(opts.proposals && opts.proposals.length > 0 ? { proposals: opts.proposals } : {}),
  }),
}));

const gatewayMock = vi.hoisted(() => ({
  createLLMGateway: vi.fn(),
}));

vi.mock("../../src/integration/bevox-callback", () => callbackMock);
vi.mock("../../src/integration/llm-gateway", async () => {
  const actual = await vi.importActual<typeof import("../../src/integration/llm-gateway")>(
    "../../src/integration/llm-gateway",
  );
  return { ...actual, createLLMGateway: gatewayMock.createLLMGateway };
});

import { handleExecution, type ExecutionContext } from "../../src/runtime/execution-handler.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../src/runtime/agent-router.js";
import { BaseAgent } from "../../src/agents/base-agent.js";
import type { AgentResult } from "../../src/agents/types.js";
import { FakeLLMGateway } from "../fakes/llm-gateway.fake.js";

class StubAnalyzer extends BaseAgent {
  constructor() {
    super({
      name: "message-analyzer",
      type: "pipeline",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    });
  }
  async execute(): Promise<AgentResult> {
    return {
      success: true,
      output: {
        intent: "scheduling",
        sentiment: "neutral",
        sentimentConfidence: 0.5,
        topics: [],
        urgency: "medium",
      },
    };
  }
}

class StubScheduler extends BaseAgent {
  constructor() {
    super({
      name: "scheduler",
      type: "surface",
      description: "t",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    });
  }
  async execute(): Promise<AgentResult> {
    return { success: true, output: "ok" };
  }
}

const VALID_UUID = "44444444-4444-4444-8444-444444444444";

describe.skipIf(!RUN)("execution-handler (integration)", () => {
  let teardown: () => Promise<void>;
  let pool: Pool;
  let redis: IORedis;

  beforeAll(async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "harness-empty-migrations-"));
    const infra = await setupInfra({ migrationsDir: emptyDir });
    teardown = infra.teardown;
    pool = new Pool({ connectionString: infra.databaseUrl });
    redis = new IORedis(infra.redisUrl, { maxRetriesPerRequest: null });
    await pool.query(`
      CREATE TABLE accounts (id SERIAL PRIMARY KEY, name TEXT);
      INSERT INTO accounts (id, name) VALUES (1, 'test');
    `);
    await applyMigrations(infra.databaseUrl, join(__dirname, "..", "..", "migrations"));
  }, 120_000);

  afterAll(async () => {
    await redis?.quit();
    await pool?.end();
    if (teardown) await teardown();
  }, 60_000);

  it("runs end-to-end against real Postgres + Redis with stubbed pipeline agents", async () => {
    gatewayMock.createLLMGateway.mockReturnValue(
      new FakeLLMGateway({
        defaultResponse: {
          content: "Final",
          tool_calls: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          model: "fake",
          provider: "fake",
          latency_ms: 1,
        },
      }),
    );

    // Fresh singletons
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AgentRegistry as any).instance = undefined;
    UnifiedToolRegistry.resetForTests();
    const agentRegistry = AgentRegistry.getInstance();
    const toolRegistry = UnifiedToolRegistry.getInstance();
    agentRegistry.register(new StubAnalyzer());
    agentRegistry.register(new StubScheduler());

    const ctx: ExecutionContext = {
      db: pool,
      redis,
      agentRegistry,
      toolRegistry,
      agentRouter: createAgentRouter(),
    };

    await handleExecution(
      {
        execution_id: VALID_UUID,
        execution_token: "a-very-long-token-value-1234567890",
        organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        messages: [{ role: "user", content: "Quero agendar" }],
      },
      ctx,
    );

    expect(callbackMock.sendComplete).toHaveBeenCalled();
    // Session persisted in real Redis
    const raw = await redis.get(`harness:session:${VALID_UUID}`);
    expect(raw).not.toBeNull();
    const session = JSON.parse(raw as string);
    expect(session.state.status).toBe("completed");
    expect(session.state.organizationId).toBe(1);

    // Dedup key set in real Redis
    const dedup = await redis.get(`harness:dedup:${VALID_UUID}`);
    expect(dedup).toBe("1");
  }, 60_000);

  it("system_prompt flows to role:system channel, not concatenated into user/goal (§3.4)", async () => {
    const SP_UUID = "55555555-5555-5555-8555-555555555555";
    const fakeGateway = new FakeLLMGateway({
      defaultResponse: {
        content: JSON.stringify({ output: "done", confidence: 0.9 }),
        tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        model: "fake",
        provider: "fake",
        latency_ms: 1,
      },
    });
    gatewayMock.createLLMGateway.mockReturnValue(fakeGateway);

    // Fresh singletons
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AgentRegistry as any).instance = undefined;
    UnifiedToolRegistry.resetForTests();
    const agentRegistry = AgentRegistry.getInstance();
    const toolRegistry = UnifiedToolRegistry.getInstance();

    // StubScheduler with react reasoning so doctrine flows through
    class StubSchedulerReact extends BaseAgent {
      constructor() {
        super({
          name: "scheduler",
          type: "surface",
          description: "t",
          reasoning: { default: "react" },
          permissions: { required: [], denied: [] },
        });
      }
      async execute(): Promise<AgentResult> {
        return { success: true, output: "ok" };
      }
    }

    agentRegistry.register(new StubAnalyzer());
    agentRegistry.register(new StubSchedulerReact());

    const ctx: ExecutionContext = {
      db: pool,
      redis,
      agentRegistry,
      toolRegistry,
      agentRouter: createAgentRouter(),
    };

    await handleExecution(
      {
        execution_id: SP_UUID,
        execution_token: "a-very-long-token-value-1234567890",
        organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        messages: [{ role: "user", content: "Quero agendar" }],
        agent_config: { system_prompt: "BASE_SP" },
      },
      ctx,
    );

    // Collect all LLMMessage arrays from every gateway call
    const allMessages = fakeGateway.calls.flatMap((c) => c.messages);

    // (a) BASE_SP must arrive as a standalone doctrine message (exact content = "BASE_SP"),
    //     not embedded inside a larger system prompt derived from plan.goal
    expect(allMessages.some((m) => m.role === "system" && m.content.trim() === "BASE_SP")).toBe(
      true,
    );

    // (b) BASE_SP must NOT appear embedded in the goal-derived ReAct system prompt
    //     (which would look like "…executing the following goal:\nBASE_SP\n\nUser request:…")
    expect(
      allMessages.some(
        (m) =>
          m.role === "system" && m.content.includes("BASE_SP") && m.content.trim() !== "BASE_SP",
      ),
    ).toBe(false);
  }, 60_000);

  it("second call with same execution_id is deduplicated", async () => {
    callbackMock.updateStatus.mockClear();
    callbackMock.sendComplete.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AgentRegistry as any).instance = undefined;
    UnifiedToolRegistry.resetForTests();
    const agentRegistry = AgentRegistry.getInstance();
    agentRegistry.register(new StubAnalyzer());
    agentRegistry.register(new StubScheduler());

    const ctx: ExecutionContext = {
      db: pool,
      redis,
      agentRegistry,
      toolRegistry: UnifiedToolRegistry.getInstance(),
      agentRouter: createAgentRouter(),
    };
    await handleExecution(
      {
        execution_id: VALID_UUID,
        execution_token: "a-very-long-token-value-1234567890",
        organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        messages: [{ role: "user", content: "second time" }],
      },
      ctx,
    );
    // Dedup short-circuit: no callbacks
    expect(callbackMock.sendComplete).not.toHaveBeenCalled();
    expect(callbackMock.updateStatus).not.toHaveBeenCalled();
  }, 30_000);
});
