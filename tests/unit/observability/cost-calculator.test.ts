import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  calculateCostCents,
  _resetWarnedModelsForTest } from
"../../../src/observability/cost-calculator.js";

describe("calculateCostCents", () => {
  beforeEach(() => _resetWarnedModelsForTest());

  it("calculates cost for gpt-4o-mini", () => {
    // pricing: prompt=15, completion=60 per 1M
    // 1M prompt + 1M completion = 15 + 60 = 75
    expect(calculateCostCents("gpt-4o-mini", 1_000_000, 1_000_000)).toBe(75);
  });

  it("ceils fractional cents", () => {
    // 100 prompt tokens at rate 15/1M = 0.0015 cents → ceil to 1
    expect(calculateCostCents("gpt-4o-mini", 100, 0)).toBe(1);
  });

  it("returns 0 for zero usage", () => {
    expect(calculateCostCents("gpt-4o-mini", 0, 0)).toBe(0);
  });

  it("returns 0 and warns once on unknown model", () => {
    const logger = { warn: vi.fn() };
    expect(calculateCostCents("mystery-model", 1000, 1000, logger)).toBe(0);
    expect(calculateCostCents("mystery-model", 9999, 9999, logger)).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { model: "mystery-model" },
      expect.stringContaining("unknown model")
    );
  });

  it("warns separately for distinct unknown models", () => {
    const logger = { warn: vi.fn() };
    calculateCostCents("m1", 1, 1, logger);
    calculateCostCents("m2", 1, 1, logger);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("summing per-call results is monotonic and matches arithmetic (accumulation)", () => {
    // 3 calls of 1M prompt tokens at gpt-4o-mini (15c/1M each) → 15 + 15 + 15 = 45
    let acc = 0;
    for (let i = 0; i < 3; i++) {
      acc += calculateCostCents("gpt-4o-mini", 1_000_000, 0);
    }
    expect(acc).toBe(45);
  });
});