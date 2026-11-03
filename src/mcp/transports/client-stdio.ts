import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { McpStdioServer } from "../client-config.schema.js";

/**
 * Build a stdio transport that spawns the configured subprocess.
 *
 * The subprocess inherits the harness `process.env` merged with any per-server
 * overrides — letting an entry inject `${TOKEN}`-style secrets without leaking
 * unrelated env to the child.
 */
export function buildStdioClientTransport(server: McpStdioServer): StdioClientTransport {
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...(process.env as Record<string, string>), ...server.env },
    cwd: server.cwd,
  });
}
