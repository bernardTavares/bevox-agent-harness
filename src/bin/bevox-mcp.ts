#!/usr/bin/env node
/**
 * `bevox-mcp` — standalone MCP server binary that exposes the Bevox built-in
 * skills as MCP tools. Two transports: `stdio` (Claude Desktop spawn) and
 * `sse` (remote bearer-authenticated).
 *
 * Usage:
 *   bevox-mcp --transport stdio
 *   bevox-mcp --transport sse
 */
import { parseArgs } from "node:util";

import { getEnv } from "../config/env.js";
import { bootstrapMcp, StubLlmClient } from "../mcp/bootstrap.js";
import { getMcpLogger } from "../mcp/logger.js";
import { buildMcpServer } from "../mcp/server.js";
import { runSseTransport } from "../mcp/transports/sse.js";
import { runStdioTransport } from "../mcp/transports/stdio.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      transport: { type: "string", default: "stdio" },
    },
    strict: true,
    allowPositionals: false,
  });

  const transport = values.transport ?? "stdio";
  const env = getEnv();
  const logger = getMcpLogger();

  const { db } = await bootstrapMcp();
  const llmClient = new StubLlmClient();

  if (transport === "stdio") {
    const server = buildMcpServer({ db, llmClient });
    await runStdioTransport(server);
    return;
  }

  if (transport === "sse") {
    if (!env.MCP_SERVER_TOKEN) {
      logger.error("MCP_SERVER_TOKEN required for sse transport");
      process.exit(1);
    }
    // SSE: one McpServer per session — Protocol owns its transport.
    const running = await runSseTransport(() => buildMcpServer({ db, llmClient }), {
      host: env.MCP_SSE_HOST,
      port: env.MCP_SSE_PORT,
      authToken: env.MCP_SERVER_TOKEN,
    });

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      logger.info({ signal }, "mcp sse shutting down");
      try {
        await running.close();
      } finally {
        await db.end().catch(() => {
          /* ignore */
        });
        process.exit(0);
      }
    };
    process.on("SIGTERM", (sig) => {
      void shutdown(sig);
    });
    process.on("SIGINT", (sig) => {
      void shutdown(sig);
    });
    return;
  }

  logger.error({ transport }, "unknown transport (use stdio or sse)");
  process.exit(1);
}

main().catch((err: unknown) => {
  const logger = getMcpLogger();
  logger.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) },
    "mcp bin failed",
  );
  process.exit(1);
});
