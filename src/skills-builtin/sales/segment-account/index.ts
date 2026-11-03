/**
 * segment-account — ABCD account segmentation skill (Fase B §5.1)
 *
 * SIDE-EFFECT-FREE INVARIANT (F5, non-negotiable):
 *   This skill is pure compute. It MUST NOT perform any DB read/write,
 *   HTTP call, file I/O, or emit a stop signal. The AgentExecutionContext
 *   is accepted only to satisfy the SkillModule interface; ctx.db and
 *   ctx.llmClient are never touched.
 *
 * DEAD-END PRECEDENCE INVARIANT (spec §5.1 + lead-taxonomy.md §D):
 *   Hard red-flag evaluation runs FIRST, before any ABCD dimension scoring.
 *   An account that carries even one hard red-flag is classified Dead-End ("D")
 *   regardless of how well it fits the ICP. This is non-negotiable: the cost of
 *   investing SDR effort in a red-flagged account (legal exposure, DNC
 *   violation, competitor reference damage) always exceeds the opportunity cost
 *   of skipping it.
 *
 * ABCD TAXONOMY (hardcoded from design-time reference — lead-taxonomy.md §Part 2):
 *   (Never read lead-taxonomy.md or red-flags.md at runtime — rules are inlined.)
 *
 *   A — Perfect ICP Fit, High Potential
 *     Criterion: icpMatchCount = 6  AND  personaPresent = true  AND  personaReachable = true
 *                AND  dealSizeQuartile = "top"  AND  growthSignals = true.
 *     Full Spear cadence (9×15). Research depth: full 8-field persona profile.
 *
 *   B — Strong Fit, Some Gaps (Bread & Butter)
 *     Criterion: icpMatchCount ∈ [4, 5]  AND  personaPresent = true.
 *     Modified Spear cadence (7×7). Upgrade to A if Pain + Authority surface mid-cadence.
 *
 *   C — Marginal Fit (Compelling-Event tier — worth a light touch)
 *     Criterion: icpMatchCount ∈ [2, 3].
 *     Light Net-style cadence (3-touch). Downgrade to D immediately if a red-flag appears.
 *
 *   D — Poor Fit or Disqualified (Dead-End)
 *     Criterion (by poor fit): icpMatchCount ≤ 1  OR  (icpMatchCount ∈ [2,3] with no persona).
 *     Criterion (by red-flag): any hard red-flag present (takes precedence).
 *     Zero active outreach. Nurture list only, with quarterly one-touch check if circumstances could change.
 *
 * HARD RED FLAGS (hardcoded from design-time reference — red-flags.md §Hard Red Flags):
 *
 *   do_not_contact        — Explicit written/verbal DNC request. Compliance requirement (GDPR/LGPD).
 *   budget_freeze         — Confirmed no discretionary spend for >12 months (layoffs, restructuring).
 *   competitor_lock_in    — Active reference customer for a direct competitor; displacement cost
 *                           exceeds SDR resources.
 *   legal_compliance_conflict — Account operates under a regulatory constraint the product cannot serve
 *                              (data residency, sector certification). Do not misrepresent capabilities.
 */

import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import type { ToolResult } from "../../../tools/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid hard red-flag keys (hardcoded from red-flags.md §Hard Red Flags). */
const HARD_RED_FLAGS = new Set([
  "do_not_contact",
  "budget_freeze",
  "competitor_lock_in",
  "legal_compliance_conflict",
] as const);

type HardRedFlag =
  | "do_not_contact"
  | "budget_freeze"
  | "competitor_lock_in"
  | "legal_compliance_conflict";

type Segment = "A" | "B" | "C" | "D";
type DealSizeQuartile = "top" | "mid" | "low" | "unknown";

interface SegmentParams {
  icpMatchCount?: number | null;
  personaPresent?: boolean | null;
  personaReachable?: boolean | null;
  dealSizeQuartile?: DealSizeQuartile | null;
  growthSignals?: boolean | null;
  redFlags?: string[] | null;
}

// ---------------------------------------------------------------------------
// Classification helpers (pure functions)
// ---------------------------------------------------------------------------

/**
 * Identify the first hard red-flag present in the supplied list.
 * Returns the first matching flag or null if none.
 *
 * Dead-End gate: called BEFORE any ABCD scoring (spec §5.1 + lead-taxonomy.md §D).
 */
function findHardRedFlag(redFlags: string[]): HardRedFlag | null {
  for (const flag of redFlags) {
    if (HARD_RED_FLAGS.has(flag as HardRedFlag)) {
      return flag as HardRedFlag;
    }
  }
  return null;
}

/**
 * Apply ABCD scoring rules (hardcoded from lead-taxonomy.md §Part 2).
 * Only called AFTER the Dead-End gate has passed (no hard red-flags).
 */
