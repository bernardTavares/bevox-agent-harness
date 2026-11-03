import {
  LLMProviderError,
  type LLMRequestOptions,
  type LLMResponse,
  type LLMToolCall,
} from "../../llm-gateway.js";
import type { CredentialPool } from "../credential-pool.js";
import type { LLMAdapter } from "../internal.js";
import { openaiCompleteStream } from "../streaming/openai-stream.js";
import type { CompleteStreamOptions, StreamChunk } from "../streaming/types.js";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface OpenAIChatMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIAdapter implements LLMAdapter {
  readonly provider = "openai" as const;

  constructor(
    public readonly model: string,
    private readonly pool: CredentialPool,
    private readonly timeoutMs: number = 30_000,
  ) {}

  supportsModel(model: string): boolean {
    return model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3");
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const startMs = Date.now();
    const apiKey = this.pool.acquire("openai");

    const messages: OpenAIChatMessage[] = options.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0,
    };

    if (options.tools && options.tools.length > 0) {
      body["tools"] = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body["tool_choice"] = "auto";
    } else if (options.responseSchema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: options.responseSchema,
          strict: false,
        },
      };
    }

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new LLMProviderError(
          "openai",
          res.status,
          `OpenAI API error ${res.status}: ${text}`,
        );
        // 401/403 → likely bad key; mark it down so the pool rotates.
        if (res.status === 401 || res.status === 403) {
          this.pool.reportFailure("openai", apiKey);
        }
        throw err;
      }

      const data = (await res.json()) as OpenAIResponse;
      const choice = data.choices[0];
      const latency_ms = Date.now() - startMs;

      const tool_calls: LLMToolCall[] = (choice?.message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: ((): Record<string, unknown> => {
          try {
            return JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
      }));

      this.pool.reportSuccess("openai", apiKey);

      return {
        content: choice?.message.content ?? null,
        tool_calls,
        usage: {
          input_tokens: data.usage?.prompt_tokens ?? 0,
          output_tokens: data.usage?.completion_tokens ?? 0,
          total_tokens: data.usage?.total_tokens ?? 0,
        },
        model: data.model ?? this.model,
        provider: "openai",
        latency_ms,
      };
    } catch (err) {
      // Network / abort errors: do NOT report failure against the key — the
      // credential is probably fine. The retry/circuit decorators handle this.
      if (err instanceof LLMProviderError) throw err;
      throw err;
    }
  }

  /**
   * Streaming counterpart. Backward-compatible: callers that don't need
   * streaming continue to use `complete()`. Bypasses retry/circuit-breaker
   * decorators by design (see ADR 013).
   */
  completeStream(options: CompleteStreamOptions): AsyncIterable<StreamChunk> {
    const apiKey = this.pool.acquire("openai");
    return openaiCompleteStream(options, {
      apiKey,
      model: this.model,
      pool: this.pool,
      timeoutMs: this.timeoutMs,
    });
  }
}
