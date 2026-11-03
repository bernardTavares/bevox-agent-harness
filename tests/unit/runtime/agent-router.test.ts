import { describe, it, expect } from 'vitest';
import {
  AgentRouter,
  DEFAULT_ROUTE_RULES,
  createAgentRouter,
  type RouteRule } from
"../../../src/runtime/agent-router.js";
import type { AgentRegistry } from "../../../src/agents/registry.js";

function makeRegistry(registered: string[]): AgentRegistry {
  return {
    has: (name: string) => registered.includes(name)
  } as unknown as AgentRegistry;
}

describe('AgentRouter', () => {
  it('resolves a matching intent to its registered agent', () => {
    const router = createAgentRouter();
    const registry = makeRegistry(['scheduler']);
    expect(router.resolve('scheduling', registry)).toBe('scheduler');
    expect(router.resolve('scheduling_cancellation', registry)).toBe('scheduler');
    expect(router.resolve('question', registry)).toBe('scheduler');
  });

  it('falls back to "request-human" when the matched agent is not registered', () => {
    const router = createAgentRouter();
    const registry = makeRegistry([]); // nothing registered
    expect(router.resolve('scheduling', registry)).toBe('request-human');
  });

  it('falls back to "request-human" when no rule matches', () => {
    const router = createAgentRouter();
    const registry = makeRegistry(['scheduler']);
    expect(router.resolve('completely_unknown_intent', registry)).toBe('request-human');
  });

  it('respects priority ordering — higher priority wins', () => {
    const rules: RouteRule[] = [
    { intent: 'foo', agent: 'low-prio', fallback: 'request-human', priority: 1 },
    { intent: 'foo', agent: 'high-prio', fallback: 'request-human', priority: 10 }];

    const router = new AgentRouter({ rules });
    const registry = makeRegistry(['low-prio', 'high-prio']);
    expect(router.resolve('foo', registry)).toBe('high-prio');
  });

  it('supports array intents on a single rule', () => {
    const rules: RouteRule[] = [
    { intent: ['a', 'b', 'c'], agent: 'multi', fallback: 'request-human', priority: 1 }];

    const router = new AgentRouter({ rules });
    const registry = makeRegistry(['multi']);
    expect(router.resolve('a', registry)).toBe('multi');
    expect(router.resolve('b', registry)).toBe('multi');
    expect(router.resolve('c', registry)).toBe('multi');
    expect(router.resolve('d', registry)).toBe('request-human');
  });

  it('uses the configured fallback when agent missing', () => {
    const rules: RouteRule[] = [
    { intent: 'x', agent: 'absent', fallback: 'custom-fallback', priority: 1 }];

    const router = new AgentRouter({ rules });
    const registry = makeRegistry([]);
    expect(router.resolve('x', registry)).toBe('custom-fallback');
  });

  it('DEFAULT_ROUTE_RULES contains scheduler intents', () => {
    const intents = DEFAULT_ROUTE_RULES.flatMap((r) =>
    Array.isArray(r.intent) ? r.intent : [r.intent]
    );
    expect(intents).toContain('scheduling');
    expect(intents).toContain('scheduling_cancellation');
    expect(intents).toContain('unknown');
  });

  it('createAgentRouter merges extraRules with defaults', () => {
    const extra: RouteRule[] = [
    { intent: 'special', agent: 'special-agent', fallback: 'request-human', priority: 99 }];

    const router = createAgentRouter(extra);
    const registry = makeRegistry(['special-agent', 'scheduler']);
    expect(router.resolve('special', registry)).toBe('special-agent');
    expect(router.resolve('scheduling', registry)).toBe('scheduler');
  });
});