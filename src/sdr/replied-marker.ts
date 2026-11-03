/**
 * SDR replied-marker — C.8 split-idempotency helper.
 *
 * Provides a Redis-backed marker to ensure a prospect reply is sent AT MOST ONCE
 * per (organization, contact, inbound-message) triple, regardless of BullMQ retries.
 *
 * Problem (companion spec §6/§8 principal residual):
 *   In Model C, the reply is sent THEN the workflow advance is awaited.
 *   If the advance fails and a BullMQ retry re-enters _dispatchModelCImpl with a
 *   NEW execution_id, the execution-level dedup key (harness:dedup:{execution_id})
 *   does NOT protect against re-sending the reply. This module provides the
 *   missing split-idempotency marker.
 *
 * Key namespace: harness:sdr:replied:{organizationId}:{contactKey}:{msgHash}
 *   DISTINCT from harness:dedup:{execution_id} — different TTL, different scope.
 *
 * Fail-open vs fail-closed on Redis error in wasReplied:
 *   We choose fail-open (return false on Redis error), which means:
 *   - If Redis is DOWN on the FIRST attempt, we proceed and send the reply (correct).
 *   - If Redis is DOWN on a RETRY, we MAY double-reply (incorrect but rare).
 *   The alternative (fail-closed = return true on Redis error) would mean:
 *   - If Redis is DOWN on the FIRST attempt, we skip the reply (prospect never gets it).
 *   We prefer first-attempt correctness because the prospect MUST receive a reply.
 *   The backstop for the retry double-reply risk is:
 *     (1) The execution-level dedup key (harness:dedup:{execution_id}) catches same-id retries.
 *     (2) Cadence idempotency in the SDR workflow logic.
 *     (3) BullMQ retry windows are typically short (seconds), making Redis downtime coincidence
 *         during a retry unlikely in practice.
 *
 * TTL rationale (REPLIED_MARKER_TTL_SEC = 7 days):
 *   - BullMQ retry windows are measured in seconds to minutes.
 *   - The SDR cadence reply-wait step (touch-1 → reply:inbound) can run for days.
 *   - 7 days is long enough to cover any realistic retry window + cadence step duration
 *     while staying bounded to avoid unbounded Redis growth.
 *   - The execution-dedup TTL is 1 hour (short); this is intentionally longer because
 *     the retry concern spans BullMQ job lifetimes, not just dedup windows.
 */

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Key schema
// ---------------------------------------------------------------------------

/** TTL for the replied marker in seconds (7 days — see module JSDoc). */
export const REPLIED_MARKER_TTL_SEC = 7 * 24 * 60 * 60; // 604800

/**
 * Compute a stable SHA-256 hex digest of the inbound message content.
 * Input is normalized to a UTF-8 buffer before hashing so identical byte
 * sequences always produce identical digests (no locale / collation variance).
 */
function hashInboundMsg(inboundMsg: string): string {
  return createHash("sha256").update(inboundMsg, "utf8").digest("hex");
}

/**
 * Build the Redis key for a given (organizationId, contactKey, inboundMsg) triple.
 *
 * Format: harness:sdr:replied:{organizationId}:{contactKey}:{sha256hex}
 *
 * NAMESPACE NOTE: harness:sdr:replied: is intentionally distinct from
 * harness:dedup:{execution_id}. The dedup key is per-execution; the replied
 * marker is per-(organization, contact, inbound-message) and covers retries that
 * arrive with NEW execution_ids.
 */
function buildKey(organizationId: string, contactKey: string, inboundMsg: string): string {
  const msgHash = hashInboundMsg(inboundMsg);
  return `harness:sdr:replied:${organizationId}:${contactKey}:${msgHash}`;
}

// ---------------------------------------------------------------------------
// Public API — never throws (mirror pattern from sdr-account-state.repository.ts)
// ---------------------------------------------------------------------------

/**
 * Check whether a reply has already been sent for this (organization, contact, message).
 *
 * Returns true  → reply was already sent; caller MUST skip re-sending.
 * Returns false → no marker found OR Redis error (fail-open — see module JSDoc).
 *
 * NEVER throws. On Redis error: returns false (fail-open toward attempting the reply)
 * so the prospect is not silently denied a response on first attempt.
 */
export async function wasReplied(
  redis: Redis,
  organizationId: string,
  contactKey: string,
  inboundMsg: string,
): Promise<boolean> {
  try {
    const key = buildKey(organizationId, contactKey, inboundMsg);
    const val = await redis.get(key);
    return val !== null;
  } catch {
    // Fail-open: return false so the reply proceeds on first attempt.
    // See module JSDoc for the tradeoff analysis.
    return false;
  }
}

/**
 * Mark that the reply has been sent for this (organization, contact, message).
 *
 * Uses SET (NOT SET NX) — idempotent: re-marking after a partial failure is safe
 * and simply refreshes the TTL without changing the semantics.
 *
 * NEVER throws. On Redis error: swallow silently (the reply was already sent;
 * the missing marker means the retry will re-attempt the reply — acceptable given
 * the fail-open strategy documented in the module JSDoc).
 *
 * @param ttlSec - TTL in seconds. Callers should pass REPLIED_MARKER_TTL_SEC unless
 *                 testing with a shorter window. Do NOT pass 0 (no TTL is unsafe
 *                 for an unbounded marker store).
 */
export async function markReplied(
  redis: Redis,
  organizationId: string,
  contactKey: string,
  inboundMsg: string,
  ttlSec: number,
): Promise<void> {
  try {
    const key = buildKey(organizationId, contactKey, inboundMsg);
    // SET key "1" EX ttlSec — NOT NX: idempotent, refreshes TTL on retry
    await redis.set(key, "1", "EX", ttlSec);
  } catch {
    // Swallow silently — never throws (see module JSDoc)
  }
}
