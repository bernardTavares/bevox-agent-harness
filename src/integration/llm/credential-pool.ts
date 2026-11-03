import { createRequire } from "node:module";

import type { Provider } from "./internal.js";

const requireCjs = createRequire(import.meta.url);

interface CredentialEntry {
  key: string;
  failureCount: number;
  cooldownUntil: number;
  lastUsed: number;
}

/**
 * Per-provider credential pool with cooldown-on-failure rotation.
 *
 * `acquire()` picks the least-recently-used credential whose cooldown has
 * elapsed. Repeated failures multiply cooldown linearly (failureCount *
 * baseCooldownMs). A successful call resets the failure counter.
 */
export class CredentialPool {
  private readonly pools = new Map<Provider, CredentialEntry[]>();

  constructor(private readonly baseCooldownMs: number = 30_000) {}

  register(provider: Provider, keys: string[]): void {
    const deduped = Array.from(new Set(keys.filter(Boolean)));
    this.pools.set(
      provider,
      deduped.map((key) => ({ key, failureCount: 0, cooldownUntil: 0, lastUsed: 0 })),
    );
  }

  has(provider: Provider): boolean {
    const p = this.pools.get(provider);
    return !!p && p.length > 0;
  }

  size(provider: Provider): number {
    return this.pools.get(provider)?.length ?? 0;
  }

  acquire(provider: Provider): string {
    const pool = this.pools.get(provider);
    if (!pool || pool.length === 0) {
      throw new Error(`CredentialPool: no credentials registered for "${provider}"`);
    }
    const now = Date.now();
    const available = pool.filter((c) => c.cooldownUntil <= now);
    if (available.length === 0) {
      throw new Error(`CredentialPool: all credentials for "${provider}" are in cooldown`);
    }
    let chosen = available[0];
    for (const c of available) {
      if (c.lastUsed < chosen.lastUsed) chosen = c;
    }
    chosen.lastUsed = now;
    return chosen.key;
  }

  reportFailure(provider: Provider, key: string, cooldownMs?: number): void {
    const entry = this.pools.get(provider)?.find((c) => c.key === key);
    if (!entry) return;
    entry.failureCount += 1;
    const base = cooldownMs ?? this.baseCooldownMs;
    entry.cooldownUntil = Date.now() + base * entry.failureCount;
  }

  reportSuccess(provider: Provider, key: string): void {
    const entry = this.pools.get(provider)?.find((c) => c.key === key);
    if (!entry) return;
    entry.failureCount = 0;
    entry.cooldownUntil = 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton (built from env on first use)
// ---------------------------------------------------------------------------

let singleton: CredentialPool | null = null;

/**
 * Resolve keys for a provider with backward-compatible fallback:
 * - Plural `<PROVIDER>_API_KEYS` (comma-separated) wins when set
 * - Otherwise fall back to singular `<PROVIDER>_API_KEY`
 */
function resolveKeys(plural: string | undefined, singular: string | undefined): string[] {
  if (plural && plural.trim().length > 0) {
    return plural
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (singular && singular.trim().length > 0) return [singular.trim()];
  return [];
}

export function getCredentialPool(): CredentialPool {
  if (singleton) return singleton;
  // Lazy import to avoid cycle with getEnv during module init.

  const { getEnv } = requireCjs("../../config/env.js") as typeof import("../../config/env.js");
  const env = getEnv();
  const pool = new CredentialPool(env.LLM_CREDENTIAL_COOLDOWN_MS);
  pool.register("openai", resolveKeys(env.OPENAI_API_KEYS, env.OPENAI_API_KEY));
  pool.register("gemini", resolveKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY));
  pool.register("anthropic", resolveKeys(env.ANTHROPIC_API_KEYS, env.ANTHROPIC_API_KEY));
  singleton = pool;
  return pool;
}

/** Test helper — drops the cached singleton so the next call rebuilds from env. */
export function resetCredentialPoolForTests(): void {
  singleton = null;
}
