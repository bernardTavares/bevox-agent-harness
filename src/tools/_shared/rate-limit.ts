import { getEnv } from "../../config/env.js";
import { enforceRateLimit, RateLimitError } from "../../security/rate-limiter.js";
import type { ToolResult } from "../types.js";

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

export type RateLimitPolicy = "send-message" | "request-human" | "calendar-mutation";

function policyConfig(policy: RateLimitPolicy): { limit: number; windowMs: number } {
  const env = getEnv();
  switch (policy) {
    case "send-message":
      return { limit: env.RATE_LIMIT_SEND_MESSAGE_PER_MINUTE, windowMs: ONE_MINUTE_MS };
    case "request-human":
      return { limit: env.RATE_LIMIT_REQUEST_HUMAN_PER_HOUR, windowMs: ONE_HOUR_MS };
    case "calendar-mutation":
      return { limit: env.RATE_LIMIT_CALENDAR_MUTATIONS_PER_MINUTE, windowMs: ONE_MINUTE_MS };
  }
}

/**
 * Enforce the rate limit and convert RateLimitError into a structured
 * ToolResult that the reasoning engines already understand.
 */
export async function checkRateLimit(
  organizationId: string,
  toolName: string,
  policy: RateLimitPolicy,
): Promise<ToolResult | null> {
  const { limit, windowMs } = policyConfig(policy);
  try {
    await enforceRateLimit(organizationId, toolName, limit, windowMs);
    return null;
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        success: false,
        error: "RATE_LIMITED",
        errorCode: "RATE_LIMITED",
        detail: `Rate limit exceeded for ${toolName} (limit ${limit} per ${windowMs}ms)`,
      };
    }
    throw err;
  }
}
