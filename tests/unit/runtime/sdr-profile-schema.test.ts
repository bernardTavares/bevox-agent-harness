import { describe, it, expect } from "vitest";
import { sdrProfileSchema } from "../../../src/runtime/sdr-profile.schema.js";

describe("sdrProfileSchema", () => {
  it("parses a valid profile with default framework", () => {
    const r = sdrProfileSchema.safeParse({ enabled: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.qualification_framework).toBe("PACT");
  });
  it("rejects junk safely", () => {
    expect(sdrProfileSchema.safeParse({ enabled: "yes" }).success).toBe(false);
  });
});
