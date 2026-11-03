/**
 * Generic exponential-backoff-with-full-jitter retry helper.
 *
 * IMPORTANT: this DOES NOT classify errors (workflow errors are a different
 * domain from LLM transport errors — see `integration/llm/retry-decorator.ts`
 * for the LLM-specific classifier). It just runs `fn` up to `maxAttempts`
 * times, sleeping between failures. Callers decide retryability by either
 * not throwing or by throwing terminal errors.
 *
 * To opt out of retry for a specific error, set `error.nonRetryable = true`
 * or throw a `NonRetryableError`.
 */

export interface BackoffOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /**
   * Optional predicate. Defaults to retrying every error that isn't marked
   * non-retryable.
   */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

export class NonRetryableError extends Error {
  readonly nonRetryable = true;
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

function isMarkedNonRetryable(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as { nonRetryable?: boolean }).nonRetryable,
  );
}

export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions): Promise<T> {
  const max = opts.maxAttempts;
  const base = opts.baseDelayMs;
  const cap = opts.maxDelayMs ?? base * 32;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isMarkedNonRetryable(err)) throw err;
      const allow = opts.shouldRetry ? opts.shouldRetry(err, attempt) : true;
      if (!allow || attempt === max) throw err;

      // Exponential with full jitter, clamped at cap.
      const exp = base * 2 ** (attempt - 1);
      const jittered = exp * (0.5 + Math.random());
      const delay = Math.min(jittered, cap);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable.
  throw lastErr;
}
