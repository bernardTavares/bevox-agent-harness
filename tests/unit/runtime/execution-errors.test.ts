import { describe, it, expect } from "vitest";

import { ExecutionAbortError, type AbortReason } from "../../../src/runtime/errors.js";

describe("ExecutionAbortError", () => {
  it("is an Error with name ExecutionAbortError", () => {
    const e = new ExecutionAbortError("wall_clock_timeout", "boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ExecutionAbortError");
    expect(e.message).toBe("boom");
  });

  it("carries the typed reason", () => {
    const reason: AbortReason = "cost_ceiling";
    const e = new ExecutionAbortError(reason, "ceiling hit");
    expect(e.reason).toBe("cost_ceiling");
  });

  it("defaults retryable=true (advisory — governs dedup-key retention, not BullMQ)", () => {
    const e = new ExecutionAbortError("wall_clock_timeout", "x");
    expect(e.retryable).toBe(true);
  });

  it("cost_ceiling aborts are constructed non-retryable", () => {
    const e = new ExecutionAbortError("cost_ceiling", "x", false);
    expect(e.retryable).toBe(false);
  });

  it("instanceof discriminates aborts from generic errors at the boundary", () => {
    const abort: unknown = new ExecutionAbortError("phase_timeout", "x");
    const generic: unknown = new Error("network 503");
    expect(abort instanceof ExecutionAbortError).toBe(true);
    expect(generic instanceof ExecutionAbortError).toBe(false);
  });
});
