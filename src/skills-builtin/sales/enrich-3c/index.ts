/**
 * enrich-3c — Company / Contact / ConversationStarter enrichment skill (Fase B §5.1)
 *
 * SIDE-EFFECT INVARIANT (F5 partial exception — READ-ONLY):
 *   This skill is READ-ONLY. It performs at most ONE account-scoped SELECT on
 *   `sdr_account_state` via `context.db`. It MUST NOT write to any table, make
 *   HTTP calls, read from the file system, or emit a stop signal.
 *
 * ACCOUNT-SCOPING INVARIANT (non-negotiable):
 *   Every DB query MUST include `organization_id = $1` as the first positional
 *   parameter bound to `context.organizationId`. No cross-account read is possible.
 *
 * GRACEFUL DEGRADATION INVARIANT (non-negotiable):
 *   This skill MUST NEVER throw to its caller. All failure modes — missing
 *   contactId, DB unavailability, no state row, query error — are handled in
 *   a try/catch that returns a partial-but-usable 3-C result with success:true
 *   and a `degradeReason` explaining what data is missing.
 *
 * DESIGN CHOICE — no-contactId path:
 *   When `context.contactId` is undefined, db.query is NOT called. The UNIQUE
 *   constraint on sdr_account_state(organization_id, contact_id) means an account-only
 *   SELECT could return multiple rows with no clear semantics. The safest degrade
 *   is to skip the DB call entirely and assemble the 3-C from params alone.
 *
 * STATIC HEURISTICS:
 *   ConversationStarter openers are produced by hardcoded heuristics (see below).
 *   The design-time reference `tests/fixtures/sdr/kb/exemplars.md` and
 *   `pact-rubric.md` were consulted at design time — they are NEVER read at runtime.
 *
 * 3-C STRUCTURE (spec §5.1):
 *   Company          — firmographic snapshot assembled from params.
 *   Contact          — persona card assembled from params + SDR state snapshot.
 *   ConversationStarter — a short, specific opener produced by static heuristics.
 */

import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import type { ToolResult } from "../../../tools/types.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

interface EnrichParams {
  companyName: string;
  companyIndustry?: string | null;
  companySize?: string | null;
  companyWebsite?: string | null;
  contactName?: string | null;
  contactTitle?: string | null;
  contactLinkedIn?: string | null;
  recentTrigger?: string | null;
}

// ---------------------------------------------------------------------------
// sdr_account_state row type (matches migration 008)
// ---------------------------------------------------------------------------

