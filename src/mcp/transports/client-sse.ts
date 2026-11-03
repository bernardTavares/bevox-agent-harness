import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import type { McpSseServer } from "../client-config.schema.js";

/**
 * Build a Server-Sent Events client transport for a remote MCP endpoint.
 *
 * Headers (already interpolated by the loader) are passed to the underlying
 * fetch via `requestInit.headers`.
 */
export function buildSseClientTransport(server: McpSseServer): SSEClientTransport {
  const url = new URL(server.url);
  return new SSEClientTransport(url, {
    requestInit: { headers: server.headers },
  });
}
