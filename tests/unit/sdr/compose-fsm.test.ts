/**
 * compose-fsm.test.ts
 *
 * Tests for composeSystemPrompt's 5-arg (fsmProjection) branch (Fase C C.7).
 *
 * The fsmProjection branch was previously dead/untested because
 * _dispatchModelCImpl bypassed it via direct string concatenation.
 * Fix 1 routes through composeSystemPrompt; these tests prove:
 *   1. (RED → GREEN after fix) the fsmProjection branch appends the FSM block
 *      in exactly the same format as the previous manual concat.
 *   2. Without fsmProjection the 4-arg output is byte-identical (zero-cost gate).
 *   3. With fsmProjection + salesState the ordering is: doctrine → L3 → FSM.
 *   4. Disabled / absent profile → base unchanged regardless of fsmProjection.
 */

import { describe, it, expect } from "vitest";
import { composeSystemPrompt, type SdrFsmProjection } from "../../../src/sdr/compose.js";
import { SDR_DOCTRINE } from "../../../src/sdr/doctrine.js";

const enabledProfile = { enabled: true, qualification_framework: "PACT" as const };

const sampleProjection: SdrFsmProjection = {
  accountStatus: "Cold",
  cadenceStep: "touch-1",
  allowedTransitions: [
    "positive-reply → Qualified/Nurture:Active",
    "opt-out → Nurture:Dead",
    "soft-no → continue cadence",
  ],
};

// ─── Helper: build the FSM block exactly as the old manual concat did ────────
function manualFsmBlock(p: SdrFsmProjection): string {
  const transitions =
    p.allowedTransitions.length > 0 ? p.allowedTransitions.join(", ") : "none";
  return (
    `## FSM STATE\n` +
    `- account-status: ${p.accountStatus}\n` +
    `- cadence-step: ${p.cadenceStep}\n` +
    `- next-transitions: ${transitions}`
  );
}

describe("composeSystemPrompt — fsmProjection branch (Fase C C.7 Fix 1)", () => {
  // ── Fix-1 core: 5-arg form appends FSM block exactly as old manual concat ─
  it("5-arg: appends FSM block after doctrine (byte-identical to old manual concat)", () => {
    const rawBase = "BASE";
    // What agentContext.systemPrompt contains when _dispatchModelCImpl receives it:
    const alreadyComposed = `${rawBase}\n\n${SDR_DOCTRINE}`;
    // Old manual concat output:
    const oldOutput = `${alreadyComposed}\n\n${manualFsmBlock(sampleProjection)}`;
    // New routed output — pass the RAW base (pre-doctrine), profile, no L3, fsmProjection:
    const newOutput = composeSystemPrompt(rawBase, enabledProfile, null, undefined, sampleProjection);
    expect(newOutput).toBe(oldOutput);
  });

  // ── FSM block content assertions ──────────────────────────────────────────
  it("5-arg: FSM block contains account-status", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, null, undefined, sampleProjection);
    expect(out).toContain("## FSM STATE");
    expect(out).toContain("- account-status: Cold");
  });

  it("5-arg: FSM block contains cadence-step", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, null, undefined, sampleProjection);
    expect(out).toContain("- cadence-step: touch-1");
  });

  it("5-arg: FSM block contains next-transitions joined by ', '", () => {
    const out = composeSystemPrompt("BASE", enabledProfile, null, undefined, sampleProjection);
    expect(out).toContain(
      "- next-transitions: positive-reply → Qualified/Nurture:Active, opt-out → Nurture:Dead, soft-no → continue cadence",
    );
  });

  it("5-arg: FSM block shows 'none' when allowedTransitions is empty", () => {
    const emptyTransitions: SdrFsmProjection = { ...sampleProjection, allowedTransitions: [] };
    const out = composeSystemPrompt("BASE", enabledProfile, null, undefined, emptyTransitions);
    expect(out).toContain("- next-transitions: none");
  });

  // ── Zero-cost gate: no fsmProjection → byte-identical to 4-arg ───────────
  it("4-arg vs 5-arg(null): identical output (zero-cost gate preserved)", () => {
    const fourArg = composeSystemPrompt("BASE", enabledProfile, null, undefined);
    const fiveArgNull = composeSystemPrompt("BASE", enabledProfile, null, undefined, null);
    const fiveArgUndef = composeSystemPrompt("BASE", enabledProfile, null, undefined, undefined);
    expect(fiveArgNull).toBe(fourArg);
    expect(fiveArgUndef).toBe(fourArg);
  });

  // ── Ordering: doctrine → L3 → FSM ────────────────────────────────────────
  it("with salesState: ordering is doctrine → L3 → FSM", () => {
    const snapshot = {
      status: "working" as const,
      lastTouchAt: new Date("2026-05-10T12:00:00Z"),
    };
    const out = composeSystemPrompt("BASE", enabledProfile, snapshot, "qualificacao", sampleProjection);
    const doctrineIdx = out.indexOf(SDR_DOCTRINE);
    const l3Idx = out.indexOf("## L3 SALES STATE");
    const fsmIdx = out.indexOf("## FSM STATE");
    expect(doctrineIdx).toBeGreaterThanOrEqual(0);
    expect(l3Idx).toBeGreaterThan(doctrineIdx);
    expect(fsmIdx).toBeGreaterThan(l3Idx);
  });

  it("with salesState: FSM block still contains account-status + cadence-step", () => {
    const snapshot = {
      status: "working" as const,
      lastTouchAt: new Date("2026-05-10T12:00:00Z"),
    };
    const out = composeSystemPrompt("BASE", enabledProfile, snapshot, "qualificacao", sampleProjection);
    expect(out).toContain("## FSM STATE");
    expect(out).toContain("- account-status: Cold");
    expect(out).toContain("- cadence-step: touch-1");
  });

  // ── Gate off: disabled/absent profile → base unchanged ───────────────────
  it("disabled profile + fsmProjection → base unchanged (zero-cost gate)", () => {
    const out = composeSystemPrompt(
      "BASE",
      { enabled: false, qualification_framework: "PACT" },
      null,
      undefined,
      sampleProjection,
    );
    expect(out).toBe("BASE");
  });

  it("absent profile + fsmProjection → base unchanged (zero-cost gate)", () => {
    const out = composeSystemPrompt("BASE", undefined, null, undefined, sampleProjection);
    expect(out).toBe("BASE");
  });
});