interface SdrStateRow {
  id: string | number;
  organization_id: string;
  contact_id: string | number | bigint;
  status: "cold" | "working" | "nurture" | "disqualified";
  pact_snapshot: Record<string, unknown> | null;
  last_touch_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// 3-C output types
// ---------------------------------------------------------------------------

interface CompanyCard {
  name: string;
  industry: string | null;
  size: string | null;
  website: string | null;
}

interface ContactCard {
  name: string | null;
  title: string | null;
  linkedIn: string | null;
  sdrStatus: string | null;
  lastTouchAt: string | null;
  pactSnapshot: Record<string, unknown> | null;
}

interface ConversationStarterCard {
  opener: string;
  rationale: string;
  triggerUsed: string | null;
}

interface ThreeCResult {
  company: CompanyCard;
  contact: ContactCard;
  conversationStarter: ConversationStarterCard;
  degradeReason?: string;
}

// ---------------------------------------------------------------------------
// ConversationStarter heuristics (hardcoded — no runtime file I/O)
//
// Design reference: tests/fixtures/sdr/kb/exemplars.md (consulted at design
// time only). Heuristic priority:
//   1. recentTrigger (if provided) → trigger-anchored opener
//   2. contactTitle + companyIndustry → persona-anchored opener
//   3. pactSnapshot.pain (from DB row) → pain-anchored opener
//   4. Fallback generic ICP-mention opener
// ---------------------------------------------------------------------------

function buildOpener(
  params: EnrichParams,
  pactSnapshot: Record<string, unknown> | null,
): ConversationStarterCard {
  const trigger = params.recentTrigger?.trim();
  const title = params.contactTitle?.trim();
  const industry = params.companyIndustry?.trim();
  const company = params.companyName.trim();

  // Heuristic 1 — recent observable trigger (highest specificity)
  if (trigger && trigger.length > 0) {
    return {
      opener: `I noticed ${company} recently ${trigger}. Given your role${title ? ` as ${title}` : ""}, I thought it worth a quick conversation about how other ${industry ?? "similar"} teams are handling the ramp-up that typically follows.`,
      rationale:
        "Trigger-anchored opener: references a specific, verifiable external event to earn attention without cold-pitching.",
      triggerUsed: trigger,
    };
  }

  // Heuristic 2 — pain from PACT snapshot (if DB row exists)
  if (
    pactSnapshot &&
    typeof pactSnapshot.pain === "string" &&
    pactSnapshot.pain.trim().length > 0
  ) {
    const painSnippet = (pactSnapshot.pain as string).trim().slice(0, 100);
    return {
      opener: `Based on what I understand about ${company}'s situation — "${painSnippet}…" — I wanted to share a quick insight that a few ${industry ?? "peer"} teams have found useful.`,
      rationale:
        "Pain-anchored opener: references a known pain point from the PACT snapshot, creating immediate relevance.",
      triggerUsed: null,
    };
  }

  // Heuristic 3 — persona + industry (medium specificity)
  if (title && industry) {
    return {
      opener: `${title}s in ${industry} I've spoken with lately are dealing with a common challenge around sales efficiency and rep ramp time. Happy to share what's working — would a 15-minute call make sense?`,
      rationale:
        "Persona-anchored opener: addresses a known ICP challenge for this title/vertical combination.",
      triggerUsed: null,
    };
  }

  // Heuristic 4 — title only
  if (title) {
    return {
      opener: `As a ${title}, you're likely thinking about how to scale revenue without scaling headcount proportionally. I've been talking with a few leaders about exactly that — worth a quick conversation?`,
      rationale: "Title-anchored opener: addresses a generic but relevant executive challenge.",
      triggerUsed: null,
    };
  }

  // Heuristic 5 — fallback (minimal specificity)
  return {
    opener: `We help ${industry ?? "growth-stage"} companies accelerate their SDR ramp time and pipeline quality. Would it make sense to explore if ${company} might benefit?`,
    rationale:
      "Generic ICP-mention opener: minimal specificity — recommend enriching with recentTrigger or contactTitle for higher reply rates.",
    triggerUsed: null,
  };
}

// ---------------------------------------------------------------------------
// Validate params — returns error string or null
// ---------------------------------------------------------------------------

function validateParams(params: unknown): { error: string } | null {
  if (
    params === null ||
    params === undefined ||
    typeof params !== "object" ||
    Array.isArray(params)
  ) {
    return { error: "Invalid params: expected a non-null object. Required field: companyName." };
  }
  const p = params as Record<string, unknown>;
  if (
    !p.companyName ||
    typeof p.companyName !== "string" ||
    (p.companyName as string).trim().length === 0
  ) {
    return { error: "Invalid params: 'companyName' is required and must be a non-empty string." };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Account-scoped DB read (one SELECT — wrapped in try/catch)
//
// ACCOUNT-SCOPING: organizationId is ALWAYS the first positional param ($1).
// contactId is ALWAYS the second positional param ($2).
// No cross-account read is possible with this parameterization.
// ---------------------------------------------------------------------------

async function readSdrState(
  db: AgentExecutionContext["db"],
  organizationId: string,
  contactId: bigint,
): Promise<SdrStateRow | null> {
  const result = await db.query<SdrStateRow>(
    `SELECT id, organization_id, contact_id, status, pact_snapshot, last_touch_at, created_at, updated_at
       FROM sdr_account_state
      WHERE organization_id = $1
        AND contact_id = $2
      LIMIT 1`,
    [organizationId, contactId],
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

async function execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult> {
  // --- Param validation (always first — returns before any DB access) ---
  const validationError = validateParams(params);
  if (validationError) {
    return {
      success: false,
      error: validationError.error,
      errorCode: "INVALID_PARAMS",
    };
  }

  const p = params as EnrichParams;

  // --- Build baseline (params-only) 3-C sections ---
  const company: CompanyCard = {
    name: p.companyName.trim(),
    industry: p.companyIndustry?.trim() ?? null,
    size: p.companySize?.trim() ?? null,
    website: p.companyWebsite?.trim() ?? null,
  };

  const contact: ContactCard = {
    name: p.contactName?.trim() ?? null,
    title: p.contactTitle?.trim() ?? null,
    linkedIn: p.contactLinkedIn?.trim() ?? null,
    sdrStatus: null,
    lastTouchAt: null,
    pactSnapshot: null,
  };

  // --- Design choice: if contactId is absent, skip DB (see header) ---
  if (context.contactId === undefined || context.contactId === null) {
    const conversationStarter = buildOpener(p, null);
    const result: ThreeCResult = {
      company,
      contact,
      conversationStarter,
      degradeReason:
        "contactId not available in execution context — SDR state snapshot skipped; 3-C assembled from params only.",
    };
    return { success: true, data: result };
  }

  // --- Attempt account-scoped SELECT — degrade on any failure ---
  let sdrRow: SdrStateRow | null = null;
  let degradeReason: string | undefined;

  try {
    // Guard: db may be undefined/null in some test or misconfigured environments
    if (!context.db) {
      throw new Error("context.db is not available");
    }
    sdrRow = await readSdrState(context.db, context.organizationId, context.contactId);
    if (sdrRow === null) {
      // No state row yet (cold account) — degrade gracefully
      degradeReason =
        "No sdr_account_state row found for this account/contact pair — 3-C assembled from params only.";
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    degradeReason = `DB read failed (${message}) — 3-C assembled from params only.`;
    sdrRow = null;
  }

  // --- Merge DB row into contact card (if available) ---
  if (sdrRow !== null) {
    contact.sdrStatus = sdrRow.status;
    contact.lastTouchAt = sdrRow.last_touch_at ?? null;
    contact.pactSnapshot = sdrRow.pact_snapshot ?? null;
  }

  // --- Build ConversationStarter ---
  const conversationStarter = buildOpener(p, contact.pactSnapshot);

  // --- Compose full 3-C result ---
  const result: ThreeCResult = {
    company,
    contact,
    conversationStarter,
    ...(degradeReason ? { degradeReason } : {}),
  };

  return { success: true, data: result };
}

// ---------------------------------------------------------------------------
// SkillModule export — satisfies `export default { execute }` pattern.
// ---------------------------------------------------------------------------

export default { execute };
