import { describe, it, expect } from "vitest";
import { SDR_DOCTRINE } from "../../../src/sdr/doctrine.js";

describe("SDR_DOCTRINE", () => {
  it("contains invariant rules", () => {
    expect(SDR_DOCTRINE).toMatch(/Why Change|Why You|Why Now/);
    expect(SDR_DOCTRINE.toLowerCase()).toContain("touch base");
    expect(SDR_DOCTRINE).toMatch(/uma pergunta|one (question|ask)/i);
  });
  it("is compact (poucas centenas de tokens ~ < 2500 chars)", () => {
    expect(SDR_DOCTRINE.length).toBeLessThan(2500);
  });
});
