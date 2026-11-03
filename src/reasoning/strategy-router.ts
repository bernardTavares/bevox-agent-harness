import type { AgentExecutionContext } from "../agents/execution-context.js";
import type { AgentDefinition, AgentType } from "../agents/types.js";

import type { DirectEngineConfig } from "./direct.js";
import { DirectEngine } from "./direct.js";
import type { ReasoningEngine } from "./engine.js";
import type { PlanExecuteEngineConfig } from "./plan-execute.js";
import { PlanExecuteEngine } from "./plan-execute.js";
import type { ReactEngineConfig } from "./react.js";
import { ReactEngine } from "./react.js";
import { ReflexionWrapper } from "./reflexion.js";
import type { ReWOOEngineConfig } from "./rewoo.js";
import { ReWOOEngine } from "./rewoo.js";

// ---------------------------------------------------------------------------
// StrategyRouter
// ---------------------------------------------------------------------------

/**
 * Stateless factory that reads an AgentDefinition's reasoning config
 * and constructs the appropriate ReasoningEngine (optionally wrapped
 * with ReflexionWrapper).
 */
export class StrategyRouter {
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Build the ReasoningEngine for the given agent and execution context.
   *
   * Logic:
   *  1. Read agent.reasoning.default (or infer from agent.type).
   *  2. Construct base engine with default config merged with agent overrides.
   *  3. If agent.reasoning.escalation.onFailure === 'reflexion', wrap in ReflexionWrapper.
   */
  build(agent: AgentDefinition, _context: AgentExecutionContext): ReasoningEngine {
    const strategy = agent.reasoning?.default ?? this.inferDefault(agent.type);
    const escalation = agent.reasoning?.escalation;

    let engine: ReasoningEngine;

    switch (strategy) {
      case "direct":
        engine = new DirectEngine(this.mergeConfig<DirectEngineConfig>({}, {}));
        break;

      case "react":
        engine = new ReactEngine(
          this.mergeConfig<ReactEngineConfig>(
            { maxSteps: 10, stopTools: ["send-message", "request-human"] },
            {},
          ),
        );
        break;

      case "plan-execute":
        engine = new PlanExecuteEngine(
          this.mergeConfig<PlanExecuteEngineConfig>(
            { maxSteps: 15, allowReplan: true, replanThreshold: 0.6 },
            {},
          ),
        );
        break;

      case "rewoo":
        engine = new ReWOOEngine(this.mergeConfig<ReWOOEngineConfig>({ maxParallel: 5 }, {}));
        break;

      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = strategy;
        void _exhaustive;
        engine = new ReactEngine();
      }
    }

    // Optionally wrap with ReflexionWrapper
    if (escalation?.onFailure === "reflexion") {
      engine = new ReflexionWrapper({ inner: engine });
    }

    return engine;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Infer the default strategy based on agent type. */
  private inferDefault(type: AgentType): "direct" | "react" {
    return type === "pipeline" ? "direct" : "react";
  }

  /**
   * Shallow merge of engine config objects.
   * agentOverrides takes precedence over defaults.
   */
  private mergeConfig<T extends object>(defaults: T, agentOverrides: Partial<T>): T {
    return { ...defaults, ...agentOverrides };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const strategyRouter = new StrategyRouter();
