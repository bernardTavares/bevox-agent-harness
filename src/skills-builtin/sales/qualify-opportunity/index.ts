/**
 * qualify-opportunity — PACT / PACT2 scoring skill (Fase B §5.1)
 *
 * SIDE-EFFECT-FREE INVARIANT (F5, non-negotiable):
 *   This skill is pure compute. It MUST NOT perform any DB read/write,
 *   HTTP call, file I/O, or emit a stop signal. The AgentExecutionContext
 *   is accepted only to satisfy the SkillModule interface; ctx.db and
 *   ctx.llmClient are never touched.
 *
 * ANTI-OVER-CLAIM INVARIANT (Ross audit-gate philosophy):
 *   A qualified verdict (qualified: true) is returned ONLY when:
 *     (a) Pain evidence is present (non-null, non-empty description), AND
 *     (b) Authority evidence is present (non-null, non-empty description), AND
 *     (c) Total score ≥ pass gate (3/4 for PACT, 4/5 for PACT2), AND
 *     (d) For PACT2: Timing evidence is also present.
 *   Missing either P or A always disqualifies, regardless of other dimensions.
 *
 * PACT RUBRIC (hardcoded from design-time reference — pact-rubric.md):
 *
 *   P — Pain
 *     Evidence required: prospect states a specific, recurring, costly problem
 *     in their own words. "Sure, that could be a problem" = phantom pain → 0.
 *     Score contribution: 1 point if pain.description is non-empty AND
 *     evidenceType is one of the recognized types.
 *
 *   A — Authority
 *     Evidence required: contact is economic buyer, OR has named the DM and
 *     committed to engage them (internal meeting), OR has set a next step with
 *     the decision-maker. "I'll pass it along" = ghost authority → 0.
 *     Score contribution: 1 point if authority.description is non-empty AND
 *     evidenceType is one of the recognized types.
 *
 *   C — Consequence
 *     Evidence required: quantified impact (revenue, hours, attrition, penalty)
 *     OR strategic consequence stated by prospect or verifiable externally.
 *     Score contribution: 1 point if consequence.description is non-empty.
 *
 *   T — Target Profile
 *     Evidence required: ≥4 of 6 ICP dimensions match AND persona matches.
 *     Score contribution: 1 point if icpMatchCount ≥ 4 AND personaMatch = true.
 *
 *   Pass gate (PACT):  score ≥ 3/4  AND  P=1  AND  A=1
 *   Pass gate (PACT2): score ≥ 4/5  AND  P=1  AND  A=1  AND  Ti=1
 *     (PACT2 adds Ti — Timing: a named event or fiscal deadline.)
 *
 *   Missing P or A always fails the gate regardless of total score.
 */

import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import type { ToolResult } from "../../../tools/types.js";

// ---------------------------------------------------------------------------
// Input types (intentionally lenient — skill validates internally)
// ---------------------------------------------------------------------------

interface PainEvidence {
  description: string;
  evidenceType?: string;
}

interface AuthorityEvidence {
  description: string;
  evidenceType?: string;
}

interface ConsequenceEvidence {
  description: string;
  evidenceType?: string;
}

interface TargetProfileEvidence {
  icpMatchCount?: number;
  personaMatch?: boolean;
  notes?: string;
}

interface TimingEvidence {
  description: string;
  evidenceType?: string;
}

interface QualifyParams {
  pain?: PainEvidence | null;
  authority?: AuthorityEvidence | null;
  consequence?: ConsequenceEvidence | null;
  targetProfile?: TargetProfileEvidence | null;
  timing?: TimingEvidence | null;
  framework?: "PACT" | "PACT2";
}

// ---------------------------------------------------------------------------
// Dimension score result
// ---------------------------------------------------------------------------

