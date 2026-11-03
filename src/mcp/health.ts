import { createLogger } from "../config/logger.js";

import { McpClientRegistry } from "./client-registry.js";

const logger = createLogger({ name: "mcp-health" });

const DEFAULT_PING_INTERVAL_MS = 60_000;

/**
 * Start a low-frequency health probe over all registered MCP clients.
 *
 * The SDK 1.x does not expose a dedicated `ping()`, so we use `listTools()`
 * as a cheap heartbeat — most servers cache the tool list and respond in
 * a few ms. If the call throws, we log a warn but DO NOT evict the client
 * (V1): a stale entry simply lets the next real `callTool` surface
 * `MCP_CALL_FAILED` through the reasoning loop. V2 may mark skills as
 * `unavailableTools` for the evaluator.
 */
export function startMcpHealthLoop(intervalMs: number = DEFAULT_PING_INTERVAL_MS): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    for (const c of McpClientRegistry.getInstance().list()) {
      try {
        await c.client.listTools();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.warn({ serverId: c.serverId, err: detail }, "mcp server unhealthy");
      }
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  McpClientRegistry.getInstance().setHealthTimer(timer);
  return timer;
}
