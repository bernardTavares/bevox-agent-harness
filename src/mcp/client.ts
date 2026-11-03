import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { McpServerEntry } from "./client-config.schema.js";
import { buildSseClientTransport } from "./transports/client-sse.js";
import { buildStdioClientTransport } from "./transports/client-stdio.js";

export interface ConnectedClient {
  serverId: string;
  client: Client;
  /** Closes the underlying transport. Swallows errors during shutdown. */
  close: () => Promise<void>;
}

/**
 * Open a Client connection to an external MCP server.
 *
 * The transport is built from the config entry. After `connect()` the client
 * is ready for `listTools()` / `callTool()`. Caller owns the lifetime via
 * the returned `close()` (typically wired into `McpClientRegistry.closeAll`).
 */
export async function connectMcpServer(
  serverId: string,
  server: McpServerEntry,
): Promise<ConnectedClient> {
  const transport =
    server.transport === "stdio"
      ? buildStdioClientTransport(server)
      : buildSseClientTransport(server);

  const client = new Client(
    { name: `bevox-harness-${serverId}`, version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  return {
    serverId,
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        // swallow on shutdown — the transport may already be torn down
      }
    },
  };
}
