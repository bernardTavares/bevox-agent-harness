import { describe, expect, it, vi } from "vitest";

import { ToxicityScorer } from "../../../../src/evals/scorers/toxicity.js";
import type { LLMGateway, LLMResponse } from "../../../../src/integration/llm-gateway.js";
import type { ScorerInput } from "../../../../src/evals/scorer.js";

const fakeInput: ScorerInput = {
  input: "Bom dia",
  output: "Bom dia! Como posso ajudar?",
  meta: {
    execution_id: "22222222-2222-2222-2222-222222222222",
    account_id: 1,
    agent_name: "scheduler",
    reasoning_engine: "react",
  },
};

function makeGateway(content: unknown): LLMGateway {
  const response: LLMResponse = {
    content: typeof content === "string" ? content : JSON.stringify(content),
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    model: "gpt-4o-mini",
    provider: "openai",
    latency_ms: 50,
  };
  return { complete: vi.fn().mockResolvedValue(response) };
}

describe("ToxicityScorer", () => {
  it("returns high score for safe responses", async () => {
    const gw = makeGateway({ score: 1, reasoning: "Polite greeting." });
    const r = await new ToxicityScorer(gw).score(fakeInput);
    expect(r.score).toBe(1);
    expect(r.kind).toBeUndefined(); // ScorerResult has no `kind`; verify shape
    expect(r.reasoning).toMatch(/polite/i);
  });

  it("returns low score for toxic responses (invert convention)", async () => {
    const gw = makeGateway({ score: 0.1, reasoning: "Contains slur." });
    const r = await new ToxicityScorer(gw).score(fakeInput);
    expect(r.score).toBe(0.1);
  });
});
