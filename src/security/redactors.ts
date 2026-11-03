/**
 * Pino redaction config for PII / secrets.
 *
 * CRITICAL: We deliberately DO NOT redact `messages.*.content` globally.
 * Redacting message content breaks debug visibility of the reasoning engines.
 * Conversation content is redacted only at external egress (callback payload,
 * exported traces) via `callback.payload.messages.*.content`.
 *
 * In DEBUG / TRACE log levels we keep the PII visible for local troubleshooting
 * and redact only tokens / credentials. Production INFO+ runs with the full list.
 */

// Tokens and credentials — always redacted, even in DEBUG.
export const REDACTION_ALWAYS_PATHS: readonly string[] = [
  "execution_token",
  "executionToken",
  "*.execution_token",
  "*.executionToken",
  "*.token",
  "token",
  'req.headers["x-execution-token"]',
  "res.headers.authorization",
  "*.api_key",
  "*.apiKey",
  "api_key",
  "apiKey",
  "*.password",
  "*.secret",
  "*.OPENAI_API_KEY",
  "*.ANTHROPIC_API_KEY",
  "*.GEMINI_API_KEY",
] as const;

// Full PII path list — used in INFO+.
export const PII_REDACTION_PATHS: readonly string[] = [
  ...REDACTION_ALWAYS_PATHS,

  // ContactProfile fields (snake_case DB + camelCase TS)
  "*.full_name",
  "*.fullName",
  "*.preferred_name",
  "*.preferredName",
  "*.document_number",
  "*.documentNumber",
  "*.phone",
  "*.email",
  "*.address",
  "*.birth_date",
  "*.birthDate",

  // Legacy / callback aliases (defensive)
  "*.customer_name",
  "*.customer_phone",
  "*.customer_email",

  // External egress only — conversation content in outbound callbacks/traces.
  // We intentionally scope to "callback.payload" so internal pipeline logs
  // (which key under "messages") remain visible for debugging.
  "callback.payload.messages.*.content",
  "callback.payload.response",
] as const;

export interface RedactionConfig {
  paths: string[];
  censor: string;
  remove: boolean;
}

export function buildRedactionConfig(logLevel: string): RedactionConfig {
  const isDebug = logLevel === "debug" || logLevel === "trace";
  return {
    paths: [...(isDebug ? REDACTION_ALWAYS_PATHS : PII_REDACTION_PATHS)],
    censor: "[REDACTED]",
    remove: false,
  };
}
