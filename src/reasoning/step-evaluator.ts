import type { Observation, Plan } from "./engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscalationConfig {
  /** After this many steps, escalate to PlanExecute. */
  stepThreshold: number;
  /** If >= this many independent tasks remain, escalate to ReWOO. */
  parallelThreshold: number;
  onFailure: "reflexion" | "abort";
  /** Target engine when step count is exceeded. */
  escalateTo: "plan-execute" | "rewoo";
}

export type EscalationDecision =
  | { action: "continue" }
  | { action: "escalate-to-plan-execute"; reason: string }
  | { action: "escalate-to-rewoo"; reason: string }
  | { action: "wrap-reflexion"; reason: string };

// ---------------------------------------------------------------------------
// StepEvaluator
// ---------------------------------------------------------------------------

/**
 * Pure-logic evaluator (no LLM calls) that runs after each step during
 * surface agent execution and decides whether to escalate the strategy.
 */
export class StepEvaluator {
  /**
   * Evaluate the current execution state and return an escalation decision.
   *
   * Rules in priority order:
   *  1. Last step failed AND config.onFailure === 'reflexion'
   *       → wrap-reflexion
   *  2. Independent remaining steps >= config.parallelThreshold
   *       → escalate-to-rewoo
   *  3. observations.length > config.stepThreshold
   *       → escalate-to-plan-execute
   *  4. Otherwise
   *       → continue
   */
  evaluate(observations: Observation[], plan: Plan, config: EscalationConfig): EscalationDecision {
    const last = observations[observations.length - 1];

    // Rule 1: last step failed + reflexion requested
    if (last && !last.success && config.onFailure === "reflexion") {
      return {
        action: "wrap-reflexion",
        reason: `Step ${last.stepIndex} failed: ${last.raw.errorMessage ?? "unknown error"}`,
      };
    }

    // Rule 2: many independent remaining steps → ReWOO
    const completedIndexes = observations.map((o) => o.stepIndex);
    const independentCount = this.countIndependentRemainingSteps(plan, completedIndexes);

    if (independentCount >= config.parallelThreshold) {
      return {
        action: "escalate-to-rewoo",
        reason: `${independentCount} independent remaining steps detected (threshold: ${config.parallelThreshold})`,
      };
    }

    // Rule 3: too many steps already → PlanExecute
    if (observations.length > config.stepThreshold) {
      return {
        action: "escalate-to-plan-execute",
        reason: `Step count ${observations.length} exceeds threshold ${config.stepThreshold}`,
      };
    }

    return { action: "continue" };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Counts plan steps that:
   *  - Have not yet been completed (index not in completedIndexes)
   *  - Have dependsOn === [] (fully independent)
   */
  private countIndependentRemainingSteps(plan: Plan, completedIndexes: number[]): number {
    const completedSet = new Set(completedIndexes);

    return plan.steps.filter((step) => {
      const notCompleted = !completedSet.has(step.index);
      const isIndependent = !step.dependsOn || step.dependsOn.length === 0;
      return notCompleted && isIndependent;
    }).length;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const stepEvaluator = new StepEvaluator();
