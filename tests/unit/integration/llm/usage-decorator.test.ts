import { describe, it, expect } from "vitest";

import type {
  LLMGateway,
  LLMRequestOptions,
  LLMResponse,
} from "../../../../src/integration/llm-gateway.js";
import { UsageDecorator } from "../../../../src/integration/llm/usage-decorator.js";
import { calculateCostCents } from "../../../../src/observability/cost-calculator.js";

function buildResponse(over: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "hi",
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    model: "gpt-4o-mini",
    provider: "openai",
    latency_ms: 42,
    ...over,
  };
}

class FakeGateway implements LLMGateway {
  public calls = 0;
  constructor(private readonly nextResponses: LLMResponse[]) {}
  async complete(_options: LLMRequestOptions): Promise<LLMResponse> {
    const r = this.nextResponses[this.calls];
    if (!r) throw new Error("FakeGateway exhausted");
    this.calls += 1;
    return r;
  }
}

describe("UsageDecorator", () => {
  it("repasses LLMResponse intacto e dispara onUsage com tokens + metadata", async () => {
    const fake = new FakeGateway([buildResponse()]);
    const captured: Array<{ usage: LLMResponse["usage"]; meta: unknown }> = [];

    const dec = new UsageDecorator(fake, (usage, meta) => {
      captured.push({ usage, meta });
    });

    const out = await dec.complete({ messages: [] });

    expect(out.content).toBe("hi");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(captured[0]?.meta).toEqual({ model: "gpt-4o-mini", provider: "openai", latencyMs: 42 });
  });

  it("invoca onUsage uma vez por call (acumulação faz o caller, não o decorator)", async () => {
    const fake = new FakeGateway([
      buildResponse({ usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
      buildResponse({ usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } }),
      buildResponse({ usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } }),
    ]);
    const acc = { prompt: 0, completion: 0 };
    const dec = new UsageDecorator(fake, (usage) => {
      acc.prompt += usage.input_tokens;
      acc.completion += usage.output_tokens;
    });

    await dec.complete({ messages: [] });
    await dec.complete({ messages: [] });
    await dec.complete({ messages: [] });

    expect(acc).toEqual({ prompt: 21, completion: 10 });
    expect(fake.calls).toBe(3);
  });

  it("engole erros do callback sem quebrar a chamada do LLM", async () => {
    const fake = new FakeGateway([buildResponse()]);
    const dec = new UsageDecorator(fake, () => {
      throw new Error("kaboom — métrica não pode quebrar a request");
    });

    // Não deve lançar. A resposta deve voltar normalmente.
    const out = await dec.complete({ messages: [] });
    expect(out.content).toBe("hi");
  });

  it("não invoca onUsage se complete() falhar (erro upstream propaga)", async () => {
    class FailingGateway implements LLMGateway {
      async complete(): Promise<LLMResponse> {
        throw new Error("upstream LLM erro");
      }
    }
    let invoked = false;
    const dec = new UsageDecorator(new FailingGateway(), () => {
      invoked = true;
    });

    await expect(dec.complete({ messages: [] })).rejects.toThrow("upstream LLM erro");
    expect(invoked).toBe(false);
  });

  it("completeStream lança se o inner não suporta streaming", () => {
    class NoStreamGateway implements LLMGateway {
      async complete(): Promise<LLMResponse> {
        return buildResponse();
      }
    }
    const dec = new UsageDecorator(new NoStreamGateway(), () => undefined);
    expect(() =>
      dec.completeStream({
        messages: [],
        // @ts-expect-error — só checando que o método lança antes de validar opts.
        onChunk: () => undefined,
      }),
    ).toThrow(/streaming não suportado/);
  });
});

describe("UsageDecorator drives a cost accumulator via meta.model (J9)", () => {
  it("a cost-summing onUsage callback receives meta and accumulates monotonically", async () => {
    const costAccumulator = { costCents: 0 };
    const inner = new FakeGateway([
      buildResponse({
        model: "gpt-4o-mini",
        usage: { input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 },
      }),
      buildResponse({
        model: "gpt-4o-mini",
        usage: { input_tokens: 0, output_tokens: 1_000_000, total_tokens: 1_000_000 },
      }),
    ]);
    const decorated = new UsageDecorator(inner, (usage, meta) => {
      // mirrors the handler's onUsage (§4.5): cost via the REAL model reported
      costAccumulator.costCents += calculateCostCents(
        meta.model,
        usage.input_tokens ?? 0,
        usage.output_tokens ?? 0,
      );
    });

    await decorated.complete({} as never);
    // gpt-4o-mini prompt=15c/1M → ceil(15) = 15
    expect(costAccumulator.costCents).toBe(15);

    await decorated.complete({} as never);
    // + completion=60c/1M → ceil(60) = 60 → 75 total (monotonic)
    expect(costAccumulator.costCents).toBe(75);
  });

  it("unknown model contributes 0 — ceiling never trips for it (gap §8)", async () => {
    const costAccumulator = { costCents: 0 };
    const inner = new FakeGateway([
      buildResponse({
        model: "some-unpriced-model",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
      }),
    ]);
    const decorated = new UsageDecorator(inner, (usage, meta) => {
      costAccumulator.costCents += calculateCostCents(
        meta.model,
        usage.input_tokens ?? 0,
        usage.output_tokens ?? 0,
      );
    });
    await decorated.complete({} as never);
    expect(costAccumulator.costCents).toBe(0);
  });
});
