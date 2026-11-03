import { describe, it, expect } from 'vitest';
import { CredentialPool } from "../../../../src/integration/llm/credential-pool.js";

describe('CredentialPool', () => {
  it('rotates round-robin via least-recently-used selection', () => {
    const pool = new CredentialPool(1_000);
    pool.register('openai', ['k1', 'k2', 'k3']);
    const first = pool.acquire('openai');
    const second = pool.acquire('openai');
    const third = pool.acquire('openai');
    expect(new Set([first, second, third])).toEqual(new Set(['k1', 'k2', 'k3']));
  });

  it('puts a failing key in cooldown', () => {
    const pool = new CredentialPool(10_000);
    pool.register('openai', ['k1', 'k2']);
    const k = pool.acquire('openai');
    pool.reportFailure('openai', k);
    // Next acquire should pick the OTHER key
    const next = pool.acquire('openai');
    expect(next).not.toBe(k);
  });

  it('throws when all credentials are cooling down', () => {
    const pool = new CredentialPool(60_000);
    pool.register('openai', ['k1']);
    const k = pool.acquire('openai');
    pool.reportFailure('openai', k);
    expect(() => pool.acquire('openai')).toThrow(/cooldown/);
  });

  it('reportSuccess clears failure state', () => {
    const pool = new CredentialPool(60_000);
    pool.register('openai', ['k1']);
    pool.reportFailure('openai', 'k1');
    pool.reportSuccess('openai', 'k1');
    expect(() => pool.acquire('openai')).not.toThrow();
  });

  it('throws when no keys are registered for provider', () => {
    const pool = new CredentialPool();
    pool.register('openai', []);
    expect(() => pool.acquire('openai')).toThrow(/no credentials/);
  });

  it('deduplicates keys on register', () => {
    const pool = new CredentialPool();
    pool.register('openai', ['k1', 'k1', 'k2']);
    expect(pool.size('openai')).toBe(2);
  });
});