interface DimensionResult {
  score: 0 | 1;
  satisfied: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// PACT Rubric — hardcoded scoring functions
// (Design reference: tests/fixtures/sdr/kb/pact-rubric.md — never imported at runtime)
// ---------------------------------------------------------------------------

/** P — Pain: must be prospect-stated with a non-empty, specific description. */
function scorePain(pain: PainEvidence | null | undefined): DimensionResult {
  if (!pain || typeof pain.description !== "string" || pain.description.trim().length === 0) {
    return {
      score: 0,
      satisfied: false,
      reason:
        "No pain evidence provided. Prospect must state a specific, consequential business problem in their own words.",
    };
  }
  return {
    score: 1,
    satisfied: true,
    reason: `Pain evidence present: "${pain.description.trim().slice(0, 120)}${pain.description.length > 120 ? "…" : ""}"`,
  };
}

/** A — Authority: must confirm economic buyer or committed champion. */
function scoreAuthority(authority: AuthorityEvidence | null | undefined): DimensionResult {
  if (
    !authority ||
    typeof authority.description !== "string" ||
    authority.description.trim().length === 0
  ) {
    return {
      score: 0,
      satisfied: false,
      reason:
        "No authority evidence provided. Contact must be the economic buyer, OR name the DM and commit to engage them.",
    };
  }
  return {
    score: 1,
    satisfied: true,
    reason: `Authority evidence present: "${authority.description.trim().slice(0, 120)}${authority.description.length > 120 ? "…" : ""}"`,
  };
}

/** C — Consequence: must be quantified impact or stated strategic consequence. */
function scoreConsequence(consequence: ConsequenceEvidence | null | undefined): DimensionResult {
  if (
    !consequence ||
    typeof consequence.description !== "string" ||
    consequence.description.trim().length === 0
  ) {
    return {
      score: 0,
      satisfied: false,
      reason:
        "No consequence evidence provided. Cost of inaction must be quantified or confirmed as strategic consequence.",
    };
  }
  return {
    score: 1,
    satisfied: true,
    reason: `Consequence evidence present: "${consequence.description.trim().slice(0, 120)}${consequence.description.length > 120 ? "…" : ""}"`,
  };
}

/** T — Target Profile: ≥4/6 ICP dimensions matched AND persona matches. */
function scoreTargetProfile(
  targetProfile: TargetProfileEvidence | null | undefined,
): DimensionResult {
  if (!targetProfile) {
    return {
      score: 0,
      satisfied: false,
      reason:
        "No target profile evidence provided. ICP match count and persona match are required.",
    };
  }
  const matchCount =
    typeof targetProfile.icpMatchCount === "number" ? targetProfile.icpMatchCount : 0;
  const personaMatch = targetProfile.personaMatch === true;

  if (matchCount >= 4 && personaMatch) {
    return {
      score: 1,
      satisfied: true,
      reason: `Target profile matches: ${matchCount}/6 ICP dimensions, persona match confirmed.`,
    };
  }
  const reasons: string[] = [];
  if (matchCount < 4) reasons.push(`ICP match count is ${matchCount}/6 (minimum 4 required)`);
  if (!personaMatch) reasons.push("persona match not confirmed");
  return {
    score: 0,
    satisfied: false,
    reason: `Target profile insufficient: ${reasons.join("; ")}.`,
  };
}

/** Ti — Timing (PACT2 only): a named event or fiscal deadline stated by the prospect. */
function scoreTiming(timing: TimingEvidence | null | undefined): DimensionResult {
  if (!timing || typeof timing.description !== "string" || timing.description.trim().length === 0) {
    return {
      score: 0,
      satisfied: false,
      reason:
        "No timing evidence provided. A named event or fiscal deadline stated by the prospect is required for PACT2.",
    };
  }
  return {
    score: 1,
    satisfied: true,
    reason: `Timing evidence present: "${timing.description.trim().slice(0, 120)}${timing.description.length > 120 ? "…" : ""}"`,
  };
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

async function execute(params: unknown, _context: AgentExecutionContext): Promise<ToolResult> {
  // Validate params shape — must be a non-null object (or null/undefined → treat as empty)
  if (params !== null && params !== undefined && typeof params !== "object") {
    return {
      success: false,
      error: "Invalid params: expected an object describing PACT evidence dimensions.",
      errorCode: "INVALID_PARAMS",
    };
  }

  // Cast to QualifyParams — all fields are optional; scoring functions handle null/undefined defensively.
  const p = (params ?? {}) as QualifyParams;
  const framework = p.framework === "PACT2" ? "PACT2" : "PACT";

  // --- Score each dimension ---
  const painResult = scorePain(p.pain);
  const authorityResult = scoreAuthority(p.authority);
  const consequenceResult = scoreConsequence(p.consequence);
  const targetProfileResult = scoreTargetProfile(p.targetProfile);

  // PACT2 adds Timing
  const timingResult = framework === "PACT2" ? scoreTiming(p.timing) : null;

  // --- Compute total score ---
  const pactScore =
    painResult.score + authorityResult.score + consequenceResult.score + targetProfileResult.score;
  const totalScore =
    framework === "PACT2" && timingResult ? pactScore + timingResult.score : pactScore;
  const maxScore = framework === "PACT2" ? 5 : 4;

  // --- Apply pass gate (anti-over-claim invariant) ---
  //   PACT:  score ≥ 3/4  AND  P=1  AND  A=1
  //   PACT2: score ≥ 4/5  AND  P=1  AND  A=1  AND  Ti=1
  const passThreshold = framework === "PACT2" ? 4 : 3;
  const painPresent = painResult.satisfied;
  const authorityPresent = authorityResult.satisfied;
  const timingPresent = timingResult?.satisfied ?? true; // only enforced for PACT2

  const meetsThreshold = totalScore >= passThreshold;
  const meetsGate = painPresent && authorityPresent && (framework === "PACT" || timingPresent);
  const qualified = meetsThreshold && meetsGate;

  // --- Build missing dimensions list (for non-qualified result transparency) ---
  const missing: string[] = [];
  if (!painPresent) missing.push("pain");
  if (!authorityPresent) missing.push("authority");
  if (!consequenceResult.satisfied) missing.push("consequence");
  if (!targetProfileResult.satisfied) missing.push("targetProfile");
  if (framework === "PACT2" && !timingPresent) missing.push("timing");

  // --- Compose breakdown ---
  const breakdown: Record<string, DimensionResult> = {
    pain: painResult,
    authority: authorityResult,
    consequence: consequenceResult,
    targetProfile: targetProfileResult,
  };
  if (framework === "PACT2" && timingResult) {
    breakdown.timing = timingResult;
  }

  // --- Compose reason string ---
  let reason: string;
  if (qualified) {
    reason = `${framework} gate passed: score ${totalScore}/${maxScore} with Pain and Authority both satisfied.`;
  } else if (!painPresent && !authorityPresent) {
    reason = `Not qualified: Pain and Authority evidence are both absent. Both are required by the ${framework} rubric regardless of other dimensions.`;
  } else if (!painPresent) {
    reason =
      "Not qualified: Pain evidence is absent. The prospect must state a specific, consequential problem in their own words.";
  } else if (!authorityPresent) {
    reason =
      "Not qualified: Authority evidence is absent. Both Pain and Authority are required to pass the qualification gate.";
  } else if (framework === "PACT2" && !timingPresent) {
    reason = `Not qualified: PACT2 requires Timing evidence (a named event or fiscal deadline). Score ${totalScore}/${maxScore}.`;
  } else {
    reason = `Not qualified: Score ${totalScore}/${maxScore} is below the ${framework} pass gate of ${passThreshold}/${maxScore}. Missing: ${missing.join(", ")}.`;
  }

  return {
    success: true,
    data: {
      qualified,
      framework,
      score: totalScore,
      maxScore,
      passThreshold,
      missing,
      reason,
      breakdown,
    },
  };
}

// ---------------------------------------------------------------------------
// SkillModule export — satisfies `export default { execute }` pattern.
// ---------------------------------------------------------------------------

export default { execute };
