/**
 * LLM Error Classifier — stable contract.
 *
 * This module is the canonical source of truth for LLM error categorization
 * across the harness. Phase 5 (retry logic) consumes the public exports
 * `LLMErrorCategory`, `classifyLLMError`, and `isRetryable` to decide retry
 * behavior, circuit-breaker policy, and fallback routing.
 *
 * Public API (stable — do not rename or remove without major-bump):
 *   - LLMErrorCategory     — union of 6 known categories + `unknown`
 *   - classifyLLMError(e)  — best-effort classifier from arbitrary thrown value
 *   - isRetryable(c)       — pure predicate over the category
 *
 * Categories (6 known + 1 sentinel):
 *   - rate_limit       → HTTP 429, "rate limit", "too many requests"
 *   - context_overflow → "context length", "token limit", "maximum context"
 *   - invalid_response → "invalid json", "parse", "malformed"
 *   - network          → ECONNREFUSED, ENOTFOUND, ETIMEDOUT, "fetch failed"
 *   - auth             → HTTP 401/403, "unauthorized", "api key"
 *   - server_error     → HTTP 5xx
 *   - unknown          → catch-all sentinel; not retryable by default
 */

export type LLMErrorCategory =
  | "rate_limit"
  | "context_overflow"
  | "invalid_response"
  | "network"
  | "auth"
  | "server_error"
  | "unknown";

/**
 * The set of categories for which retries are recommended.
 * Phase 5 retry middleware consumes this via `isRetryable()`.
 */
const RETRYABLE_CATEGORIES: ReadonlySet<LLMErrorCategory> = new Set([
  "rate_limit",
  "network",
  "server_error",
]);

interface ErrorShape {
  statusCode?: number;
  status?: number;
  message?: string;
  code?: string;
}

/**
 * Classify a thrown LLM error into one of the known categories.
 *
 * Preference order for HTTP status:
 *   1. `err.statusCode` (set by our typed `LLMProviderError`)
 *   2. `err.status` (set by some SDKs)
 *
 * Pattern matching on `err.message` is case-insensitive.
 * Never throws; returns `"unknown"` for any unrecognized shape.
 */
export function classifyLLMError(err: unknown): LLMErrorCategory {
  const e = (err ?? {}) as ErrorShape;
  const message = (e.message ?? "").toLowerCase();
  const status = e.statusCode ?? e.status;
  const code = (e.code ?? "").toUpperCase();

  // Auth — check before generic 4xx
  if (status === 401 || status === 403 || /unauthorized|api.?key|forbidden/.test(message)) {
    return "auth";
  }

  // Rate limit
  if (status === 429 || /rate.?limit|too many requests|quota/.test(message)) {
    return "rate_limit";
  }

  // Context overflow
  if (
    /context.?(length|window)|token.?limit|maximum context|context_length_exceeded/.test(message)
  ) {
    return "context_overflow";
  }

  // Invalid response (parsing / shape)
  if (/invalid.?json|parse|malformed|unexpected token/.test(message)) {
    return "invalid_response";
  }

  // Network — check code AND message
  if (
    /econnrefused|enotfound|etimedout|econnreset|network|fetch failed|socket hang up/.test(
      message,
    ) ||
    ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"].includes(code)
  ) {
    return "network";
  }

  // Generic server error
  if (typeof status === "number" && status >= 500 && status < 600) {
    return "server_error";
  }

  return "unknown";
}

/**
 * Pure predicate: should the caller retry an operation that produced an
 * error of the given category?
 *
 * Retryable: rate_limit, network, server_error.
 * Not retryable: auth, context_overflow, invalid_response, unknown.
 *
 * Phase 5 must treat this as the single source of truth — do NOT inline
 * an equivalent table elsewhere.
 */
export function isRetryable(category: LLMErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}
