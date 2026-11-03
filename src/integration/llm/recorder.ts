/**
 * `LLMRecorder` — outermost decorator for record mode.
 *
 * Composition (top → bottom):
 *
 *     LLMRecorder
 *       └─ RetryDecorator
 *            └─ CircuitBreakerDecorator
 *                 └─ adapter (OpenAI / Anthropic / Gemini)
 *
 * The recorder sits at the public boundary so cassettes capture the **observed**
 * behavior of the full pipeline (retries, circuit short-circuits, etc.). On a
 * cassette hit it bypasses `wrapped` entirely — same hash → identical response
 * → no upstream calls. On a miss it forwards, then persists the response.
 *
 * Implements `LLMDecorator` (with `readonly wrapped`) per the same pattern as
 * `RetryDecorator` and `CircuitBreakerDecorator`.
 */
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway.js";

import type { CassetteEntry } from "./cassette-schema.js";
import type { CassetteStore } from "./cassette-store.js";
import type { LLMDecorator } from "./internal.js";
import { hashRequest } from "./request-hasher.js";
import type { CompleteStreamOptions, StreamChunk } from "./streaming/types.js";

interface RecorderLogger {
  info(obj: object, msg: string): void;
}

export class LLMRecorder implements LLMDecorator {
  constructor(
    public readonly wrapped: LLMGateway,
    private readonly store: CassetteStore,
    private readonly cassetteName: string,
    private readonly model: string,
    private readonly logger?: RecorderLogger,
  ) {}

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const hash = hashRequest(options, this.model);
    const cassette = await this.store.load(this.cassetteName);

    if (cassette) {
      const found = this.store.find(cassette, hash);
      if (found) {
        this.logger?.info(
          { hash: hash.slice(0, 12), cassette: this.cassetteName },
          "cassette hit (record-mode passthrough)",
        );
        return found.response;
      }
    }

    const response = await this.wrapped.complete(options);

    const entry: CassetteEntry = {
      request_hash: hash,
      request_summary: {
        model: this.model,
        provider: response.provider,
        temperature: options.temperature,
        n_messages: options.messages.length,
        // Post-review: never write `undefined` — fixtures should carry 0
        // explicitly so they round-trip through Zod cleanly.
        n_tools: options.tools?.length ?? 0,
        has_response_schema: options.responseSchema !== undefined,
      },
      response,
      recorded_at: new Date().toISOString(),
    };
    await this.store.append(this.cassetteName, entry);
    this.logger?.info(
      { hash: hash.slice(0, 12), cassette: this.cassetteName },
      "cassette miss → recorded",
    );
    return response;
  }

  /**
   * Streaming pass-through. Cassettes currently only record one-shot
   * `complete()` responses; stream recording is a future sprint (would
   * require capturing the full chunk sequence). For now pass through so
   * stream callers still work in `record` mode.
   */
  completeStream(options: CompleteStreamOptions): AsyncIterable<StreamChunk> {
    if (!this.wrapped.completeStream) {
      throw new Error("Wrapped gateway does not support streaming");
    }
    return this.wrapped.completeStream(options);
  }
}
