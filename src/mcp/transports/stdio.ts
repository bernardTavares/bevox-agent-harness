import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getMcpLogger } from "../logger.js";

/**
 * Wire the MCP server to stdio.
 *
 * Stdio uses fd 1 (stdout) as the JSON-RPC channel. ANY write to stdout from
 * our code corrupts the protocol — including Pino's default destination. We
 * rely on {@link getMcpLogger} which is explicitly bound to fd 2 (stderr).
 * Do NOT monkey-patch `process.stdout.write`.
 *
 * The process stays alive until SIGTERM/SIGINT — Claude Desktop sends SIGTERM
 * on shutdown.
 */
export async function runStdioTransport(server: McpServer): Promise<void> {
  const logger = getMcpLogger();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp stdio transport connected");

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "mcp stdio shutting down");
    try {
      await transport.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", (sig) => {
    void shutdown(sig);
  });
  process.on("SIGINT", (sig) => {
    void shutdown(sig);
  });
}
