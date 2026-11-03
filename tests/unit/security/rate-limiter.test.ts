import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { RateLimiter } from "../../../src/security/rate-limiter.js";

function makeLimiter(): RateLimiter {
  // ioredis-mock exposes a Redis-compatible API; we cast through unknown
  // because its types are not a perfect superset of ioredis's Redis type.
  const redis = new RedisMock() as unknown as Redis;
  return new RateLimiter(redis);
}

describe('RateLimiter (sliding window)', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = makeLimiter();
  });

  it('allows up to limit then blocks the next call', async () => {
    const opts = { key: 'tester:tool', limit: 5, windowMs: 60_000 };
    for (let i = 0; i < 5; i++) {
      const r = await limiter.check(opts);
      expect(r.allowed).toBe(true);
    }
    const denied = await limiter.check(opts);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('keeps separate counters per key', async () => {
    const a = { key: 'acct-1:send-message', limit: 2, windowMs: 60_000 };
    const b = { key: 'acct-2:send-message', limit: 2, windowMs: 60_000 };

    await limiter.check(a);
    await limiter.check(a);
    const aDenied = await limiter.check(a);
    expect(aDenied.allowed).toBe(false);

    const bAllowed = await limiter.check(b);
    expect(bAllowed.allowed).toBe(true);
  });

  it('reports remaining slots correctly while under limit', async () => {
    const opts = { key: 'remaining:test', limit: 3, windowMs: 60_000 };
    const r1 = await limiter.check(opts);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    const r2 = await limiter.check(opts);
    expect(r2.remaining).toBe(1);
  });
});