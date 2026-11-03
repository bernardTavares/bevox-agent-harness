/**
 * Cassette sanitizer — defense-in-depth scrubbing before disk write.
 *
 * IMPORTANT context: provider API keys (OPENAI_API_KEY, etc.) live in
 * `Authorization: Bearer …` HTTP headers handled by the adapters. They are
 * NEVER exposed in `LLMResponse`. This sanitizer therefore protects against:
 *
 *   1. PII / secrets that appear inside model-generated `content` strings
 *      (e.g. the user asked the model to repeat a key, or the model
 *      hallucinated one in a code sample).
 *   2. Secrets passed by the model as tool-call arguments.
 *   3. Future leakage from a misbehaving adapter that copies headers into
 *      a response field.
 *
 * Patterns are intentionally conservative — false positives are preferable to
 * leaks. Toggle/extend via PR review; do NOT bypass for any reason.
 */
// Order matters: more specific prefixes (sk-ant-) must run BEFORE the generic
// sk- pattern, otherwise the broader one redacts first and the more specific
// label never matches.
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Anthropic-style keys
  [/sk-ant-[A-Za-z0-9_\-]{20,}/g, "sk-ant-REDACTED"],
  // OpenAI-style keys: sk-… or sk-proj-…
  [/sk-(?:proj-)?[a-zA-Z0-9_\-]{20,}/g, "sk-REDACTED"],
  // HTTP Authorization header value
  [/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer REDACTED"],
  // Google AI Studio / Gemini keys
  [/AIza[0-9A-Za-z\-_]{35}/g, "AIza-REDACTED"],
  // JWT: header.payload.signature where header & payload start with eyJ
  [/eyJ[A-Za-z0-9._\-]+\.eyJ[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]*/g, "JWT-REDACTED"],
];

export function sanitizeString(s: string): string {
  let out = s;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Deep-clone-and-scrub. Walks every string value in the object tree and
 * applies `sanitizeString`. Non-string leaves are preserved as-is.
 */
export function sanitizeEntry<T>(entry: T): T {
  return JSON.parse(
    JSON.stringify(entry, (_key, value) =>
      typeof value === "string" ? sanitizeString(value) : value,
    ),
  ) as T;
}
