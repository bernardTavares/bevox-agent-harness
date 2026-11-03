import pino from "pino";

import type { AgentRegistry } from "../agents/registry.js";

const logger = pino({ name: "agent-router" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteRule {
  /** One or more intents that activate this route */
  intent: string | string[];
  /** Registered surface agent name */
  agent: string;
  /** What to do if the agent is not available */
  fallback: "request-human" | string;
  /** Higher priority wins on overlap */
  priority: number;
}

export interface AgentRouterConfig {
  rules: RouteRule[];
}

// ---------------------------------------------------------------------------
// Default route table
// ---------------------------------------------------------------------------

export const DEFAULT_ROUTE_RULES: RouteRule[] = [
  { intent: "scheduling", agent: "scheduler", fallback: "request-human", priority: 10 },
  {
    intent: "scheduling_confirmation",
    agent: "scheduler",
    fallback: "request-human",
    priority: 10,
  },
  {
    intent: "scheduling_cancellation",
    agent: "scheduler",
    fallback: "request-human",
    priority: 10,
  },
  { intent: "scheduling_reschedule", agent: "scheduler", fallback: "request-human", priority: 10 },
  { intent: "question", agent: "scheduler", fallback: "request-human", priority: 5 },
  { intent: "unknown", agent: "scheduler", fallback: "request-human", priority: 1 },
];

// ---------------------------------------------------------------------------
// AgentRouter
// ---------------------------------------------------------------------------

export class AgentRouter {
  private readonly rules: RouteRule[];

  constructor(config: AgentRouterConfig) {
    // Sort descending by priority at construction time
    this.rules = [...config.rules].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Returns the surface agent name to use, or 'request-human' as fallback.
   * agentRegistry is used to confirm the resolved agent is actually registered.
   */
  resolve(intent: string, agentRegistry: AgentRegistry): string {
    for (const rule of this.rules) {
      const intents = Array.isArray(rule.intent) ? rule.intent : [rule.intent];
      if (intents.includes(intent)) {
        if (agentRegistry.has(rule.agent)) {
          return rule.agent;
        }
        // Agent defined in route but not registered
        logger.warn(
          { agent: rule.agent, intent },
          `Route matched agent "${rule.agent}" for intent "${intent}" but it is not registered. Using fallback.`,
        );
        return rule.fallback;
      }
    }
    // No matching rule
    logger.warn(
      { intent },
      `No route rule matched intent "${intent}". Falling back to request-human.`,
    );
    return "request-human";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentRouter(extraRules: RouteRule[] = []): AgentRouter {
  return new AgentRouter({ rules: [...DEFAULT_ROUTE_RULES, ...extraRules] });
}
