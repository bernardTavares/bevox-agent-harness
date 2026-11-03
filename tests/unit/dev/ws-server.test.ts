import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  _resetDevEventBusForTests,
  getDevEventBus,
} from "../../../src/dev/event-bus.js";
import { startDevWsServer, stopDevWsServer } from "../../../src/dev/ws-server.js";

const TEST_PORT = 4499;

describe("DevWsServer", () => {
  beforeEach(() => {
    _resetDevEventBusForTests();
    process.env["HARNESS_DEV_MODE"] = "1";
    process.env["NODE_ENV"] = "development";
  });

  afterEach(async () => {
    await stopDevWsServer();
    _resetDevEventBusForTests();
    delete process.env["HARNESS_DEV_MODE"];
    delete process.env["NODE_ENV"];
  });

  it("does not start when HARNESS_DEV_MODE is unset", () => {
    delete process.env["HARNESS_DEV_MODE"];
    const handle = startDevWsServer(TEST_PORT);
    expect(handle).toBeNull();
  });

  it("does not start when NODE_ENV=production", () => {
    process.env["NODE_ENV"] = "production";
    const handle = startDevWsServer(TEST_PORT);
    expect(handle).toBeNull();
  });

  it("starts, sends hello, broadcasts events, and stops cleanly", async () => {
    startDevWsServer(TEST_PORT, "127.0.0.1");
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);

    // Collect all inbound messages from the moment the socket opens.
    const inbound: unknown[] = [];
    ws.on("message", (data) => {
      inbound.push(JSON.parse(data.toString()));
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });

    // Give hello a moment to arrive, then broadcast an event.
    await new Promise((r) => setTimeout(r, 50));
    getDevEventBus().emitEvent({
      kind: "execution.started",
      executionId: "exec-1",
      accountId: 7,
      ts: Date.now(),
      payload: { messages: [] },
    });

    // Poll until we have both messages or time out.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && inbound.length < 2) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const kinds = inbound.map((m) => (m as { kind: string }).kind);
    expect(kinds).toContain("hello");
    expect(kinds).toContain("execution.started");

    ws.close();
  });
});
