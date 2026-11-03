import { describe, it, expect } from "vitest";

import { computeCalibrationRatio } from "../../../src/context/calibration.js";

describe("computeCalibrationRatio", () => {
  it("returns actual / estimated for valid positive inputs", () => {
    expect(computeCalibrationRatio(100, 130)).toBeCloseTo(1.3, 5);
  });

  it("returns 1 for an exact match", () => {
    expect(computeCalibrationRatio(500, 500)).toBe(1);
  });

  it("returns a ratio < 1 when we OVER-estimated (estimate too high)", () => {
    expect(computeCalibrationRatio(200, 150)).toBeCloseTo(0.75, 5);
  });

  it("returns null when estimated is 0 (no division)", () => {
    expect(computeCalibrationRatio(0, 130)).toBeNull();
  });

  it("returns null when actual is 0 or missing (no signal)", () => {
    expect(computeCalibrationRatio(100, 0)).toBeNull();
    expect(computeCalibrationRatio(100, undefined)).toBeNull();
  });

  it("returns null for negative inputs (defensive)", () => {
    expect(computeCalibrationRatio(-1, 130)).toBeNull();
    expect(computeCalibrationRatio(100, -5)).toBeNull();
  });
});
