import { describe, it, expect, beforeEach } from "vitest";

import {
  recordDeadLetter,
  getDeadLetterCounts,
  resetDeadLetterCounts,
  recordTransientFailure,
  getTransientFailureCount,
  resetTransientFailureCount,
} from "../../../src/observability/dead-letter-metrics.js";

describe("dead-letter-metrics", () => {
  beforeEach(() => {
    resetDeadLetterCounts();
    resetTransientFailureCount();
  });

  it("starts at zero for the three terminal categories", () => {
    expect(getDeadLetterCounts()).toEqual({
      poison: 0,
      retry_exhausted: 0,
      aborted: 0,
    });
  });

  it("does NOT bundle transient_attempt under the dead-letter metric", () => {
    // transient_attempt is per-attempt flakiness, not a dead-letter — it must
    // never appear on the dead-letter SLO surface.
    expect(getDeadLetterCounts()).not.toHaveProperty("transient_attempt");
  });

  it("increments the poison counter", () => {
    recordDeadLetter({ category: "poison" });
    recordDeadLetter({ category: "poison" });
    expect(getDeadLetterCounts().poison).toBe(2);
  });

  it("increments the retry_exhausted counter independently of poison", () => {
    recordDeadLetter({ category: "retry_exhausted" });
    const counts = getDeadLetterCounts();
    expect(counts.retry_exhausted).toBe(1);
    expect(counts.poison).toBe(0);
  });

  it("increments the aborted counter (fed by the abort path, never the listener)", () => {
    recordDeadLetter({ category: "aborted" });
    expect(getDeadLetterCounts().aborted).toBe(1);
  });
});

describe("transient-failure-metric (separate, non-dead-letter counter)", () => {
  beforeEach(() => {
    resetDeadLetterCounts();
    resetTransientFailureCount();
  });

  it("starts at zero", () => {
    expect(getTransientFailureCount()).toBe(0);
  });

  it("increments the transient-failure counter (non-final flakiness, not a dead-letter)", () => {
    recordTransientFailure();
    recordTransientFailure();
    expect(getTransientFailureCount()).toBe(2);
  });

  it("is fully independent of the dead-letter counters", () => {
    recordTransientFailure();
    recordDeadLetter({ category: "retry_exhausted" });
    expect(getTransientFailureCount()).toBe(1);
    expect(getDeadLetterCounts()).toEqual({
      poison: 0,
      retry_exhausted: 1,
      aborted: 0,
    });
  });
});
