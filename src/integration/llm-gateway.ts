import pino from "pino";

import { getEnv } from "../config/env.js";

import { AnthropicAdapter } from "./llm/adapters/anthropic.adapter.js";
import { GeminiAdapter } from "./llm/adapters/gemini.adapter.js";
import { OpenAIAdapter } from "./llm/adapters/openai.adapter.js";
import { getDefaultCassetteStore } from "./llm/cassette-store.js";
import { CircuitBreakerDecorator } from "./llm/circuit-breaker.js";
import { getCredentialPool } from "./llm/credential-pool.js";
import { DevEmitterLLM } from "./llm/dev-emitter-decorator.js";
import type { Provider } from "./llm/internal.js";
import { LLMRecorder } from "./llm/recorder.js";
import { LLMReplayer } from "./llm/replay.js";
import { RetryDecorator } from "./llm/retry-decorator.js";
import { UsageDecorator, type UsageCallback } from "./llm/usage-decorator.js";

const logger = pino({ name: "llm-gateway" });

// ---------------------------------------------------------------------------
// Public types — DO NOT CHANGE.
//
// Every reasoning engine, pipeline agent, and the LlmClientBridge depends on
// the exact shape of these interfaces. Renaming a field (e.g. `tool_calls`,
// `input_tokens`, `latency_ms`) or removing role `tool` is a breaking change.
// ---------------------------------------------------------------------------

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string | null;
  tool_calls: LLMToolCall[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  model: string;
  provider: string;
  latency_ms: number;
}

export interface LLMRequestOptions {
  messages: LLMMessage[];
  tools?: LLMTool[];
  /** JSON Schema for structured output (DirectEngine only — incompatible with tools) */
  responseSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  /**
   * Optional telemetry metadata propagated to decorators (dev emitter, OTEL
   * spans). Never sent to the underlying provider. Adding fields here is
   * non-breaking; consumers ignore unknown keys.
   */
  meta?: {
    executionId?: string;
    organizationId?: string;
    purpose?: string;
  };
}

// Forward declaration to avoid circular import (streaming/types.ts imports
// `LLMRequestOptions` from here). The streaming module re-exports
// `CompleteStreamOptions` and `StreamChunk`.
import type { CompleteStreamOptions, StreamChunk } from "./llm/streaming/types.js";

export interface LLMGateway {
  complete(options: LLMRequestOptions): Promise<LLMResponse>;
  /**
   * Sprint C.2 — Optional streaming variant. Adapters that don't support
   * streaming leave this undefined. Decorators that pre-date streaming
   * propagate via `wrapped.completeStream?.(opts)`.
   *
   * IMPORTANT: streaming bypasses retry and circuit-breaker decorators by
   * design. See `docs/adr/013-streaming-bypasses-retry-circuit.md`.
   */
  completeStream?(options: CompleteStreamOptions): AsyncIterable<StreamChunk>;
}

// ---------------------------------------------------------------------------
// LLMProviderError — public
// ---------------------------------------------------------------------------

export class LLMProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "LLMProviderError";
  }
}

// ---------------------------------------------------------------------------
// Provider resolver
// ---------------------------------------------------------------------------

function resolveProvider(defaultModel: string | undefined): { provider: Provider; model: string } {
  const env = getEnv();
  const raw = defaultModel ?? `${env.DEFAULT_LLM_PROVIDER}/${env.DEFAULT_LLM_MODEL}`;
  const [rawProvider, ...rest] = raw.split("/");
  const model = rest.join("/") || env.DEFAULT_LLM_MODEL;
  const provider = (rawProvider ?? env.DEFAULT_LLM_PROVIDER) as Provider;
  return { provider, model };
}

// ---------------------------------------------------------------------------
// Factory — composes adapter + decorators
// ---------------------------------------------------------------------------

