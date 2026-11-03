import { EventEmitter } from "node:events";

import type { DevEvent } from "./types.js";

/**
 * In-process pub/sub for dev-mode telemetry events.
 *
 * In production (HARNESS_DEV_MODE != "1") the WS server never attaches a
 * listener, so `emitEvent` is a no-op `EventEmitter.emit` — microseconds.
 */
class DevEventBus extends EventEmitter {
  emitEvent(event: DevEvent): void {
    this.emit("event", event);
  }
}

let instance: DevEventBus | null = null;

export function getDevEventBus(): DevEventBus {
  if (!instance) {
    instance = new DevEventBus();
    // Higher cap because UI may attach a verbose listener + tests.
    instance.setMaxListeners(50);
  }
  return instance;
}

export function isDevModeEnabled(): boolean {
  return process.env["HARNESS_DEV_MODE"] === "1" && process.env["NODE_ENV"] !== "production";
}

/** Test-only: reset the singleton between tests. */
export function _resetDevEventBusForTests(): void {
  instance = null;
}
