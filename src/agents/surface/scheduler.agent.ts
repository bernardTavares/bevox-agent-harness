import { BaseAgent } from "../base-agent.js";
import type { AgentExecutionContext } from "../execution-context.js";
import type { AgentDefinition, AgentResult } from "../types.js";

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export const schedulerAgentDefinition: AgentDefinition = {
  name: "scheduler",
  type: "surface",
  description:
    "Handles all scheduling intents: book, cancel, reschedule appointments and general questions",

  reasoning: {
    default: "react",
    escalation: {
      stepThreshold: 3, // After 3 steps, escalate to plan-execute
      escalateTo: "plan-execute",
      parallelThreshold: 2, // 2+ independent sub-tasks → ReWOO
      onFailure: "reflexion",
    },
  },

  permissions: {
    required: ["read-calendar", "create-appointment", "send-message"],
    optional: [
      "cancel-appointment",
      "reschedule-appointment",
      "waitlist-add",
      "search-faq",
      "read-profile",
    ],

    denied: ["write-profile", "write-fact"],
  },
};

// ---------------------------------------------------------------------------
// SchedulerAgent class
// ---------------------------------------------------------------------------

/**
 * Surface agent responsible for scheduling-related intents.
 * The actual reasoning loop lives in the engine selected by StrategyRouter
 * based on schedulerAgentDefinition.reasoning.
 *
 * execute() is a thin pass-through: the ExecutionHandler calls
 * runSurfaceAgentLoop() directly with the right tools and context.
 * This class exists primarily as the registry entry carrying the definition.
 */
export class SchedulerAgent extends BaseAgent {
  constructor() {
    super(schedulerAgentDefinition);
  }

  async execute(context: AgentExecutionContext): Promise<AgentResult> {
    // Surface agents are executed by the ExecutionHandler via runSurfaceAgentLoop.
    // This stub is provided to satisfy the abstract contract from BaseAgent.
    // If called directly (e.g. in tests), delegate gracefully.
    void context;
    return {
      success: false,
      output: null,
      error: "SchedulerAgent.execute() must be called via runSurfaceAgentLoop in ExecutionHandler",
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSchedulerAgent(): SchedulerAgent {
  return new SchedulerAgent();
}
