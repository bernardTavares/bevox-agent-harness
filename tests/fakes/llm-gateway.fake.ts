import type {
  LLMGateway,
  LLMRequestOptions,
  LLMResponse } from
"../../src/integration/llm-gateway.js";

export interface FakeLLMGatewayOptions {
  /** Sequential queued responses. If exhausted, falls back to defaultResponse. */
  responses?: Array<LLMResponse | Error>;
  defaultResponse?: LLMResponse;
}

/**
 * In-memory fake of LLMGateway. Records every call to `.calls` and returns the
 * next queued response (or `defaultResponse` if queue is empty). Errors in the
 * queue are thrown.
 */
export class FakeLLMGateway implements LLMGateway {
  public calls: LLMRequestOptions[] = [];
  private queue: Array<LLMResponse | Error>;
  private readonly fallback: LLMResponse;

  constructor(opts: FakeLLMGatewayOptions = {}) {
    this.queue = opts.responses ?? [];
    this.fallback = opts.defaultResponse ?? {
      content: '{"output":"ok"}',
      tool_calls: [],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      model: 'fake-model',
      provider: 'fake',
      latency_ms: 1
    };
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    this.calls.push(options);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return next ?? this.fallback;
  }

  reset() {
    this.calls = [];
    this.queue = [];
  }
}