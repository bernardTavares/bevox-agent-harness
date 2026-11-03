import { describe, it, expect } from "vitest";
import { composeSystemPrompt } from "../../../src/sdr/compose.js";
import { SDR_DOCTRINE } from "../../../src/sdr/doctrine.js";

const enabledProfile = { enabled: true, qualification_framework: "PACT" as const };

const baseState = {
  status: "working" as const,
  lastTouchAt: new Date("2026-05-10T12:00:00Z"),
};

describe("composeSystemPrompt — L3 sales-state extension (Fase B §5.3/§2.3)", () => {
  // ── Zero-cost gate: existing 2-arg behaviour MUST be byte-identical ──────
  it("2-arg: appends doctrine when enabled (existing behaviour preserved)", () => {
    const out = composeSystemPrompt("BASE", enabledProfile);
    expect(out).toBe(`BASE\n\n${SDR_DOCTRINE}`);
  });

  it("2-arg: returns base unchanged when profile absent (zero-cost gate)", () => {
    expect(composeSystemPrompt("BASE", undefined)).toBe("BASE");
  });

  it("2-arg: returns base unchanged when enabled=false", () => {
    expect(composeSystemPrompt("BASE", { enabled: false, qualification_framework: "PACT" })).toBe("BASE");
  });

  // ── L3: salesState present + enabled ─────────────────────────────────────
  it("appends sales-state block AFTER doctrine when enabled + salesState present", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, baseState, "qualificacao");
    expect(out).toContain("BASE");
    expect(out).toContain(SDR_DOCTRINE);
    // sales-state block must appear AFTER doctrine
    const doctrineIdx = out.indexOf(SDR_DOCTRINE);
    const stateIdx = out.indexOf("## L3 SALES STATE");
    expect(stateIdx).toBeGreaterThan(doctrineIdx);
  });

  it("sales-state block includes status and last-touch", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, baseState, "qualificacao");
    expect(out).toContain("working");
    expect(out).toContain("2026-05-10");
  });

  it("sales-state block is labelled by subMode — qualificacao", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, baseState, "qualificacao");
    expect(out).toContain("qualificacao");
  });

  it("sales-state block is labelled by subMode — reativacao", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, baseState, "reativacao");
    expect(out).toContain("reativacao");
  });

  it("sales-state block is labelled by subMode — nurture", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, baseState, "nurture");
    expect(out).toContain("nurture");
  });

  it("sales-state block is labelled by subMode — handoff-iminente", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, baseState, "handoff-iminente");
    expect(out).toContain("handoff-iminente");
  });

  // ── Zero-cost: no salesState → byte-identical to 2-arg ──────────────────
  it("with enabled profile but no salesState → identical to 2-arg result", () => {
    const twoArg = composeSystemPrompt("BASE", enabledProfile);
    const withUndefined = composeSystemPrompt("BASE", enabledProfile, undefined, "qualificacao");
    expect(withUndefined).toBe(twoArg);
  });

  it("with enabled profile + salesState but no subMode → still appends state block", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, baseState, undefined);
    expect(out).toContain(SDR_DOCTRINE);
    expect(out).toContain("## L3 SALES STATE");
    expect(out).toContain("working");
  });

  // ── Gate off: disabled profile → base byte-identical regardless of salesState ─
  it("disabled profile + salesState → base unchanged (zero-cost gate)", () => {
    const out = composeSystemPrompt(
      "BASE",
      { enabled: false, qualification_framework: "PACT" },
      baseState,
      "qualificacao",
    );
    expect(out).toBe("BASE");
  });

  it("absent profile + salesState → base unchanged (zero-cost gate)", () => {
    const out = composeSystemPrompt("BASE", undefined, baseState, "qualificacao");
    expect(out).toBe("BASE");
  });

  // ── Small block: IDs/status/last-touch — not narrative ───────────────────
  it("sales-state block is small (< 400 chars) per spec §5.3", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, baseState, "qualificacao");
    const doctrineEnd = out.indexOf(SDR_DOCTRINE) + SDR_DOCTRINE.length;
    const stateBlock = out.slice(doctrineEnd);
    expect(stateBlock.length).toBeLessThan(400);
  });
});
