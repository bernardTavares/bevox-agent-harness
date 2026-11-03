import { describe, expect, it } from "vitest";

import { NoPiiScorer } from "../../../../src/evals/scorers/no-pii.js";
import type { ScorerInput } from "../../../../src/evals/scorer.js";

function buildInput(output: string): ScorerInput {
  return {
    input: "qualquer",
    output,
    meta: {
      execution_id: "44444444-4444-4444-4444-444444444444",
      account_id: 1,
      agent_name: "scheduler",
      reasoning_engine: "react",
    },
  };
}

describe("NoPiiScorer", () => {
  it("returns score 1 for clean text", async () => {
    const r = await new NoPiiScorer().score(buildInput("Tudo certo, ate amanha."));
    expect(r.score).toBe(1);
    expect(r.model_used).toBeNull();
  });

  it("flags formatted CPF", async () => {
    const r = await new NoPiiScorer().score(
      buildInput("Seu CPF 123.456.789-00 foi recebido."),
    );
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain("CPF");
  });

  it("flags email", async () => {
    const r = await new NoPiiScorer().score(
      buildInput("Envie para joao@example.com"),
    );
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain("email");
  });

  it("flags BR phone", async () => {
    const r = await new NoPiiScorer().score(
      buildInput("Ligue para +55 11 91234-5678"),
    );
    expect(r.score).toBeLessThan(1);
    expect(r.reasoning).toContain("BR phone");
  });

  it("does NOT flag bare 11-digit numbers (no false positives on IDs)", async () => {
    // Common false-positive case the bare-11-digit regex caught — must NOT
    // trigger here.
    const r = await new NoPiiScorer().score(buildInput("Order id 12345678901."));
    expect(r.score).toBe(1);
  });

  it("score decays with multiple PII types", async () => {
    const r = await new NoPiiScorer().score(
      buildInput("CPF 123.456.789-00 e email teste@a.com"),
    );
    expect(r.score).toBeCloseTo(1 - 0.34 * 2, 5);
  });
});
