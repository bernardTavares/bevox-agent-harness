import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { getMcpLogger } from "../logger.js";

export interface SseTransportOptions {
  host: string;
  port: number;
  authToken: string;
}

/**
 * Constant-time bearer comparison so a malicious caller cannot probe the
 * token byte-by-byte via timing.
 */
function checkAuth(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length).trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface RunningSseTransport {
  close: () => Promise<void>;
  address: () => { host: string; port: number };
}

/**
 * Start an HTTP server hosting the deprecated-but-widely-supported SSE
 * transport. Note: MCP spec recommends Streamable HTTP going forward — when
 * we migrate, this file becomes obsolete; track as tech debt.
 *
 * One `McpServer` instance is created PER SSE session. The MCP `Protocol`
 * primitive owns its transport — sharing a single server across many SSE
 * connections is not supported by the SDK (the second `connect()` throws
 * "Already connected to a transport"). The caller passes a factory so each
 * session gets a fresh server with the same tool surface.
 */
export async function runSseTransport(
  serverFactory: () => McpServer,
  opts: SseTransportOptions,
): Promise<RunningSseTransport> {
  const logger = getMcpLogger();
  const transports = new Map<string, SSEServerTransport>();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!checkAuth(req, opts.authToken)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.method === "GET" && req.url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      const sessionServer = serverFactory();
      // IMPORTANT: connect BEFORE recording the sessionId. `server.connect`
      // initialises the transport (assigning sessionId via its `start()`).
      // Recording before connect would either store an undefined id or race
      // with the first POST /messages.
      await sessionServer.connect(transport);
      transports.set(transport.sessionId, transport);
      res.on("close", () => {
        transports.delete(transport.sessionId);
        void sessionServer.close().catch(() => {
          /* ignore */
        });
      });
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/messages")) {
      const sessionId = new URL(req.url, "http://x").searchParams.get("sessionId");
      const t = sessionId ? transports.get(sessionId) : undefined;
      if (!t) {
        res.writeHead(404).end();
        return;
      }
      await t.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404).end();
  };

  const http = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "mcp sse handler crashed",
      );
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });

  await new Promise<void>((resolve) => {
    http.listen(opts.port, opts.host, () => {
      logger.info({ host: opts.host, port: opts.port }, "mcp sse transport listening");
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    address: () => ({ host: opts.host, port: opts.port }),
  };
}
