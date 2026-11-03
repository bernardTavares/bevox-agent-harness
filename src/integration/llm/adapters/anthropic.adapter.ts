import {
  LLMProviderError,
  type LLMRequestOptions,
  type LLMResponse,
  type LLMToolCall,
} from "../../llm-gateway.js";
import type { CredentialPool } from "../credential-pool.js";
import type { LLMAdapter } from "../internal.js";
import { anthropicCompleteStream } from "../streaming/anthropic-stream.js";
import type { CompleteStreamOptions, StreamChunk } from "../streaming/types.js";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[] | string;
}

interface AnthropicResponse {
  id: string;
  model: string;
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;

  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements LLMAdapter {
  readonly provider = "anthropic" as const;

  constructor(
    public readonly model: string,
    private readonly pool: CredentialPool,
    private readonly timeoutMs: number = 30_000,
  ) {}

  supportsModel(model: string): boolean {
    return model.startsWith("claude-");
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const startMs = Date.now();
    const apiKey = this.pool.acquire("anthropic");

    // Anthropic takes `system` separately. Concatenate any system messages.
    let systemText = "";
    const conversational: AnthropicMessage[] = [];

    for (const msg of options.messages) {
      if (msg.role === "system") {
        systemText += (systemText ? "\n" : "") + msg.content;
        continue;
      }

      if (msg.role === "tool") {
        // Tool results travel as `user` turns with a tool_result block.
        const block: AnthropicToolResultBlock = {
          type: "tool_result",
          tool_use_id: msg.tool_call_id ?? "",
          content: msg.content,
        };
        conversational.push({ role: "user", content: [block] });
        continue;
      }

      // user / assistant: plain text content
      conversational.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: conversational,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0,
    };
    if (systemText) body["system"] = systemText;

    if (options.tools && options.tools.length > 0) {
      body["tools"] = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        this.pool.reportFailure("anthropic", apiKey);
      }
      throw new LLMProviderError(
        "anthropic",
        res.status,
        `Anthropic API error ${res.status}: ${text}`,
      );
    }

    const data = (await res.json()) as AnthropicResponse;
    const latency_ms = Date.now() - startMs;

    let content: string | null = null;
    const tool_calls: LLMToolCall[] = [];

    for (const block of data.content ?? []) {
      if (block.type === "text") {
        content = (content ?? "") + block.text;
      } else if (block.type === "tool_use") {
        tool_calls.push({
          id: block.id,
          name: block.name,
          arguments: block.input ?? {},
        });
      }
    }

    this.pool.reportSuccess("anthropic", apiKey);

    return {
      content,
      tool_calls,
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
        total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      model: data.model ?? this.model,
      provider: "anthropic",
      latency_ms,
    };
  }

  completeStream(options: CompleteStreamOptions): AsyncIterable<StreamChunk> {
    const apiKey = this.pool.acquire("anthropic");
    return anthropicCompleteStream(options, {
      apiKey,
      model: this.model,
      pool: this.pool,
      timeoutMs: this.timeoutMs,
    });
  }
}
