import { describe, expect, it, vi } from "vitest";

import { FaithfulnessScorer } from "../../../../src/evals/scorers/faithfulness.js";
import type { LLMGateway, LLMResponse } from "../../../../src/integration/llm-gateway.js";
import type { ScorerInput } from "../../../../src/evals/scorer.js";

const baseInput: ScorerInput = {
  input: "Qual o horario do consultorio?",
  output: "Segunda a sexta, 8h-18h.",
  meta: {
    execution_id: "33333333-3333-3333-3333-333333333333",
    account_id: 7,
    agent_name: "scheduler",
    reasoning_engine: "react",
  },
};

function makeGateway(content: unknown): LLMGateway {
  const response: LLMResponse = {
    content: typeof content === "string" ? content : JSON.stringify(content),
    tool_calls: [],
    usage: { input_tokens: 30, output_tokens: 15, total_tokens: 45 },
    model: "gpt-4o-mini",
    provider: "openai",
    latency_ms: 90,
  };
  return { complete: vi.fn().mockResolvedValue(response) };
}

describe("FaithfulnessScorer", () => {
  it("returns score:null and skips gateway when no grounding context", async () => {
    const gw = makeGateway({ score: 1, reasoning: "x" });
    const r = await new FaithfulnessScorer(gw).score({ ...baseInput, context: {} });
    expect(r.score).toBeNull();
    expect(r.model_used).toBeNull();
    expect(r.reasoning).toMatch(/N\/A/);
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("returns score:null when context exists but facts/knowledge empty arrays", async () => {
    const gw = makeGateway({ score: 1, reasoning: "x" });
    const r = await new FaithfulnessScorer(gw).score({
      ...baseInput,
      context: { facts: [], knowledge: [] },
    });
    expect(r.score).toBeNull();
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("calls judge when facts present", async () => {
    const gw = makeGateway({ score: 0.85, reasoning: "Mostly grounded." });
    const r = await new FaithfulnessScorer(gw).score({
      ...baseInput,
      context: { facts: [{ key: "hours", value: "8-18" }] },
    });
    expect(r.score).toBe(0.85);
    expect(gw.complete).toHaveBeenCalledTimes(1);
  });

  it("calls judge when knowledge present", async () => {
    const gw = makeGateway({ score: 0.95, reasoning: "Faithful." });
    const r = await new FaithfulnessScorer(gw).score({
      ...baseInput,
      context: { knowledge: ["Consultorio funciona 8h-18h"] },
    });
    expect(r.score).toBe(0.95);
  });
});
