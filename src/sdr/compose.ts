import { SDR_DOCTRINE } from "./doctrine.js";
import type { SdrProfile } from "../runtime/sdr-profile.schema.js";

/**
 * Minimal sales-state snapshot used by L3 compose seam.
 * Columns from migration 008_sdr_account_state.sql — only the fields
 * that the L3 block exposes in the prompt (spec §5.3: IDs/status/last-touch,
 * not narrative).
 */
export interface SdrAccountStateSnapshot {
  status: "cold" | "working" | "nurture" | "disqualified";
  lastTouchAt: Date | null;
}

/**
 * Compact FSM projection for Model-C (C.7 — CF5).
 *
 * Appended AFTER the SDR_DOCTRINE in the SAME composed string — NOT a
 * separate system message. This keeps the system-message COUNT at 2
 * (doctrine + engine own prompt) while providing cadence context.
 *
 * Fields:
 *  - accountStatus: current Account-Status FSM state
 *  - cadenceStep:   step id of the current suspend point (e.g. "touch-1")
 *  - allowedTransitions: human-readable list of deterministic next transitions
 */
export interface SdrFsmProjection {
  accountStatus: string;
  cadenceStep: string;
  allowedTransitions: string[];
}

/**
 * SDR sub-mode — produced by the MessageAnalyzer (B.6) and consumed by
 * the L3 sales-state compose seam (B.8) to select the heading/slice.
 * spec §2.3.
 */
export type SdrSubMode = "reativacao" | "qualificacao" | "nurture" | "handoff-iminente";

/**
 * Compose the final system prompt from base + optional SDR doctrine (L0)
 * + optional sales-state block (L3) + optional FSM projection block (CF5).
 *
 * - 2-arg form: zero-cost gate preserved — byte-identical to Fase A behaviour.
 * - 4-arg form: when `profile.enabled` AND `salesState` is non-null, appends
 *   a SMALL (< 400 chars) L3 block AFTER the doctrine. Sub-mode selects the
 *   heading/slice per spec §2.3.
 * - 5-arg form (C.7): when `fsmProjection` is non-null, appends a compact FSM
 *   STATE block AFTER the L3 block (or after doctrine when no L3 state). The
 *   FSM block contains account-status + cadence step + allowed next transitions.
 *   CRITICAL: appended to the SAME string — NOT a separate system message.
 *   System-message count stays 2 (doctrine + engine own prompt).
 * - Gate off (profile absent or disabled) → returns `base` unchanged,
 *   regardless of salesState / subMode / fsmProjection — zero-cost path preserved.
 *
 * The existing call at execution-handler.ts:~479 uses the 2-arg form and
 * is NOT changed by this extension.
 */
export function composeSystemPrompt(
  base: string,
  profile: SdrProfile | undefined,
  salesState?: SdrAccountStateSnapshot | null,
  subMode?: SdrSubMode | string,
  fsmProjection?: SdrFsmProjection | null,
): string {
  if (!profile || !profile.enabled) return base;

  const withDoctrine = base ? `${base}\n\n${SDR_DOCTRINE}` : SDR_DOCTRINE;

  let result = withDoctrine;

  if (salesState) {
    const heading = subMode ? `## L3 SALES STATE [${subMode}]` : "## L3 SALES STATE";
    const lastTouch = salesState.lastTouchAt
      ? salesState.lastTouchAt.toISOString().slice(0, 10)
      : "—";
    const stateBlock = `${heading}\n- status: ${salesState.status}\n- last-touch: ${lastTouch}`;
    result = `${result}\n\n${stateBlock}`;
  }

  if (fsmProjection) {
    const transitions =
      fsmProjection.allowedTransitions.length > 0
        ? fsmProjection.allowedTransitions.join(", ")
        : "none";
    const fsmBlock =
      `## FSM STATE\n` +
      `- account-status: ${fsmProjection.accountStatus}\n` +
      `- cadence-step: ${fsmProjection.cadenceStep}\n` +
      `- next-transitions: ${transitions}`;
    result = `${result}\n\n${fsmBlock}`;
  }

  return result;
}
