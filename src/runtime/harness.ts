import type { Redis } from "ioredis";
import type { Pool } from "pg";
import pino from "pino";

import { AgentRegistry } from "../agents/registry.js";
import { getHarnessConfig } from "../config/harness-config.js";
import { SessionStore } from "../session/session-store.js";
import { UnifiedToolRegistry } from "../tools/unified-registry.js";

import type { AgentRouter } from "./agent-router.js";

const config = getHarnessConfig();
const logger = pino({ level: config.harness.logLevel, name: "harness" });

export class AgentHarness {
  readonly agentRegistry: AgentRegistry;
  readonly toolRegistry: UnifiedToolRegistry;
  readonly sessionStore: SessionStore;
  agentRouter: AgentRouter | undefined;

  constructor(
    readonly db: Pool,
    readonly redis: Redis,
    options: {
      agentRegistry?: AgentRegistry;
      toolRegistry?: UnifiedToolRegistry;
      agentRouter?: AgentRouter;
    } = {},
  ) {
    this.agentRegistry = options.agentRegistry ?? AgentRegistry.getInstance();
    this.toolRegistry = options.toolRegistry ?? UnifiedToolRegistry.getInstance();
    this.sessionStore = new SessionStore(redis);
    this.agentRouter = options.agentRouter;
    logger.debug("AgentHarness initialised");
  }

  /**
   * Placeholder kept for backward compatibility with existing callers.
   * @deprecated Full context build is handled by ExecutionHandler.
   */
  async buildContext(_payload: unknown): Promise<string> {
    logger.debug("buildContext — delegated to ExecutionHandler");
    return "System prompt placeholder";
  }

  /**
   * Placeholder kept for backward compatibility with existing callers.
   * @deprecated Pipeline agents are run inside handleExecution.
   */
  async runPipelineAgents(
    _payload: unknown,
    _context: string,
  ): Promise<{ intent: string; sentiment: string }> {
    logger.debug("runPipelineAgents — delegated to ExecutionHandler");
    return { intent: "unknown", sentiment: "neutral" };
  }

  /**
   * Placeholder kept for backward compatibility with existing callers.
   * @deprecated Routing and execution are handled inside handleExecution.
   */
  async routeAndExecute(
    _payload: unknown,
    _context: string,
    _analysis: { intent: string },
  ): Promise<void> {
    logger.debug("routeAndExecute — delegated to ExecutionHandler");
  }
}
