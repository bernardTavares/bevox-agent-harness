import { describe, it, expect } from 'vitest';
import { AgentHarness } from "../../../src/runtime/harness.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
import { createFakeRedis } from "../../fakes/redis.fake.js";
import type { Pool } from 'pg';

describe('AgentHarness', () => {
  const pool = {} as Pool;
  const redis = createFakeRedis();

  it('uses injected registries when provided', () => {
    const agentReg = AgentRegistry.getInstance();
    const toolReg = UnifiedToolRegistry.getInstance();
    const harness = new AgentHarness(pool, redis, {
      agentRegistry: agentReg,
      toolRegistry: toolReg
    });
    expect(harness.agentRegistry).toBe(agentReg);
    expect(harness.toolRegistry).toBe(toolReg);
    expect(harness.sessionStore).toBeDefined();
    expect(harness.agentRouter).toBeUndefined();
  });

  it('falls back to singletons', () => {
    const harness = new AgentHarness(pool, redis);
    expect(harness.agentRegistry).toBe(AgentRegistry.getInstance());
    expect(harness.toolRegistry).toBe(UnifiedToolRegistry.getInstance());
  });

  it('deprecated buildContext returns placeholder', async () => {
    const harness = new AgentHarness(pool, redis);
    await expect(harness.buildContext({})).resolves.toBe('System prompt placeholder');
  });

  it('deprecated runPipelineAgents returns default analysis', async () => {
    const harness = new AgentHarness(pool, redis);
    await expect(harness.runPipelineAgents({}, 'ctx')).resolves.toEqual({
      intent: 'unknown',
      sentiment: 'neutral'
    });
  });

  it('deprecated routeAndExecute resolves', async () => {
    const harness = new AgentHarness(pool, redis);
    await expect(harness.routeAndExecute({}, 'ctx', { intent: 'x' })).resolves.toBeUndefined();
  });
});