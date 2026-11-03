import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetDevEventBusForTests,
  getDevEventBus,
  isDevModeEnabled,
} from "../../../src/dev/event-bus.js";
import type { DevEvent } from "../../../src/dev/types.js";

describe("DevEventBus", () => {
  beforeEach(() => {
    _resetDevEventBusForTests();
    delete process.env["HARNESS_DEV_MODE"];
    delete process.env["NODE_ENV"];
  });

  afterEach(() => {
    _resetDevEventBusForTests();
    delete process.env["HARNESS_DEV_MODE"];
    delete process.env["NODE_ENV"];
  });

  it("singleton returns same instance", () => {
    expect(getDevEventBus()).toBe(getDevEventBus());
  });

  it("emits and receives DevEvent", () => {
    const bus = getDevEventBus();
    const received: DevEvent[] = [];
    bus.on("event", (e: DevEvent) => received.push(e));
    bus.emitEvent({
      kind: "execution.started",
      executionId: "e1",
      accountId: 1,
      ts: 0,
      payload: {},
    });
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("execution.started");
  });

  it("isDevModeEnabled false when env unset", () => {
    expect(isDevModeEnabled()).toBe(false);
  });

  it("isDevModeEnabled true with HARNESS_DEV_MODE=1 and non-prod", () => {
    process.env["HARNESS_DEV_MODE"] = "1";
    process.env["NODE_ENV"] = "development";
    expect(isDevModeEnabled()).toBe(true);
  });

  it("isDevModeEnabled false when NODE_ENV=production even with flag set", () => {
    process.env["HARNESS_DEV_MODE"] = "1";
    process.env["NODE_ENV"] = "production";
    expect(isDevModeEnabled()).toBe(false);
  });

  it("emit without listeners is a safe no-op", () => {
    const bus = getDevEventBus();
    expect(() =>
      bus.emitEvent({
        kind: "execution.completed",
        executionId: "x",
        ts: 0,
        durationMs: 0,
        status: "ok",
      }),
    ).not.toThrow();
  });
});
