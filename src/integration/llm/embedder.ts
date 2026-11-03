/**
 * Sprint D.2 (G.10) — Separate `LLMEmbedder` interface.
 *
 * Intentionally NOT a method on `LLMGateway`. Rationale:
 *   - Completion and embedding endpoints have disjoint shapes (no tools, no
 *     streaming, no temperature for embeddings).
 *   - Provider coverage is asymmetric: Anthropic has no first-party embedding
 *     API. Conflating them on `LLMGateway` would force every gateway consumer
 *     to handle "embed not supported" — leaky.
 *   - Decorators (retry/circuit/recorder) compose differently: embeddings
 *     are batched (up to 100 inputs/call), idempotent, and benefit from a
 *     content-addressed cache (rag_embedding_cache) that completions don't.
 *
 * Factory `createLLMEmbedder()` is the parallel of `createLLMGateway()`.
 */

import { getEnv } from "../../config/env.js";

import { GeminiEmbedAdapter } from "./adapters/gemini-embed.adapter.js";
import { OpenAIEmbedAdapter } from "./adapters/openai-embed.adapter.js";
import { getCredentialPool } from "./credential-pool.js";
import type { Provider } from "./internal.js";

export interface EmbedRequest {
  /** One-to-many inputs in a single API call. Providers cap at ~100. */
  inputs: string[];
  /** Optional override; defaults to embedder's configured model. */
  model?: string;
  meta?: {
    executionId?: string;
    organizationId?: string;
    purpose?: string;
  };
}

export interface EmbedResponse {
  provider: string;
  model: string;
  /** Same length & order as `inputs`. */
  embeddings: number[][];
  usage: { input_tokens: number };
  latency_ms: number;
}

export interface LLMEmbedder {
  embed(req: EmbedRequest): Promise<EmbedResponse>;
  readonly provider: string;
  readonly model: string;
  /** Dimension of returned vectors. Schema must match. */
  readonly dim: number;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

interface EmbedderDescriptor {
  provider: Provider;
  model: string;
  dim: number;
}

function resolveEmbedder(model?: string): EmbedderDescriptor {
  // Embedder model is its own env var (RAG_EMBEDDING_MODEL); decoupled from
  // the chat model. Accepts either bare model name (provider inferred) or
  // "provider/model" qualified form.
  const env = getEnv();
  const raw = model ?? env.RAG_EMBEDDING_MODEL;
  let provider: Provider;
  let modelName: string;

  if (raw.includes("/")) {
    const [p, ...rest] = raw.split("/");
    provider = (p ?? env.DEFAULT_LLM_PROVIDER) as Provider;
    modelName = rest.join("/");
  } else {
    modelName = raw;
    if (raw.startsWith("text-embedding-")) {
      provider = "openai";
    } else if (raw.startsWith("gemini-embedding") || raw.startsWith("text-embedding-004")) {
      provider = "gemini";
    } else {
      provider = env.DEFAULT_LLM_PROVIDER as Provider;
    }
  }

  // Dimension is provider/model dependent. Anthropic intentionally absent —
  // no first-party embedding endpoint as of 2026-05.
  const dim = env.RAG_EMBEDDING_DIM;
  return { provider, model: modelName, dim };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLLMEmbedder(opts: { model?: string } = {}): LLMEmbedder {
  const env = getEnv();
  const { provider, model, dim } = resolveEmbedder(opts.model);
  const pool = getCredentialPool();

  switch (provider) {
    case "openai":
      return new OpenAIEmbedAdapter(model, dim, pool, env.LLM_REQUEST_TIMEOUT_MS);
    case "gemini":
      return new GeminiEmbedAdapter(model, dim, pool, env.LLM_REQUEST_TIMEOUT_MS);
    case "anthropic":
      throw new Error(
        "createLLMEmbedder: Anthropic has no first-party embedding API. " +
          "Set RAG_EMBEDDING_MODEL to an OpenAI or Gemini embedding model.",
      );
    default:
      throw new Error(`createLLMEmbedder: unknown provider "${provider}"`);
  }
}
