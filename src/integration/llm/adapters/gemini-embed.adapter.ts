import { LLMProviderError } from "../../llm-gateway.js";
import type { CredentialPool } from "../credential-pool.js";
import type { EmbedRequest, EmbedResponse, LLMEmbedder } from "../embedder.js";

/**
 * Gemini batchEmbedContents endpoint.
 *
 * NB: Anthropic has no first-party embedding API — explicitly rejected in
 * `createLLMEmbedder`. This adapter is the OpenAI alternative.
 */

interface GeminiBatchEmbedResponse {
  embeddings: Array<{ values: number[] }>;
}

export class GeminiEmbedAdapter implements LLMEmbedder {
  readonly provider = "gemini";

  constructor(
    public readonly model: string,
    public readonly dim: number,
    private readonly pool: CredentialPool,
    private readonly timeoutMs: number = 30_000,
  ) {}

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const t0 = Date.now();
    if (req.inputs.length === 0) {
      return {
        provider: this.provider,
        model: this.model,
        embeddings: [],
        usage: { input_tokens: 0 },
        latency_ms: 0,
      };
    }
    const apiKey = this.pool.acquire("gemini");
    const model = req.model ?? this.model;

    // Gemini batch endpoint expects requests array, each referencing the model
    // path. See https://ai.google.dev/api/embeddings#batch-embed-contents
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents` +
      `?key=${encodeURIComponent(apiKey)}`;

    const body = {
      requests: req.inputs.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      })),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new LLMProviderError(
        "gemini",
        res.status,
        `Gemini embed error ${res.status}: ${text}`,
      );
      if (res.status === 401 || res.status === 403) {
        this.pool.reportFailure("gemini", apiKey);
      }
      throw err;
    }

    const data = (await res.json()) as GeminiBatchEmbedResponse;
    const embeddings = (data.embeddings ?? []).map((e) => e.values);

    for (const emb of embeddings) {
      if (emb.length !== this.dim) {
        throw new Error(
          `GeminiEmbedAdapter: model "${model}" returned dim=${emb.length} but adapter configured dim=${this.dim}`,
        );
      }
    }

    this.pool.reportSuccess("gemini", apiKey);

    // Gemini does not report token usage in batch embed — count chars
    // conservatively (caller treats this as approximate).
    const charCount = req.inputs.reduce((acc, s) => acc + s.length, 0);
    return {
      provider: this.provider,
      model,
      embeddings,
      usage: { input_tokens: Math.ceil(charCount / 4) },
      latency_ms: Date.now() - t0,
    };
  }
}
