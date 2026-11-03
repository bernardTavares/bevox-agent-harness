import { describe, it, expect } from 'vitest';
import { withRetry } from "../../../../src/integration/llm/retry-decorator.js";

describe('withRetry', () => {
  it('retries on network error and eventually succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          const err = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
          throw err;
        }
        return 'ok';
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry on auth errors (401)', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error('unauthorized'), { status: 401 });
        },
        { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 }
      )
    ).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });

  it('does not retry on validation errors (400)', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error('bad request'), { status: 400 });
        },
        { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 }
      )
    ).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });

  it('retries on 429 rate limit', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 2) throw Object.assign(new Error('rate'), { status: 429 });
        return 'ok';
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('exhausts attempts and rethrows last error', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error('boom'), { status: 503 });
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
      )
    ).rejects.toBeDefined();
    expect(attempts).toBe(3);
  });
});