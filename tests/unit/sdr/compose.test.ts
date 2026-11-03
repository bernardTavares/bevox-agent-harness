import { describe, it, expect } from "vitest";
import { composeSystemPrompt } from "../../../src/sdr/compose.js";
import { SDR_DOCTRINE } from "../../../src/sdr/doctrine.js";

describe("composeSystemPrompt", () => {
  it("appends doctrine when sdr_profile enabled", () => {
    const out = composeSystemPrompt("BASE", { enabled: true, qualification_framework: "PACT" });
    expect(out).toContain("BASE");
    expect(out).toContain(SDR_DOCTRINE);
  });
  it("returns base unchanged when profile absent (zero-cost gate §4.4)", () => {
    expect(composeSystemPrompt("BASE", undefined)).toBe("BASE");
  });
  it("returns base unchanged when enabled=false", () => {
    expect(composeSystemPrompt("BASE", { enabled: false, qualification_framework: "PACT" })).toBe("BASE");
  });
});
