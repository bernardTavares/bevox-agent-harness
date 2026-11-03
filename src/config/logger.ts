import type { Logger, LoggerOptions } from "pino";
import pino from "pino";

import { buildRedactionConfig } from "../security/redactors.js";

import { getEnv } from "./env.js";

/**
 * Central pino factory. All modules should use `createLogger({ name })` instead
 * of `pino({ name })` so PII redaction is applied uniformly.
 */
export function createLogger(
  opts: { name: string; level?: string } & Omit<LoggerOptions, "name" | "level" | "redact">,
): Logger {
  const env = getEnv();
  const level = opts.level ?? env.HARNESS_LOG_LEVEL;
  const { name, ...rest } = opts;
  return pino({
    name,
    level,
    redact: buildRedactionConfig(level),
    ...rest,
  });
}
