import { describe, expect, it, vi } from "vitest";

import { SdrProspectReadyScorer } from "../../../../src/evals/scorers/sdr-prospect-ready.js";
import type { LLMGateway, LLMResponse } from "../../../../src/integration/llm-gateway.js";
import type { ScorerInput } from "../../../../src/evals/scorer.js";

const baseInput: ScorerInput = {
  input: "Research this account and tell me how to approach them.",
  output: "Generic company overview with no specific insights.",
  meta: {
    execution_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    agent_name: "sdr-agent",
    reasoning_engine: "react",
  },
};

function makeGateway(content: unknown): LLMGateway {
  const response: LLMResponse = {
    content: typeof content === "string" ? content : JSON.stringify(content),
    tool_calls: [],
    usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 },
    model: "gpt-4o-mini",
    provider: "openai",
    latency_ms: 85,
  };
  return { complete: vi.fn().mockResolvedValue(response) };
}

const richOutput =
  "The target personas are CFOs and VPs of Finance at mid-market SaaS companies. " +
  "Key buyer pains include manual reporting, audit risk, and ERP integration gaps. " +
  "Trigger events include recent Series B funding and a new CFO hire last quarter. " +
  "Red-flags: they recently renewed with a competitor, so timing is sensitive.";

const weakOutput = "They are a company.";

describe("SdrProspectReadyScorer", () => {
  it("has the correct name and kind", () => {
    const gw = makeGateway({ score: 0.5, reasoning: "ok" });
    const scorer = new SdrProspectReadyScorer(gw);
    expect(scorer.name).toBe("sdr-prospect-ready");
    expect(scorer.kind).toBe("llm-judge");
  });

  it("returns high score when fake gateway returns 0.9 (rich output)", async () => {
    const gw = makeGateway({ score: 0.9, reasoning: "Articulates all four prospect-world dimensions." });
    const result = await new SdrProspectReadyScorer(gw).score({
      ...baseInput,
      output: richOutput,
    });
    expect(result.score).toBeCloseTo(0.9);
    expect(result.reasoning).toBeTruthy();
    expect(result.model_used).toBe("gpt-4o-mini");
    expect(gw.complete).toHaveBeenCalledTimes(1);
  });

  it("returns low score when fake gateway returns 0.1 (weak/empty output)", async () => {
    const gw = makeGateway({ score: 0.1, reasoning: "No target personas, pains, triggers, or red-flags found." });
    const result = await new SdrProspectReadyScorer(gw).score({
      ...baseInput,
      output: weakOutput,
    });
    expect(result.score).toBeCloseTo(0.1);
    expect(result.reasoning).toBeTruthy();
    expect(result.model_used).toBe("gpt-4o-mini");
    expect(gw.complete).toHaveBeenCalledTimes(1);
  });

  it("forwards executionId and organizationId in meta", async () => {
    const gw = makeGateway({ score: 0.7, reasoning: "Partial coverage." });
    await new SdrProspectReadyScorer(gw).score({ ...baseInput, output: richOutput });
    const call = (gw.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.meta?.executionId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(call.meta?.organizationId).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
    expect(call.meta?.purpose).toBe("eval:sdr-prospect-ready");
  });

  it("uses temperature 0 for deterministic judging", async () => {
    const gw = makeGateway({ score: 0.8, reasoning: "Good coverage." });
    await new SdrProspectReadyScorer(gw).score({ ...baseInput, output: richOutput });
    const call = (gw.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.temperature).toBe(0);
  });
});
