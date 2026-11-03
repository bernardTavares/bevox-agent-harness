/**
 * Anthropic Messages streaming.
 *
 * Wire events of interest:
 *  - `message_start`              → ignored (we emit tokens lazily)
 *  - `content_block_start`        → if block.type === 'tool_use' emit tool_call_start
 *  - `content_block_delta`        → 'text_delta' → token ; 'input_json_delta' → tool_call_delta
 *  - `content_block_stop`         → ignored
 *  - `message_delta`              → ignored (carries stop_reason)
 *  - `message_stop`               → emit `done`
 */
import { LLMProviderError } from "../../llm-gateway.js";
import type { CredentialPool } from "../credential-pool.js";

import { parseSSE } from "./sse-parser.js";
import type { CompleteStreamOptions, StreamChunk } from "./types.js";

interface AnthropicStreamDeps {
  apiKey: string;
  model: string;
  pool: CredentialPool;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export function buildAnthropicStreamBody(
  opts: CompleteStreamOptions,
  model: string,
): Record<string, unknown> {
  let systemText = "";
  const conversational: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const msg of opts.messages) {
    if (msg.role === "system") {
      systemText += (systemText ? "\n" : "") + msg.content;
      continue;
    }
    if (msg.role === "tool") {
      conversational.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: msg.tool_call_id ?? "", content: msg.content },
        ],
      });
      continue;
    }
    conversational.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    });
  }
  const body: Record<string, unknown> = {
    model,
    messages: conversational,
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 0,
    stream: true,
  };
  if (systemText) body.system = systemText;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  return body;
}

export async function* anthropicCompleteStream(
  opts: CompleteStreamOptions,
  deps: AnthropicStreamDeps,
): AsyncIterable<StreamChunk> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = deps.endpoint ?? "https://api.anthropic.com/v1/messages";
  let seq = 0;
  const started = Date.now();
  // index → { id, name } for tool_use blocks
  const toolBlocks = new Map<number, { id: string; name: string }>();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("Anthropic stream timeout")), deps.timeoutMs);
  const onExternalAbort = (): void => ac.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": deps.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(buildAnthropicStreamBody(opts, deps.model)),
      signal: ac.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        deps.pool.reportFailure("anthropic", deps.apiKey);
      }
      throw new LLMProviderError(
        "anthropic",
        response.status,
        `Anthropic stream HTTP ${response.status}: ${text}`,
      );
    }

    for await (const evt of parseSSE(response)) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(evt.data);
      } catch {
        continue;
      }
      const type = evt.event ?? (json["type"] as string | undefined) ?? "";

      if (type === "content_block_start") {
        const idx = json["index"] as number | undefined;
        const block = json["content_block"] as
          | { type?: string; id?: string; name?: string }
          | undefined;
        if (block?.type === "tool_use" && typeof idx === "number" && block.id && block.name) {
          toolBlocks.set(idx, { id: block.id, name: block.name });
          yield {
            type: "tool_call_start",
            seq: seq++,
            timestamp: Date.now(),
            payload: { toolCallId: block.id, name: block.name },
          };
        }
      } else if (type === "content_block_delta") {
        const idx = json["index"] as number | undefined;
        const delta = json["delta"] as
          | { type?: string; text?: string; partial_json?: string }
          | undefined;
        if (!delta) continue;
        if (delta.type === "text_delta" && delta.text) {
          yield {
            type: "token",
            seq: seq++,
            timestamp: Date.now(),
            payload: { delta: delta.text },
          };
        } else if (
          delta.type === "input_json_delta" &&
          typeof idx === "number" &&
          delta.partial_json !== undefined
        ) {
          const tb = toolBlocks.get(idx);
          if (tb) {
            yield {
              type: "tool_call_delta",
              seq: seq++,
              timestamp: Date.now(),
              payload: { toolCallId: tb.id, argsDelta: delta.partial_json },
            };
          }
        }
      } else if (type === "message_stop") {
        break;
      }
    }
    deps.pool.reportSuccess("anthropic", deps.apiKey);
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