export function createLLMGateway(
  agentConfig: { default_model?: string },
  options?: { onUsage?: UsageCallback },
): LLMGateway {
  const env = getEnv();
  const { provider, model } = resolveProvider(agentConfig.default_model);
  const pool = getCredentialPool();

  let adapter: LLMGateway;
  switch (provider) {
    case "openai":
      adapter = new OpenAIAdapter(model, pool, env.LLM_REQUEST_TIMEOUT_MS);
      break;
    case "anthropic":
      adapter = new AnthropicAdapter(model, pool, env.LLM_REQUEST_TIMEOUT_MS);
      break;
    case "gemini":
      adapter = new GeminiAdapter(model, pool, env.LLM_REQUEST_TIMEOUT_MS);
      break;
    default:
      logger.warn({ provider }, "Unknown LLM provider, falling back to OpenAI");
      adapter = new OpenAIAdapter(env.DEFAULT_LLM_MODEL, pool, env.LLM_REQUEST_TIMEOUT_MS);
  }

  // Composition order matters:
  //   retry( circuit-breaker( adapter ) )
  // ─ Circuit breaker is the innermost decorator so its rolling window sees
  //   every attempt (including retry-internal attempts) — this prevents a
  //   retry storm from masking a degraded provider.
  // ─ Retry is outermost so the caller's single .complete() can survive
  //   transient blips without leaking retry concerns into the engines.
  // Composition (outer → inner): DevEmitter → Retry → CircuitBreaker → adapter.
  // Dev emitter sits outermost so its latency measurement spans the entire
  // retry budget — that's what the playground UI should display.
  const retried: LLMGateway = new RetryDecorator(
    new CircuitBreakerDecorator(adapter, `llm-${provider}`, {
      errorThresholdPct: env.LLM_CIRCUIT_ERROR_THRESHOLD_PCT,
      resetMs: env.LLM_CIRCUIT_RESET_MS,
      minSamples: env.LLM_CIRCUIT_MIN_SAMPLES,
      rollingWindowMs: env.LLM_CIRCUIT_ROLLING_WINDOW_MS,
    }),
    {
      maxAttempts: env.LLM_RETRY_MAX_ATTEMPTS,
      baseDelayMs: env.LLM_RETRY_BASE_DELAY_MS,
      maxDelayMs: env.LLM_RETRY_MAX_DELAY_MS,
    },
  );

  // Sprint A.1 — wrap in recorder/replayer when explicitly opted in.
  let withRecorder: LLMGateway;
  if (env.LLM_RECORDER_MODE === "passthrough") {
    withRecorder = retried;
  } else {
    const cassetteName = env.LLM_RECORDER_CASSETTE_NAME;
    if (!cassetteName && env.LLM_RECORDER_REQUIRE_NAME) {
      throw new Error(
        "LLM_RECORDER_MODE != 'passthrough' requires LLM_RECORDER_CASSETTE_NAME. " +
          "Set LLM_RECORDER_REQUIRE_NAME=false to allow an anonymous default cassette.",
      );
    }
    const resolvedName = cassetteName ?? "default";
    const store = getDefaultCassetteStore(env.LLM_RECORDER_CASSETTE_DIR);
    if (env.LLM_RECORDER_MODE === "record") {
      withRecorder = new LLMRecorder(retried, store, resolvedName, model, logger);
    } else {
      withRecorder = new LLMReplayer(store, resolvedName, model);
    }
  }
  // C13 — UsageDecorator entre o recorder e o DevEmitter. Posição: depois
  // do recorder (cassetes não devem mascarar uso real) e antes do
  // DevEmitter (dev event-bus pode observar mas não precisa do hook). O
  // wrap só acontece se o caller pediu callback de uso — sem caller, sem
  // overhead.
  const withUsage: LLMGateway = options?.onUsage
    ? new UsageDecorator(withRecorder, options.onUsage)
    : withRecorder;

  // Sprint D.1 — DevEmitterLLM outermost (captures dev playground events).
  return new DevEmitterLLM(withUsage);
}
