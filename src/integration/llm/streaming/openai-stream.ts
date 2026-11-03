/**
 * OpenAI Chat Completions streaming.
 *
 * Translates OpenAI's SSE deltas (`choices[0].delta`) into the harness's
 * provider-neutral `StreamChunk` shape.
 *
 * `seq` is generated locally (per stream); the consuming `StreamPublisher`
 * assigns the FINAL monotonic seq when forwarding to Bevox. The local seq
 * here is only useful for debugging the raw provider stream.
 */
import { LLMProviderError } from "../../llm-gateway.js";
import type { CredentialPool } from "../credential-pool.js";

import { parseSSE } from "./sse-parser.js";
import type { CompleteStreamOptions, StreamChunk } from "./types.js";

interface BuildBodyDeps {
  model: string;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  responseSchema?: Record<string, unknown>;
}

export function buildOpenAIStreamBody(
  opts: CompleteStreamOptions,
  deps: BuildBodyDeps,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: deps.model,
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    })),
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 0,
    stream: true,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  } else if (opts.responseSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: opts.responseSchema, strict: false },
    };
  }
  return body;
}

export interface OpenAIStreamDeps {
  apiKey: string;
  model: string;
  pool: CredentialPool;
  timeoutMs: number;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/**
 * Yields provider-neutral `StreamChunk`s from OpenAI SSE. Caller is
 * responsible for stitching tool-call args (the publisher does this).
 *
 * Error handling:
 *  - HTTP non-2xx → throws LLMProviderError (caller emits `error` chunk).
 *  - Network/abort → propagates AbortError; caller emits `error` chunk.
 */
export async function* openaiCompleteStream(
  opts: CompleteStreamOptions,
  deps: OpenAIStreamDeps,
): AsyncIterable<StreamChunk> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = deps.endpoint ?? "https://api.openai.com/v1/chat/completions";
  let seq = 0;
  const started = Date.now();
  const startedToolCalls = new Set<string>();

  // Inner abort: combine external signal with our timeout.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("OpenAI stream timeout")), deps.timeoutMs);
  const onExternalAbort = (): void => ac.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildOpenAIStreamBody(opts, { model: deps.model })),
      signal: ac.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        deps.pool.reportFailure("openai", deps.apiKey);
      }
      throw new LLMProviderError(
        "openai",
        response.status,
        `OpenAI stream HTTP ${response.status}: ${text}`,
      );
    }

    for await (const evt of parseSSE(response)) {
      if (evt.data === "[DONE]") break;
      let json: {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      try {
        json = JSON.parse(evt.data);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield {
          type: "token",
          seq: seq++,
          timestamp: Date.now(),
          payload: { delta: delta.content },
        };
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const id = tc.id ?? `idx-${tc.index ?? 0}`;
          if (tc.function?.name && !startedToolCalls.has(id)) {
            startedToolCalls.add(id);
            yield {
              type: "tool_call_start",
              seq: seq++,
              timestamp: Date.now(),
              payload: { toolCallId: id, name: tc.function.name },
            };
          }
          if (tc.function?.arguments) {
            yield {
              type: "tool_call_delta",
              seq: seq++,
              timestamp: Date.now(),
              payload: { toolCallId: id, argsDelta: tc.function.arguments },
            };
          }
        }
      }
    }

    deps.pool.reportSuccess("openai", deps.apiKey);
    yield {
      type: "done",
      seq: seq++,
      timestamp: Date.now(),
      payload: { totalDurationMs: Date.now() - started },
    };
  } finally {
    clearTimeout(timer);
    if (opts.signal) {
      opts.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
