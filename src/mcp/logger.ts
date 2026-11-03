import pino, { type Logger } from "pino";

import { getEnv } from "../config/env.js";
import { buildRedactionConfig } from "../security/redactors.js";

/**
 * MCP-dedicated Pino logger.
 *
 * The stdio transport uses fd 1 (stdout) as the JSON-RPC channel — any
 * stray write to stdout corrupts the protocol. We therefore force this
 * logger to fd 2 (stderr) via `pino.destination(2)`. The SSE transport
 * benefits from the same destination for consistency.
 *
 * Do NOT use `createLogger` from `src/config/logger.ts` inside MCP code —
 * its default destination is stdout.
 */
let cached: Logger | undefined;

export function getMcpLogger(): Logger {
  if (cached) return cached;
  const env = getEnv();
  cached = pino(
    {
      name: "mcp-server",
      level: env.HARNESS_LOG_LEVEL,
      redact: buildRedactionConfig(env.HARNESS_LOG_LEVEL),
    },
    pino.destination(2),
  );
  return cached;
}
