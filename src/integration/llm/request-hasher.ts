/**
 * Deterministic request canonicalization + SHA-256 hashing.
 *
 * Used by the LLM recorder/replayer to key cassette entries by the *logical*
 * shape of a request (model + messages + tools + responseSchema + temperature
 * + maxTokens). Canonicalization rules:
 *
 * - Object keys are serialized in sorted (lexicographic) order.
 * - `undefined` fields are treated as absent (dropped before serialization).
 * - Arrays preserve order (semantically meaningful for `messages`).
 * - All other JSON-safe values (number/string/boolean/null) pass through
 *   `JSON.stringify` unchanged.
 *
 * NOTE: A semantic miss (e.g. swapping two tools in `tools[]`) produces a
 * different hash by design — order in `messages` and `tools` is intentional
 * for both providers we support.
 */
import { createHash } from "node:crypto";

import type { LLMRequestOptions } from "../llm-gateway.js";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function canonicalizeRequest(options: LLMRequestOptions, model: string): string {
  return stableStringify({
    model,
    messages: options.messages,
    tools: options.tools ?? [],
    response_schema: options.responseSchema ?? null,
    temperature: options.temperature ?? null,
    max_tokens: options.maxTokens ?? null,
  });
}

export function hashRequest(options: LLMRequestOptions, model: string): string {
  return createHash("sha256").update(canonicalizeRequest(options, model)).digest("hex");
}
