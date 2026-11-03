import { describe, it, expect, beforeEach } from "vitest";
import { resetEnvCacheForTests } from "../../../src/config/env.js";
import { getHarnessConfig } from "../../../src/config/harness-config.js";
import { resolveQualificationFramework } from "../../../src/sdr/tunables.js";

describe("SDR tunables config block (§7 Ross×Bertuzzi)", () => {
  beforeEach(() => {
    // Clear all SDR_* env keys between tests
    delete process.env.SDR_QUALIFICATION_FRAMEWORK;
    delete process.env.SDR_PHONE_VM_WEIGHT;
    delete process.env.SDR_ROLE_GRANULARITY;
    delete process.env.SDR_SPEED_TO_CONTACT_FASTPATH;
    resetEnvCacheForTests();
  });

  describe("defaults (no SDR_* env set)", () => {
    it("returns sdr block with qualification framework default PACT", () => {
      const cfg = getHarnessConfig();
      expect(cfg.sdr.qualificationFramework).toBe("PACT");
    });

    it("returns sdr block with speed-to-contact fast-path default false", () => {
      const cfg = getHarnessConfig();
      expect(cfg.sdr.speedToContactFastpath).toBe(false);
    });

    it("returns sdr block with phone/VM weight default 1", () => {
      const cfg = getHarnessConfig();
      expect(cfg.sdr.phoneVmWeight).toBe(1);
    });

    it("returns sdr block with role granularity default 3-role", () => {
      const cfg = getHarnessConfig();
      expect(cfg.sdr.roleGranularity).toBe("3-role");
    });
  });

  describe("env overrides", () => {
    it("SDR_QUALIFICATION_FRAMEWORK=PACT2 → qualificationFramework is PACT2", () => {
      process.env.SDR_QUALIFICATION_FRAMEWORK = "PACT2";
      resetEnvCacheForTests();
      const cfg = getHarnessConfig();
      expect(cfg.sdr.qualificationFramework).toBe("PACT2");
    });

    it("SDR_PHONE_VM_WEIGHT=2 → phoneVmWeight is 2", () => {
      process.env.SDR_PHONE_VM_WEIGHT = "2";
      resetEnvCacheForTests();
      const cfg = getHarnessConfig();
      expect(cfg.sdr.phoneVmWeight).toBe(2);
    });

    it("SDR_ROLE_GRANULARITY=4-role → roleGranularity is 4-role", () => {
      process.env.SDR_ROLE_GRANULARITY = "4-role";
      resetEnvCacheForTests();
      const cfg = getHarnessConfig();
      expect(cfg.sdr.roleGranularity).toBe("4-role");
    });

    it("SDR_SPEED_TO_CONTACT_FASTPATH=true → speedToContactFastpath is true", () => {
      process.env.SDR_SPEED_TO_CONTACT_FASTPATH = "true";
      resetEnvCacheForTests();
      const cfg = getHarnessConfig();
      expect(cfg.sdr.speedToContactFastpath).toBe(true);
    });
  });
});

describe("resolveQualificationFramework A/B resolver", () => {
  it("returns profile value when profile specifies PACT2", () => {
    expect(resolveQualificationFramework("PACT2", "PACT")).toBe("PACT2");
  });

  it("returns profile value when profile specifies PACT", () => {
    expect(resolveQualificationFramework("PACT", "PACT2")).toBe("PACT");
  });

  it("returns config default when profile value is undefined", () => {
    expect(resolveQualificationFramework(undefined, "PACT")).toBe("PACT");
  });

  it("returns config default PACT2 when profile value is undefined", () => {
    expect(resolveQualificationFramework(undefined, "PACT2")).toBe("PACT2");
  });
});
