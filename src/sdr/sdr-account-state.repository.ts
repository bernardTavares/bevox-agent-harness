import type { Pool } from "pg";
import type { SdrAccountStateSnapshot } from "./compose.js";

/**
 * Read-only repository for `sdr_account_state` (migration 008).
 *
 * Organization-scoped parameterized SELECT only — never writes, never throws.
 * Returns null on absent row or any DB error (guarded read pattern, mirrors
 * the enrich-3c repository in B.5).
 *
 * Architectural note: This is intentionally a standalone function (not a
 * class) because B.8 needs only a single read path. No write surface is
 * exposed here — updates belong to a future Fase C write path.
 */
export async function getSdrAccountState(
  db: Pool,
  organizationId: string,
  contactId: bigint,
): Promise<SdrAccountStateSnapshot | null> {
  try {
    const result = await db.query<{
      status: string;
      last_touch_at: string | null;
    }>(
      `SELECT status, last_touch_at
         FROM sdr_account_state
        WHERE organization_id = $1 AND contact_id = $2
        LIMIT 1`,
      [organizationId, contactId],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      status: row.status as SdrAccountStateSnapshot["status"],
      lastTouchAt: row.last_touch_at ? new Date(row.last_touch_at) : null,
    };
  } catch {
    // Never throw — absent/error → null (zero-cost gate preserved)
    return null;
  }
}
