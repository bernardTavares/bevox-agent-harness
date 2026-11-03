import type { IncomingMessage } from "node:http";

import pino from "pino";
import { WebSocketServer, WebSocket } from "ws";

import { getEnv } from "../config/env.js";

import { getDevEventBus, isDevModeEnabled } from "./event-bus.js";
import type { DevEvent, DevWireMessage } from "./types.js";

const logger = pino({ name: "dev-ws-server" });

interface DevWsServerHandle {
  wss: WebSocketServer;
  /** Cumulative count of broadcast frames dropped due to backpressure. */
  droppedEvents: number;
}

let handle: DevWsServerHandle | null = null;
let listenerAttached = false;
let busHandler: ((event: DevEvent) => void) | null = null;

const ALLOWED_ORIGIN_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function originIsLocal(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (wscat, tests) — allow
  try {
    const url = new URL(origin);
    return ALLOWED_ORIGIN_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function startDevWsServer(port?: number, host?: string): DevWsServerHandle | null {
  if (!isDevModeEnabled()) {
    logger.info({ port }, "dev ws server skipped: HARNESS_DEV_MODE not set or NODE_ENV=production");
    return null;
  }
  if (handle) return handle;

  const env = getEnv();
  const boundPort = port ?? env.HARNESS_DEV_WS_PORT;
  const boundHost = host ?? env.HARNESS_DEV_WS_HOST;
  const backpressureBytes = env.HARNESS_DEV_WS_BACKPRESSURE_BYTES;

  const wss = new WebSocketServer({
    port: boundPort,
    host: boundHost,
    // Defense in depth: reject upgrades whose Origin header is non-local.
    verifyClient: (info: { origin: string; req: IncomingMessage }) => {
      if (!originIsLocal(info.origin)) {
        logger.warn({ origin: info.origin }, "rejected ws upgrade: non-local origin");
        return false;
      }
      return true;
    },
  });

  handle = { wss, droppedEvents: 0 };
  logger.info({ port: boundPort, host: boundHost }, "dev ws server listening");

  const bus = getDevEventBus();

  if (busHandler) {
    bus.off("event", busHandler);
  }

  busHandler = (event: DevEvent) => {
    const msg = JSON.stringify(event);
    wss.clients.forEach((c) => {
      if (c.readyState !== WebSocket.OPEN) return;
      if (c.bufferedAmount > backpressureBytes) {
        // Drop instead of pile up; UI is a debug surface, not a contract.
        handle!.droppedEvents += 1;
        return;
      }
      try {
        c.send(msg);
      } catch (err) {
        logger.warn({ err }, "ws send failed; client likely disconnected");
      }
    });
  };

  bus.on("event", busHandler);
  listenerAttached = true;

  wss.on("connection", (ws, req) => {
    logger.debug({ remote: req.socket.remoteAddress }, "dev ws client connected");
    const hello: DevWireMessage = {
      kind: "hello",
      version: 1,
      serverTime: Date.now(),
    };
    try {
      ws.send(JSON.stringify(hello));
    } catch (err) {
      logger.warn({ err }, "failed to send hello");
    }

    ws.on("error", (err) => logger.warn({ err }, "ws client error"));
  });

  wss.on("error", (err) => logger.error({ err }, "ws server error"));

  return handle;
}

export async function stopDevWsServer(): Promise<void> {
  if (!handle) return;
  const { wss } = handle;
  if (busHandler && listenerAttached) {
    getDevEventBus().off("event", busHandler);
    listenerAttached = false;
    busHandler = null;
  }
  await new Promise<void>((resolve) => {
    wss.clients.forEach((c) => {
      try {
        c.terminate();
      } catch {
        /* ignore */
      }
    });
    wss.close(() => resolve());
  });
  handle = null;
  logger.info("dev ws server stopped");
}

export function getDevWsMetrics(): { droppedEvents: number; clients: number } {
  return {
    droppedEvents: handle?.droppedEvents ?? 0,
    clients: handle?.wss.clients.size ?? 0,
  };
}
