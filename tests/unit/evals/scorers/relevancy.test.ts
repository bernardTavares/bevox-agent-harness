import { describe, expect, it, vi } from "vitest";

import { RelevancyScorer } from "../../../../src/evals/scorers/relevancy.js";
import type { LLMGateway, LLMResponse } from "../../../../src/integration/llm-gateway.js";
import type { ScorerInput } from "../../../../src/evals/scorer.js";

const fakeInput: ScorerInput = {
  input: "Quero marcar consulta amanha 14h",
  output: "Claro, vou agendar para amanha as 14h.",
  meta: {
    execution_id: "11111111-1111-1111-1111-111111111111",
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    agent_name: "scheduler",
    reasoning_engine: "react",
  },
};

function makeGatewayWith(content: unknown): LLMGateway {
  const response: LLMResponse = {
    content: typeof content === "string" ? content : JSON.stringify(content),
    tool_calls: [],
    usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
    model: "gpt-4o-mini",
    provider: "openai",
    latency_ms: 120,
  };
  return { complete: vi.fn().mockResolvedValue(response) };
}

describe("RelevancyScorer", () => {
  it("parses score and reasoning from valid judge output", async () => {
    const gw = makeGatewayWith({ score: 0.9, reasoning: "Directly answers." });
    const scorer = new RelevancyScorer(gw);
    const r = await scorer.score(fakeInput);
    expect(r.score).toBe(0.9);
    expect(r.reasoning).toBe("Directly answers.");
    expect(r.model_used).toBe("gpt-4o-mini");
  });

  it("rejects judge output outside [0,1]", async () => {
    const gw = makeGatewayWith({ score: 1.5, reasoning: "bad" });
    await expect(new RelevancyScorer(gw).score(fakeInput)).rejects.toThrow();
  });

  it("rejects non-JSON content", async () => {
    const gw = makeGatewayWith("not json at all");
    await expect(new RelevancyScorer(gw).score(fakeInput)).rejects.toThrow();
  });

  it("propagates meta to gateway", async () => {
    const gw = makeGatewayWith({ score: 0.7, reasoning: "ok" });
    await new RelevancyScorer(gw).score(fakeInput);
    const call = (gw.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.meta).toMatchObject({
      executionId: fakeInput.meta.execution_id,
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      purpose: "eval:relevancy",
    });
    expect(call.temperature).toBe(0);
  });
});
