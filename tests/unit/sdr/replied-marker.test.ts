/**
 * Unit tests for src/sdr/replied-marker.ts — C.8 split-idempotency replied-marker.
 *
 * Verifies:
 *  1. Key namespace is distinct from harness:dedup: (harness:sdr:replied:)
 *  2. markReplied then wasReplied → true
 *  3. Unseen message → wasReplied false
 *  4. Redis error → wasReplied false (fail-open, never throws)
 *  5. Redis error → markReplied no-throw
 *  6. msgHash is stable for same content, differs for different content
 *
 * NOTE: ioredis-mock instances share an in-memory store singleton by default,
 * so we call flushall() in beforeEach to isolate tests from each other.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createFakeRedis } from "../../fakes/redis.fake.js";
import { wasReplied, markReplied } from "../../../src/sdr/replied-marker.js";

const ACCOUNT_ID = 42;
const CONTACT_KEY = "99001";
const INBOUND_MSG = "Sim, tenho interesse! Pode enviar mais detalhes?";
const INBOUND_MSG_ALT = "Não tenho interesse neste momento.";

// Single shared fake redis instance; reset between tests via flushall.
const redis = createFakeRedis();

beforeEach(async () => {
  await redis.flushall();
});

describe("replied-marker", () => {
  describe("namespace", () => {
    it("key uses harness:sdr:replied: namespace (distinct from harness:dedup:)", async () => {
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 60);

      // The harness:dedup: namespace must NOT have any replied-marker keys
      const dedupKeys = await redis.keys("harness:dedup:*");
      expect(dedupKeys).toHaveLength(0);

      // The harness:sdr:replied: namespace must have the key
      const sdrKeys = await redis.keys("harness:sdr:replied:*");
      expect(sdrKeys).toHaveLength(1);
      expect(sdrKeys[0]).toMatch(/^harness:sdr:replied:/);
    });

    it("key contains accountId, contactKey and a hash segment", async () => {
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 60);

      const keys = await redis.keys("harness:sdr:replied:*");
      expect(keys).toHaveLength(1);
      const key = keys[0]!;
      // Format: harness:sdr:replied:{accountId}:{contactKey}:{hash}
      expect(key).toContain(`harness:sdr:replied:${ACCOUNT_ID}:${CONTACT_KEY}:`);
    });
  });

  describe("markReplied + wasReplied round-trip", () => {
    it("unseen message → wasReplied returns false", async () => {
      const result = await wasReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG);
      expect(result).toBe(false);
    });

    it("after markReplied → wasReplied returns true", async () => {
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 3600);
      const result = await wasReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG);
      expect(result).toBe(true);
    });

    it("marking one message does not affect a different message", async () => {
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 3600);

      const seen = await wasReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG);
      const unseen = await wasReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG_ALT);
      expect(seen).toBe(true);
      expect(unseen).toBe(false);
    });

    it("marking for one contactKey does not affect another contactKey", async () => {
      const otherContact = "99002";
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 3600);

      const seen = await wasReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG);
      const other = await wasReplied(redis, ACCOUNT_ID, otherContact, INBOUND_MSG);
      expect(seen).toBe(true);
      expect(other).toBe(false);
    });

    it("markReplied is idempotent (SET not SET NX) — second mark does not throw", async () => {
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 3600);
      await expect(markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 3600)).resolves.not.toThrow();
      const result = await wasReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG);
      expect(result).toBe(true);
    });
  });

  describe("msgHash stability", () => {
    it("same content → same hash (stable key)", async () => {
      // Mark with the same content twice under different calls.
      // Both calls must produce the same key (only 1 key in Redis).
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 3600);
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 3600);

      const keys = await redis.keys("harness:sdr:replied:*");
      // Same content → same hash → same key → only 1 entry
      expect(keys).toHaveLength(1);
    });

    it("different content → different hash (different keys)", async () => {
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 3600);
      await markReplied(redis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG_ALT, 3600);

      const keys = await redis.keys("harness:sdr:replied:*");
      // Two different messages → two different keys
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    });
  });

  describe("error resilience (fail-open)", () => {
    it("wasReplied returns false on Redis error (fail-open, never throws)", async () => {
      // Build a broken redis-like object that throws on any operation
      const brokenRedis = {
        get: () => Promise.reject(new Error("Redis connection refused")),
        set: () => Promise.reject(new Error("Redis connection refused")),
      } as never;

      await expect(wasReplied(brokenRedis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG)).resolves.toBe(false);
    });

    it("markReplied does not throw on Redis error (never-throws contract)", async () => {
      const brokenRedis = {
        get: () => Promise.reject(new Error("Redis connection refused")),
        set: () => Promise.reject(new Error("Redis connection refused")),
      } as never;

      await expect(markReplied(brokenRedis, ACCOUNT_ID, CONTACT_KEY, INBOUND_MSG, 3600)).resolves.not.toThrow();
    });
  });
});
