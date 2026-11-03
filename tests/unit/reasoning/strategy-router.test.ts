import { describe, it, expect } from 'vitest';
import { StrategyRouter, strategyRouter } from "../../../src/reasoning/strategy-router.js";
import { DirectEngine } from "../../../src/reasoning/direct.js";
import { ReactEngine } from "../../../src/reasoning/react.js";
import { PlanExecuteEngine } from "../../../src/reasoning/plan-execute.js";
import { ReWOOEngine } from "../../../src/reasoning/rewoo.js";
import { ReflexionWrapper } from "../../../src/reasoning/reflexion.js";
import { makeContext } from "./_helpers.js";
import type { AgentDefinition } from "../../../src/agents/types.js";

function mkAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'test-agent',
    type: 'surface',
    description: 'test',
    reasoning: { default: 'react' },
    permissions: { required: [], denied: [] },
    ...overrides
  };
}

describe('StrategyRouter', () => {
  it('exports a singleton', () => {
    expect(strategyRouter).toBeInstanceOf(StrategyRouter);
  });

  it('builds a DirectEngine for default=direct', () => {
    const router = new StrategyRouter();
    const engine = router.build(
      mkAgent({ reasoning: { default: 'direct' } }),
      makeContext()
    );
    expect(engine).toBeInstanceOf(DirectEngine);
    expect(engine.strategy).toBe('direct');
  });

  it('builds a ReactEngine for default=react', () => {
    const router = new StrategyRouter();
    const engine = router.build(
      mkAgent({ reasoning: { default: 'react' } }),
      makeContext()
    );
    expect(engine).toBeInstanceOf(ReactEngine);
    expect(engine.strategy).toBe('react');
  });

  it('builds a PlanExecuteEngine for default=plan-execute', () => {
    const router = new StrategyRouter();
    const engine = router.build(
      mkAgent({ reasoning: { default: 'plan-execute' } }),
      makeContext()
    );
    expect(engine).toBeInstanceOf(PlanExecuteEngine);
    expect(engine.strategy).toBe('plan-execute');
  });

  it('builds a ReWOOEngine for default=rewoo', () => {
    const router = new StrategyRouter();
    const engine = router.build(
      mkAgent({ reasoning: { default: 'rewoo' } }),
      makeContext()
    );
    expect(engine).toBeInstanceOf(ReWOOEngine);
    expect(engine.strategy).toBe('rewoo');
  });

  it('wraps engine in ReflexionWrapper when escalation.onFailure === reflexion', () => {
    const router = new StrategyRouter();
    const engine = router.build(
      mkAgent({
        reasoning: { default: 'react', escalation: { onFailure: 'reflexion' } }
      }),
      makeContext()
    );
    expect(engine).toBeInstanceOf(ReflexionWrapper);
    // Strategy is delegated to the inner engine
    expect(engine.strategy).toBe('react');
  });

  it('does NOT wrap in ReflexionWrapper when no escalation provided', () => {
    const router = new StrategyRouter();
    const engine = router.build(
      mkAgent({ reasoning: { default: 'react' } }),
      makeContext()
    );
    expect(engine).not.toBeInstanceOf(ReflexionWrapper);
  });

  it('infers default=direct for pipeline agents when reasoning.default missing', () => {
    const router = new StrategyRouter();
    const agent: AgentDefinition = {
      name: 'pipeline-x',
      type: 'pipeline',
      description: '',
      reasoning: undefined as unknown as AgentDefinition['reasoning'],
      permissions: { required: [], denied: [] }
    };
    const engine = router.build(agent, makeContext());
    expect(engine.strategy).toBe('direct');
  });

  it('infers default=react for surface agents when reasoning.default missing', () => {
    const router = new StrategyRouter();
    const agent: AgentDefinition = {
      name: 'surface-x',
      type: 'surface',
      description: '',
      reasoning: undefined as unknown as AgentDefinition['reasoning'],
      permissions: { required: [], denied: [] }
    };
    const engine = router.build(agent, makeContext());
    expect(engine.strategy).toBe('react');
  });

  it('the produced engine satisfies the ReasoningEngine contract (has all 5 methods)', () => {
    const router = new StrategyRouter();
    const engine = router.build(
      mkAgent({ reasoning: { default: 'react' } }),
      makeContext()
    );
    expect(typeof engine.plan).toBe('function');
    expect(typeof engine.step).toBe('function');
    expect(typeof engine.observe).toBe('function');
    expect(typeof engine.shouldContinue).toBe('function');
    expect(typeof engine.synthesize).toBe('function');
  });
});