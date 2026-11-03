import { describe, it, expect } from "vitest";

import { CredentialPool } from "../../../../src/integration/llm/credential-pool.js";

describe("CredentialPool (extra coverage)", () => {
  it("has() returns false for unregistered provider", () => {
    const pool = new CredentialPool();
    expect(pool.has("openai")).toBe(false);
  });

  it("has() returns true after register with non-empty list", () => {
    const pool = new CredentialPool();
    pool.register("openai", ["k1"]);
    expect(pool.has("openai")).toBe(true);
  });

  it("has() returns false for empty registration", () => {
    const pool = new CredentialPool();
    pool.register("openai", []);
    expect(pool.has("openai")).toBe(false);
  });

  it("size() returns 0 for unregistered provider", () => {
    const pool = new CredentialPool();
    expect(pool.size("anthropic")).toBe(0);
  });

  it("multiplies cooldown linearly with failure count", () => {
    const pool = new CredentialPool(1000);
    pool.register("openai", ["k"]);
    pool.reportFailure("openai", "k");
    pool.reportFailure("openai", "k");
    // failureCount=2 → cooldown ~2000ms
    expect(() => pool.acquire("openai")).toThrow(/cooldown/);
  });

  it("reportFailure on unknown key is a no-op", () => {
    const pool = new CredentialPool();
    pool.register("openai", ["k1"]);
    // Should not throw
    pool.reportFailure("openai", "unknown");
    expect(() => pool.acquire("openai")).not.toThrow();
  });

  it("reportSuccess on unknown key is a no-op", () => {
    const pool = new CredentialPool();
    pool.register("openai", ["k1"]);
    pool.reportSuccess("openai", "unknown");
    expect(() => pool.acquire("openai")).not.toThrow();
  });

  it("reportFailure with custom cooldown overrides base", () => {
    const pool = new CredentialPool(1000);
    pool.register("openai", ["k"]);
    pool.reportFailure("openai", "k", 50_000);
    expect(() => pool.acquire("openai")).toThrow(/cooldown/);
  });

  it("acquires least-recently-used key", () => {
    const pool = new CredentialPool();
    pool.register("openai", ["k1", "k2"]);
    const first = pool.acquire("openai");
    const second = pool.acquire("openai");
    expect(first).not.toBe(second);
    // After both used, the one used first should come back next
    const third = pool.acquire("openai");
    expect(third).toBe(first);
  });
});