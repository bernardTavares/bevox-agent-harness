/**
 * Gemini `streamGenerateContent` with `?alt=sse`.
 *
 * Each SSE `data:` payload is a JSON object with the same shape as the
 * non-streaming response, but `candidates[].content.parts` carries the
 * incremental delta (text or functionCall).
 *
 * Note: function calls in Gemini stream often arrive as a SINGLE event with
 * fully-formed `functionCall.args`. We still emit `tool_call_start` +
 * `tool_call_delta` (stringified JSON) so the publisher's accumulation logic
 * is uniform across providers.
 */
import { LLMProviderError } from "../../llm-gateway.js";
import type { CredentialPool } from "../credential-pool.js";

import { parseSSE } from "./sse-parser.js";
import type { CompleteStreamOptions, StreamChunk } from "./types.js";

interface GeminiStreamDeps {
  apiKey: string;
  model: string;
  pool: CredentialPool;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  endpointBase?: string;
}

export function buildGeminiStreamBody(opts: CompleteStreamOptions): Record<string, unknown> {
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  let pendingSystemText = "";
  for (const msg of opts.messages) {
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
      const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";
      contents.push({ role, parts: [{ text: msg.content }] });
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
      maxOutputTokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0,
    },
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }
  return body;
}

export async function* geminiCompleteStream(
  opts: CompleteStreamOptions,
  deps: GeminiStreamDeps,
): AsyncIterable<StreamChunk> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.endpointBase ?? "https://generativelanguage.googleapis.com/v1beta/models";
  const url = `${base}/${deps.model}:streamGenerateContent?alt=sse&key=${deps.apiKey}`;
  let seq = 0;
  const started = Date.now();
  let toolCallCounter = 0;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("Gemini stream timeout")), deps.timeoutMs);
  const onExternalAbort = (): void => ac.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildGeminiStreamBody(opts)),
      signal: ac.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        deps.pool.reportFailure("gemini", deps.apiKey);
      }
      throw new LLMProviderError(
        "gemini",
        response.status,
        `Gemini stream HTTP ${response.status}: ${text}`,
      );
    }
    for await (const evt of parseSSE(response)) {
      let json: {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              functionCall?: { name?: string; args?: Record<string, unknown> };
            }>;
          };
        }>;
      };
      try {
        json = JSON.parse(evt.data);
      } catch {
        continue;
      }
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.text) {
          yield {
            type: "token",
            seq: seq++,
            timestamp: Date.now(),
            payload: { delta: part.text },
          };
        } else if (part.functionCall?.name) {
          const id = `gemini-${started}-${toolCallCounter++}`;
          yield {
            type: "tool_call_start",
            seq: seq++,
            timestamp: Date.now(),
            payload: { toolCallId: id, name: part.functionCall.name },
          };
          yield {
            type: "tool_call_delta",
            seq: seq++,
            timestamp: Date.now(),
            payload: {
              toolCallId: id,
              argsDelta: JSON.stringify(part.functionCall.args ?? {}),
            },
          };
        }
      }
    }
    deps.pool.reportSuccess("gemini", deps.apiKey);
    yield {
      type: "done",
      seq: seq++,
      timestamp: Date.now(),
      payload: { totalDurationMs: Date.now() - started },
    };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
  }
}
