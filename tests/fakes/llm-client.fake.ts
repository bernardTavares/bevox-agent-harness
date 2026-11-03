import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse } from
"../../src/agents/execution-context.js";

export interface FakeLlmClientOptions {
  responses?: Array<LlmCompletionResponse | Error>;
  defaultResponse?: LlmCompletionResponse;
}

/**
 * In-memory fake of LlmClient (the simpler interface used by DirectEngine and
 * other pipeline agents through AgentExecutionContext).
 */
export class FakeLlmClient implements LlmClient {
  public calls: LlmCompletionRequest[] = [];
  private queue: Array<LlmCompletionResponse | Error>;
  private readonly fallback: LlmCompletionResponse;

  constructor(opts: FakeLlmClientOptions = {}) {
    this.queue = opts.responses ?? [];
    this.fallback = opts.defaultResponse ?? {
      content: '{"output":"ok"}',
      model: 'fake-model',
      promptTokens: 10,
      completionTokens: 5
    };
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return next ?? this.fallback;
  }

  reset() {
    this.calls = [];
    this.queue = [];
  }
}