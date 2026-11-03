import { describe, it, expect } from 'vitest';
import {
  StepEvaluator,
  stepEvaluator,
  type EscalationConfig } from
"../../../src/reasoning/step-evaluator.js";
import type { Observation, Plan } from "../../../src/reasoning/engine.js";

const baseConfig: EscalationConfig = {
  stepThreshold: 5,
  parallelThreshold: 3,
  onFailure: 'reflexion',
  escalateTo: 'plan-execute'
};

function mkObs(stepIndex: number, success = true, errorMessage?: string): Observation {
  return {
    stepIndex,
    summary: success ? 'ok' : '[Error]',
    success,
    raw: { stepIndex, success, errorMessage, durationMs: 1 }
  };
}

function mkPlan(stepCount: number, allIndependent = true): Plan {
  return {
    goal: 'g',
    steps: Array.from({ length: stepCount }, (_, i) => ({
      index: i,
      description: `step-${i}`,
      dependsOn: allIndependent ? [] : i === 0 ? [] : [i - 1]
    })),
    estimatedComplexity: 'medium'
  };
}

describe('StepEvaluator', () => {
  it('exports a singleton instance', () => {
    expect(stepEvaluator).toBeInstanceOf(StepEvaluator);
  });

  it('returns continue when no observations exist and no parallelism', () => {
    const evaluator = new StepEvaluator();
    const decision = evaluator.evaluate([], mkPlan(1, false), baseConfig);
    expect(decision.action).toBe('continue');
  });

  it('returns wrap-reflexion when last step failed and onFailure is reflexion', () => {
    const evaluator = new StepEvaluator();
    const obs = [mkObs(0, true), mkObs(1, false, 'boom')];
    const decision = evaluator.evaluate(obs, mkPlan(5, false), baseConfig);
    expect(decision.action).toBe('wrap-reflexion');
    if (decision.action === 'wrap-reflexion') {
      expect(decision.reason).toContain('Step 1 failed');
    }
  });

  it('does NOT wrap-reflexion when onFailure is abort', () => {
    const evaluator = new StepEvaluator();
    const config: EscalationConfig = { ...baseConfig, onFailure: 'abort' };
    const obs = [mkObs(0, false, 'boom')];
    const decision = evaluator.evaluate(obs, mkPlan(2, false), config);
    expect(decision.action).not.toBe('wrap-reflexion');
  });

  it('escalates to rewoo when independent-remaining-step count meets threshold', () => {
    const evaluator = new StepEvaluator();
    const config: EscalationConfig = { ...baseConfig, parallelThreshold: 2 };
    const obs = [mkObs(0, true)];
    const plan = mkPlan(5, true); // all 5 independent
    const decision = evaluator.evaluate(obs, plan, config);
    expect(decision.action).toBe('escalate-to-rewoo');
  });

  it('does NOT escalate to rewoo when remaining independent steps below threshold', () => {
    const evaluator = new StepEvaluator();
    const config: EscalationConfig = { ...baseConfig, parallelThreshold: 10 };
    const obs = [mkObs(0, true)];
    const plan = mkPlan(3, true);
    const decision = evaluator.evaluate(obs, plan, config);
    expect(decision.action).not.toBe('escalate-to-rewoo');
  });

  it('escalates to plan-execute when step count exceeds threshold', () => {
    const evaluator = new StepEvaluator();
    const config: EscalationConfig = { ...baseConfig, stepThreshold: 2, parallelThreshold: 99 };
    const obs = [mkObs(0, true), mkObs(1, true), mkObs(2, true)];
    const plan = mkPlan(5, false);
    const decision = evaluator.evaluate(obs, plan, config);
    expect(decision.action).toBe('escalate-to-plan-execute');
  });

  it('reflexion rule takes priority over rewoo escalation', () => {
    const evaluator = new StepEvaluator();
    const config: EscalationConfig = { ...baseConfig, parallelThreshold: 1 };
    const obs = [mkObs(0, false, 'fail')];
    const plan = mkPlan(5, true);
    const decision = evaluator.evaluate(obs, plan, config);
    expect(decision.action).toBe('wrap-reflexion');
  });

  it('rewoo rule takes priority over plan-execute step threshold', () => {
    const evaluator = new StepEvaluator();
    const config: EscalationConfig = {
      ...baseConfig,
      stepThreshold: 1,
      parallelThreshold: 2
    };
    const obs = [mkObs(0, true), mkObs(1, true)];
    const plan = mkPlan(5, true);
    const decision = evaluator.evaluate(obs, plan, config);
    expect(decision.action).toBe('escalate-to-rewoo');
  });

  it('counts only NOT-YET-COMPLETED independent steps', () => {
    const evaluator = new StepEvaluator();
    const config: EscalationConfig = { ...baseConfig, parallelThreshold: 3 };
    // Plan with 4 independent steps; 2 already completed → only 2 remain
    const obs = [mkObs(0, true), mkObs(1, true)];
    const plan = mkPlan(4, true);
    const decision = evaluator.evaluate(obs, plan, config);
    // Only 2 independent remain → below threshold of 3
    expect(decision.action).toBe('continue');
  });

  it('returns continue when all rules pass', () => {
    const evaluator = new StepEvaluator();
    const obs = [mkObs(0, true)];
    const plan = mkPlan(2, false);
    const decision = evaluator.evaluate(obs, plan, baseConfig);
    expect(decision.action).toBe('continue');
  });
});