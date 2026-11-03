import { describe, expect, it } from "vitest";

import { SdrMessageReadyScorer } from "../../../../src/evals/scorers/sdr-message-ready.js";
import type { ScorerInput } from "../../../../src/evals/scorer.js";

// ─── Test fixture helpers ──────────────────────────────────────────────────

function buildInput(output: string): ScorerInput {
  return {
    input: "Generate an outreach message for this lead.",
    output,
    meta: {
      execution_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      account_id: 42,
      agent_name: "sdr-agent",
      reasoning_engine: "direct",
    },
  };
}

// ─── Forbidden phrase cases ────────────────────────────────────────────────

describe("SdrMessageReadyScorer — forbidden phrases", () => {
  it('returns score 0 and names violation for "touch base"', async () => {
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "Hi Maria, I wanted to reach out and touch base about how things are going at Acme Corp.",
      ),
    );
    expect(r.score).toBe(0);
    expect(r.reasoning.toLowerCase()).toMatch(/forbidden phrase|touch base/);
    expect(r.model_used).toBeNull();
  });

  it('returns score 0 for "see if there are synergies"', async () => {
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "I thought it would be great to hop on a quick call and see if there are synergies between our companies.",
      ),
    );
    expect(r.score).toBe(0);
    expect(r.reasoning.toLowerCase()).toMatch(/forbidden phrase|synerg/);
  });

  it('returns score 0 for "if you\'re not the right person" variant', async () => {
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "If you're not the right person to speak with, could you point me in the right direction?",
      ),
    );
    expect(r.score).toBe(0);
    expect(r.reasoning.toLowerCase()).toMatch(/forbidden phrase|right person/);
  });

  it("is case-insensitive for forbidden phrase detection", async () => {
    const r = await new SdrMessageReadyScorer().score(
      buildInput("Let me TOUCH BASE with you about our solution."),
    );
    expect(r.score).toBe(0);
  });
});

// ─── Multi-CTA / one-CTA rule ─────────────────────────────────────────────

describe("SdrMessageReadyScorer — CTA counting", () => {
  it("returns score 0 for message with multiple CTAs / asks", async () => {
    // Three distinct ask families: schedule a call + referral + demo
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "Can we schedule a call this week? Also, could you refer me to the right person? And would you like a demo of the platform?",
      ),
    );
    expect(r.score).toBe(0);
    expect(r.reasoning.toLowerCase()).toMatch(/multi.?cta|multiple|more than one/);
  });

  it("returns score 0 for message with zero CTA (pure statement, no ask)", async () => {
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "Our platform helps clinics reduce no-shows by 30%. We have been working in this space for five years.",
      ),
    );
    expect(r.score).toBe(0);
    expect(r.reasoning.toLowerCase()).toMatch(/no cta|no ask|no question|zero/);
  });

  it("returns score 1 for clean message with exactly one CTA (referral ask)", async () => {
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "Are you the right person to discuss reducing patient no-shows at your clinic — or could you point me to them?",
      ),
    );
    expect(r.score).toBe(1);
    expect(r.model_used).toBeNull();
  });

  it("returns score 1 for clean message with exactly one CTA (call ask)", async () => {
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "Would you be open to a 15-minute call on Thursday to explore whether this fits your situation?",
      ),
    );
    expect(r.score).toBe(1);
    expect(r.model_used).toBeNull();
  });

  it("returns score 1 for clean PT message with one CTA", async () => {
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "Você é a pessoa certa para falar sobre redução de faltas na clínica — ou poderia me indicar quem seria?",
      ),
    );
    expect(r.score).toBe(1);
    expect(r.model_used).toBeNull();
  });
});

// ─── Adversarial / hardening cases (Fix 1 + Fix 2) ───────────────────────

describe("SdrMessageReadyScorer — hardening (adverb-tolerant referral + open-for)", () => {
  it("Fix 1: scores 0 for reply+referral combo (adverb between you and verb)", async () => {
    // reply-ask family fires on "reply with a time"
    // referral-ask family fires on "introduce me to your VP"
    // adverb "also" sits between "you" and "introduce" — old pattern would miss it
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "Could you reply with a time, and also introduce me to your VP?",
      ),
    );
    expect(r.score).toBe(0);
    expect(r.reasoning.toLowerCase()).toMatch(/multi.?cta|multiple|more than one/);
  });

  it("Fix 1: scores 0 for schedule+referral combo (adverb between you and introduce)", async () => {
    // call-request family fires on "schedule a call"
    // referral-ask family fires on "introduce me to the IT director" (adverb-tolerant)
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "Could you schedule a call, and also introduce me to the IT director?",
      ),
    );
    expect(r.score).toBe(0);
    expect(r.reasoning.toLowerCase()).toMatch(/multi.?cta|multiple|more than one/);
  });

  it("Fix 2: scores 1 for 'open for a quick call' (was false-rejected before fix)", async () => {
    const r = await new SdrMessageReadyScorer().score(
      buildInput("Would you be open for a quick call?"),
    );
    expect(r.score).toBe(1);
    expect(r.model_used).toBeNull();
  });

  it("Regression: single clean referral-ask still scores 1 (adverb fix doesn't over-fire)", async () => {
    // "could you point me to them" — single referral CTA, no second family
    const r = await new SdrMessageReadyScorer().score(
      buildInput(
        "Are you the right person for X, or could you point me to them?",
      ),
    );
    expect(r.score).toBe(1);
    expect(r.model_used).toBeNull();
  });
});

// ─── Metadata / contract ──────────────────────────────────────────────────

describe("SdrMessageReadyScorer — metadata contract", () => {
  it("has correct name, kind, and model_used", async () => {
    const scorer = new SdrMessageReadyScorer();
    expect(scorer.name).toBe("sdr-message-ready");
    expect(scorer.kind).toBe("rule");

    const r = await scorer.score(
      buildInput("Could you let me know if this is a priority for you this quarter?"),
    );
    expect(r.model_used).toBeNull();
  });
});
