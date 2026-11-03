import {
  LLMProviderError,
  type LLMRequestOptions,
  type LLMResponse,
  type LLMToolCall,
} from "../../llm-gateway.js";
import type { CredentialPool } from "../credential-pool.js";
import type { LLMAdapter } from "../internal.js";
import { geminiCompleteStream } from "../streaming/gemini-stream.js";
import type { CompleteStreamOptions, StreamChunk } from "../streaming/types.js";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
      }>;
    };
    finishReason: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GeminiAdapter implements LLMAdapter {
  readonly provider = "gemini" as const;

  constructor(
    public readonly model: string,
    private readonly pool: CredentialPool,
    private readonly timeoutMs: number = 30_000,
  ) {}

  supportsModel(model: string): boolean {
    return model.startsWith("gemini-");
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const startMs = Date.now();
    const apiKey = this.pool.acquire("gemini");

    // Gemini doesn't always have a native `system` role — inject system text
    // as a leading user turn wrapped in [SYSTEM] markers, paired with a model
    // ack so the conversation stays valid.
    const contents: GeminiContent[] = [];
    let pendingSystemText = "";

    for (const msg of options.messages) {
      if (msg.role === "system") {
        pendingSystemText += (pendingSystemText ? "\n" : "") + msg.content;
      } else {
        if (pendingSystemText) {
          contents.push({
            role: "user",
            parts: [{ text: `[SYSTEM]\n${pendingSystemText}\n[/SYSTEM]` }],
          });
          contents.push({ role: "model", parts: [{ text: "Understood." }] });
          pendingSystemText = "";
        }
        const geminiRole: "user" | "model" = msg.role === "assistant" ? "model" : "user";
        contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
      }
    }

    if (pendingSystemText) {
      contents.push({
        role: "user",
        parts: [{ text: `[SYSTEM]\n${pendingSystemText}\n[/SYSTEM]` }],
      });
      contents.push({ role: "model", parts: [{ text: "Understood." }] });
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0,
        ...(options.responseSchema
          ? {
              responseMimeType: "application/json",
              responseSchema: options.responseSchema,
            }
          : {}),
      },
    };

    if (options.tools && options.tools.length > 0) {
      const functionDeclarations: GeminiFunctionDeclaration[] = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      body["tools"] = [{ functionDeclarations }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        this.pool.reportFailure("gemini", apiKey);
      }
      throw new LLMProviderError("gemini", res.status, `Gemini API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const latency_ms = Date.now() - startMs;

    let content: string | null = null;
    const tool_calls: LLMToolCall[] = [];

    for (const part of candidate?.content?.parts ?? []) {
      if (part.text !== undefined) {
        content = (content ?? "") + part.text;
      } else if (part.functionCall) {
        tool_calls.push({
          id: `gemini-${Date.now()}-${tool_calls.length}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    this.pool.reportSuccess("gemini", apiKey);

    return {
      content,
      tool_calls,
      usage: {
        input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
      },
      model: this.model,
      provider: "gemini",
      latency_ms,
    };
  }

  completeStream(options: CompleteStreamOptions): AsyncIterable<StreamChunk> {
    const apiKey = this.pool.acquire("gemini");
    return geminiCompleteStream(options, {
      apiKey,
      model: this.model,
      pool: this.pool,
      timeoutMs: this.timeoutMs,
    });
  }
}
