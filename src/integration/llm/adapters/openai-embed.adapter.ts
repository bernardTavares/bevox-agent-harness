import { LLMProviderError } from "../../llm-gateway.js";
import type { CredentialPool } from "../credential-pool.js";
import type { EmbedRequest, EmbedResponse, LLMEmbedder } from "../embedder.js";

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export class OpenAIEmbedAdapter implements LLMEmbedder {
  readonly provider = "openai";

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
    const apiKey = this.pool.acquire("openai");

    const body = {
      input: req.inputs,
      model: req.model ?? this.model,
    };

    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new LLMProviderError(
        "openai",
        res.status,
        `OpenAI embed error ${res.status}: ${text}`,
      );
      if (res.status === 401 || res.status === 403) {
        this.pool.reportFailure("openai", apiKey);
      }
      throw err;
    }

    const data = (await res.json()) as OpenAIEmbedResponse;
    // Provider may return data unordered — sort by `index` to preserve input order.
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((d) => d.embedding);

    // Runtime dim guard: bail loudly on a mismatch instead of writing rows
    // that will fail at index insertion time.
    for (const emb of embeddings) {
      if (emb.length !== this.dim) {
        throw new Error(
          `OpenAIEmbedAdapter: model "${this.model}" returned dim=${emb.length} but adapter configured dim=${this.dim}`,
        );
      }
    }

    this.pool.reportSuccess("openai", apiKey);

    return {
      provider: this.provider,
      model: data.model ?? this.model,
      embeddings,
      usage: { input_tokens: data.usage?.prompt_tokens ?? 0 },
      latency_ms: Date.now() - t0,
    };
  }
}
