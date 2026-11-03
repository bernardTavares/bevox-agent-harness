/**
 * `LLMReplayer` — strict replay mode.
 *
 * Reads recorded cassette entries and returns the persisted response when the
 * request hash matches. A miss (file absent or no entry) throws
 * `CassetteMissError` — intentionally — so tests fail loudly when their
 * fixture drifts from the code under test.
 *
 * `LLMReplayer` does NOT implement `LLMDecorator`: there is no upstream to
 * wrap. It is a terminal `LLMGateway` implementation.
 *
 * IMPORTANT: `latency_ms` in the response is the value captured at recording
 * time. Tests that need to assert real wall-clock latency must inject a
 * deterministic clock at a higher layer.
 */
import type { LLMGateway, LLMRequestOptions, LLMResponse } from "../llm-gateway.js";

import type { CassetteStore } from "./cassette-store.js";
import { CassetteMissError } from "./errors.js";
import { hashRequest } from "./request-hasher.js";

export class LLMReplayer implements LLMGateway {
  constructor(
    private readonly store: CassetteStore,
    private readonly cassetteName: string,
    private readonly model: string,
  ) {}

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const hash = hashRequest(options, this.model);
    const cassette = await this.store.load(this.cassetteName);
    if (!cassette) {
      throw new CassetteMissError(this.cassetteName, hash);
    }
    const entry = this.store.find(cassette, hash);
    if (!entry) {
      throw new CassetteMissError(this.cassetteName, hash);
    }
    return entry.response;
  }

  /**
   * Replay mode does NOT support streaming yet; throw a clear error rather
   * than silently fall back to mock chunks. Sprint follow-up: capture stream
   * chunks in the cassette format.
   */
  completeStream(): never {
    throw new Error(
      "LLMReplayer does not support completeStream; use LLM_RECORDER_MODE=passthrough or extend the cassette schema.",
    );
  }
}
