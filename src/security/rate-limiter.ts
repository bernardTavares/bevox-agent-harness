import type { Redis } from "ioredis";

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

export class RateLimitError extends Error {
  public readonly toolName: string;
  public readonly resetInMs: number;

  constructor(toolName: string, resetInMs: number) {
    super(`Rate limit exceeded for ${toolName}`);
    this.name = "RateLimitError";
    this.toolName = toolName;
    this.resetInMs = resetInMs;
  }
}

/**
 * Sliding-window rate limiter backed by a Redis ZSET.
 *
 * Algorithm:
 *  - Drop entries older than `now - windowMs` (sliding window).
 *  - Count the remaining entries.
 *  - If count < limit, allow and add this event; otherwise deny.
 *  - Add the event regardless to prevent immediate bursts on the next window
 *    edge (we still record the rejected attempt). PEXPIRE keeps the key
 *    bounded.
 */
export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  async check(opts: RateLimitOptions): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - opts.windowMs;
    const redisKey = `rate:${opts.key}`;
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

    // Use destructuring with explicit names (INDEX correction) so subsequent
    // result-index drift never silently corrupts the count.
    const pipeline = this.redis.multi();
    pipeline.zremrangebyscore(redisKey, 0, windowStart);
    pipeline.zcard(redisKey);
    pipeline.zadd(redisKey, now, member);
    pipeline.pexpire(redisKey, opts.windowMs);
    const execResult = await pipeline.exec();
    if (!execResult) {
      throw new Error("rate-limiter: redis pipeline discarded");
    }
    const [, zcardResult] = execResult;
    if (!zcardResult) {
      throw new Error("rate-limiter: pipeline missing zcard result");
    }
    const [zcardErr, zcardValue] = zcardResult as [Error | null, number];
    if (zcardErr) throw zcardErr;
    const count = typeof zcardValue === "number" ? zcardValue : 0;

    const allowed = count < opts.limit;
    return {
      allowed,
      remaining: Math.max(0, opts.limit - count - 1),
      resetIn: opts.windowMs,
    };
  }
}

// -----------------------------------------------------------------------------
// Singleton wiring (mirrors PermissionAuditLogger pattern).
// -----------------------------------------------------------------------------

let _instance: RateLimiter | null = null;

export function setRateLimiter(limiter: RateLimiter | null): void {
  _instance = limiter;
}

export function getRateLimiter(): RateLimiter | null {
  return _instance;
}

/**
 * Enforces a rate limit at the tool execution boundary. Throws RateLimitError
 * if the limit is exceeded. No-ops when no limiter is wired (tests / unit
 * runs without Redis).
 */
export async function enforceRateLimit(
  organizationId: string,
  toolName: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const limiter = _instance;
  if (!limiter) return;
  const result = await limiter.check({
    key: `${organizationId}:${toolName}`,
    limit,
    windowMs,
  });
  if (!result.allowed) {
    throw new RateLimitError(toolName, result.resetIn);
  }
}