function classifyABCD(p: SegmentParams): { segment: Segment; reason: string } {
  const icp = typeof p.icpMatchCount === "number" ? p.icpMatchCount : 0;
  const personaPresent = p.personaPresent === true;
  const personaReachable = p.personaReachable === true;
  const dealSize = p.dealSizeQuartile ?? "unknown";
  const growth = p.growthSignals === true;

  // --- A: Perfect ICP Fit, High Potential ---
  // Criterion: all 6 ICP dimensions + persona present & reachable + top-quartile deal + growth signals.
  if (icp >= 6 && personaPresent && personaReachable && dealSize === "top" && growth) {
    return {
      segment: "A",
      reason:
        `A-List account: ${icp}/6 ICP dimensions matched, persona present and reachable, ` +
        `top-quartile deal size, active growth signals. Full 9×15 Spear cadence warranted.`,
    };
  }

  // --- B: Strong Fit, Some Gaps (Bread & Butter) ---
  // Criterion: 4–5 ICP dimensions AND persona present.
  // Also catches near-perfect accounts that missed A on one or two signals (e.g. growth=false).
  if (icp >= 4 && personaPresent) {
    return {
      segment: "B",
      reason:
        `Bread-and-Butter account: ${icp}/6 ICP dimensions matched, persona present. ` +
        `Modified 7×7 Spear cadence. Upgrade to A if Pain and Authority surface mid-cadence.`,
    };
  }

  // --- D: Marginal ICP fit but no reachable persona (persona gate — docstring §D criterion) ---
  // Criterion (by poor fit): icpMatchCount ∈ [2,3] with no persona.
  // An account with marginal ICP fit but NO reachable persona cannot be prospected → Dead-End.
  // This gate runs AFTER the A/B checks (which require personaPresent anyway) and BEFORE the
  // C check so that icp ∈ [2,3] + !personaPresent is never misclassified as C.
  if (icp <= 3 && !personaPresent) {
    return {
      segment: "D",
      reason:
        `Marginal ICP fit but no reachable persona — Dead-End by poor fit. ` +
        `${icp}/6 ICP dimensions matched but persona is absent; account cannot be prospected. ` +
        `No active outreach. Nurture list only.`,
    };
  }

  // --- C: Marginal Fit ---
  // Criterion: icpMatchCount ∈ [2,3] AND personaPresent = true (persona gate above ensures this).
  if (icp >= 2) {
    return {
      segment: "C",
      reason:
        `Marginal-fit account: ${icp}/6 ICP dimensions matched. ` +
        `Light 3-touch cadence only. Downgrade to D immediately if a red-flag surfaces.`,
    };
  }

  // --- D: Poor Fit (≤1 ICP dimension) ---
  return {
    segment: "D",
    reason:
      `Poor-fit account: only ${icp}/6 ICP dimensions matched (minimum 2 required for C). ` +
      `No active outreach. Nurture list only.`,
  };
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

async function execute(params: unknown, _context: AgentExecutionContext): Promise<ToolResult> {
  // Reject non-object params (primitive values are invalid).
  if (params !== null && params !== undefined && typeof params !== "object") {
    return {
      success: false,
      error: "Invalid params: expected an object describing account traits and red flags.",
      errorCode: "INVALID_PARAMS",
    };
  }

  // Cast to SegmentParams — all fields are optional; classification functions handle null/undefined.
  const p = (params ?? {}) as SegmentParams;
  const redFlags: string[] = Array.isArray(p.redFlags) ? p.redFlags : [];

  // --- Dead-End gate (runs FIRST — takes precedence over ABCD scoring) ---
  // Design reference: lead-taxonomy.md §D Hard disqualifiers + red-flags.md §Hard Red Flags.
  const triggeringRedFlag = findHardRedFlag(redFlags);
  if (triggeringRedFlag !== null) {
    return {
      success: true,
      data: {
        segment: "D" as Segment,
        triggeringRedFlag,
        reason:
          `Dead-End: hard red-flag "${triggeringRedFlag}" detected. ` +
          `Account classified D immediately — ABCD scoring suppressed. ` +
          `No active outreach. Zero SDR investment until flag is resolved.`,
      },
    };
  }

  // --- ABCD classification (only reached when no hard red-flags are present) ---
  const { segment, reason } = classifyABCD(p);

  return {
    success: true,
    data: {
      segment,
      reason,
      // Provide a summary of the inputs used so the caller can audit the decision.
      inputs: {
        icpMatchCount: typeof p.icpMatchCount === "number" ? p.icpMatchCount : null,
        personaPresent: p.personaPresent ?? null,
        personaReachable: p.personaReachable ?? null,
        dealSizeQuartile: p.dealSizeQuartile ?? null,
        growthSignals: p.growthSignals ?? null,
        redFlagsObserved: redFlags,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// SkillModule export — satisfies `export default { execute }` pattern.
// ---------------------------------------------------------------------------

export default { execute };
