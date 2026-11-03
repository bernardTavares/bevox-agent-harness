import type { Scorer, ScorerInput, ScorerResult } from "../scorer.js";

// ─── Qualification / Handoff claim detection ───────────────────────────────
//
// These patterns detect when an SDR agent's OUTPUT self-reports that a lead is
// "qualified" or "ready for handoff" — the statements that trigger Aaron Ross's
// audit gate. Both EN and PT-BR surface forms are covered.
//
// Claim families covered (annotated per family):
//
//   [explicit-qual]  "qualified" / "qualificado/a" — explicit MEDDIC/BANT word
//   [explicit-qual]  "oportunidade qualificada" — PT composite noun phrase
//   [handoff-word]   "handoff" (bare or "ready for handoff") — SDR→AE transition word
//   [handoff-verb]   phrasal-verb forms: "handing this off", "handed off to sales",
//                    "hand it off now", "hand off to the AE"
//   [handoff-word]   "pronto/a para handoff" — PT bare handoff word
//   [pass-to-ae]     "pass to the AE" / "pass to AE" / "passed to the AE" / "passing to AE"
//                    "pass to the account executive" — evasion: avoids "handoff" but implies it
//   [pass-to-ae]     PT: "passar para o AE" / "encaminhar ao executivo de contas"
//   [opp-stage]      "moving to Opportunity" / "Opportunity stage" / "to opportunity" —
//                    CRM stage progression signals that the deal crossed the SQL threshold
//   [bant-label]     "BANT complete/done/confirmed/qualified/passed/checked" — qualification framework label
//   [meddic-label]   "MEDDIC complete/done/confirmed/qualified/passed/checked" — qualification framework label
//   [sql-label]      "SQL" (sales qualified lead) / "SQL confirmed" — explicit pipeline label
//   [sales-ready]    "sales-ready" / "sales ready" — marketing automation / BDR label
//   [close-lang]     "ready to close" / "close-ready" / "escalate to closing" / "closing team" —
//                    late-funnel language implying AE territory
//   [demo-ae]        "schedule a demo with the AE" / "demo with the account executive" —
//                    implicit handoff signal (AE-led demo = next stage handoff)
//   [demo-ae]        PT: "agendar demo com o AE"
//   [pt-close]       "pronto para fechar" / "pronto a fechar" — PT close-ready signal
//   [pt-pass]        "estágio de oportunidade" — PT Opportunity stage
//
// Using word boundaries (\b) to avoid false positives on e.g. "unqualified".
const QUALIFICATION_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  // [explicit-qual] EN
  /\bqualified\b/i,
  // [explicit-qual] PT
  /\bqualificad[oa]\b/i,
  /\boportunidade qualificada\b/i,

  // [handoff-word] EN
  /\bhandoff\b/i, // catch bare "handoff" — an SDR output mentioning handoff implies readiness
  /\bready for handoff\b/i,
  // [handoff-verb] EN — phrasal-verb forms that avoid the compound noun "handoff"
  // e.g. "handing this off to the AE", "handed off to sales", "hand it off now"
  /\bhand(?:ing|ed)?\s+(?:this\s+|it\s+)?off\b/i,
  // [handoff-word] PT
  /\bpronto[a]? para handoff\b/i,

  // [pass-to-ae] EN — agent learns to avoid "handoff" but still routes to AE
  /\bpass(?:ing|ed)?\s+to\s+(?:the\s+)?(?:AE|account\s+executive)\b/i,
  /\bready\s+to\s+(?:be\s+)?passed?\s+to\s+(?:the\s+)?(?:AE|account\s+executive)\b/i,
  // [pass-to-ae] PT
  /\bpassar\s+para\s+o\s+AE\b/i,
  /\bencaminhar\s+ao?\s+executivo\s+de\s+contas\b/i,

  // [opp-stage] EN — CRM stage progression (Salesforce / HubSpot "Opportunity")
  /\bmoving\s+to\s+[Oo]pportunity\b/i,
  /\b[Oo]pportunity\s+stage\b/i,
  /\bto\s+[Oo]pportunity\b/i,
  // [opp-stage] PT
  /\bestágio\s+de\s+oportunidade\b/i,

  // [bant-label] BANT qualification-framework completion labels
  /\bBANT\s+(?:complete|completed|done|confirmed|passed|checked|qualified)\b/i,
  // [meddic-label] MEDDIC qualification-framework completion labels
  /\bMEDDIC\s+(?:complete|completed|done|confirmed|passed|checked|qualified)\b/i,

  // [sql-label] SQL as pipeline label (word-boundary: avoids "MySQL")
  // Accepted residual: "SQL" is a valid tech term but is specific enough in SDR prose context.
  /\bSQL\b(?:\s+confirmed)?/,

  // [sales-ready] EN
  /\bsales[\s-]ready\b/i,

  // [close-lang] EN — close-ready / closing-team language
  /\bready\s+to\s+close\b/i,
  /\bclose[\s-]ready\b/i,
  /\bescalate\s+to\s+closing\b/i,
  /\bclosing\s+team\b/i,
  // [close-lang] PT
  /\bpronto[a]?\s+(?:para|a)\s+fechar\b/i,

  // [demo-ae] EN — implicit handoff: AE-led demo = next stage
  /\bschedule\s+a\s+demo\s+with\s+the\s+(?:AE|account\s+executive)\b/i,
  /\bdemo\s+with\s+the\s+account\s+executive\b/i,
  // [demo-ae] PT
  /\bagendar\s+demo\s+com\s+o\s+AE\b/i,
] as const;

// ─── Pain evidence patterns ────────────────────────────────────────────────
//
// These detect signals that the prospect has articulated a business PAIN —
// Aaron Ross's "P" in the audit gate. Pain must be OBSERVED in the transcript,
// not inferred. We look for explicit problem/challenge language.
//
// Covered signals:
//   - EN: problem(s), challenge(s), issue(s), pain, struggle, failing, broken,
//         hurt, difficulty, obstacle, bottleneck, frustrated, can't, can not,
//         unable to, losing, costs us
//   - PT: problema, desafio, dificuldade, dor, sofrendo, falhando, quebrando,
//         impacto negativo, obstáculo, gargalo, frustrado
const PAIN_PATTERNS: ReadonlyArray<RegExp> = [
  // EN — explicit pain/problem nouns (plurals included via optional 's')
  /\b(problems?|challenges?|issues?|pain\s*points?|pain|struggle|struggling|failing|failed|broken|hurt|difficulty|obstacles?|bottlenecks?|frustrated|frustration)\b/i,
  // EN — modal inability (two-word "can not" and contracted "can't" / "cannot")
  /\bcan\s*not\b|\bcan't\b|\bcannot\b|\bunable\s+to\b|\bnot\s+able\s+to\b/i,
  // EN — financial/impact language
  /\b(losing|we\s+lose|costs?\s+us|costing\s+us|impacts?\s+us|significant\s+(delay|loss|cost|impact))\b/i,
  // PT
  /\b(problema|desafio|dificuldade|dor|sofrendo|falhando|quebrado|quebrando|impacto\s+negativo|obstáculo|gargalo|frustrado|frustração)\b/i,
  /\b(perdemos|perdendo|custando|afetando|grande\s+problema|ponto\s+de\s+dor)\b/i,
] as const;

// ─── Authority evidence patterns ───────────────────────────────────────────
//
// These detect signals that the person the SDR spoke to has AUTHORITY to make
// or strongly influence the buying decision — Aaron Ross's "A".
//
// Design goal: avoid false positives from third-party / relationship mentions
// such as "our channel partner", "the founder of this startup", "their director".
// Strategy: require that authority-bearing nouns are tied to a decision/buying
// context (self-declaration verbs, budget/sign-off language, or a seniority
// title adjacent to a first-person subject) rather than matching bare nouns.
//
// Covered signals:
//   [self-decl]  First-person explicit declarations: "I decide", "I approve",
//                "I own the budget", "I make the call", "I am responsible for",
//                "I am the decision maker"
//   [budget]     "I have the budget", "I have the authority", "I have sign-off",
//                "budget authority", "sign-off authority" (with optional "the")
//   [title+ctx]  Senior title when adjacent to decision/buying context in the
//                same sentence: VP, C-suite, Head of — these rarely appear in
//                isolation without buyer context in SDR transcripts.
//                To curb third-party false positives we REQUIRE the title to be
//                accompanied by one of: "I am", "I'm", "as [title]", "our [title]"
//                only when preceded by "I"/"I'm", or a buying-decision verb nearby.
//   [pt-decl]   PT equivalents of self-declarations
//
// Note: bare "Partner", "Founder", "Owner", "Director" are intentionally NOT
// matched as title-only patterns — they must appear with decision/buying verbs
// or in first-person framing (see [title-first-person] below).
const AUTHORITY_PATTERNS: ReadonlyArray<RegExp> = [
  // [self-decl] EN — explicit first-person decision authority declarations
  /\bI\s+(decide|approve|make\s+the\s+(?:call|decision)|am\s+(?:the\s+)?(?:decision[\s-]?maker|responsible|accountable)\b)/i,
  /\bI\s+(?:am\s+)?(?:the\s+)?decision[\s-]?maker\b/i,
  // [decision-maker-label] — standalone label; specific enough to be reliable
  // in both free-text transcripts and trusted contact-profile annotations
  // (e.g. "Contact profile: VP of Marketing (decision maker)")
  // Acknowledged tradeoff (Gap 3): a third party could be described as "decision maker"
  // (e.g. "their decision maker approved it"). A bypass here requires the compound condition
  // of independent pain evidence PLUS an incidental third-party "decision maker" mention —
  // the joint probability is low and the contact-profile annotation use case justifies
  // keeping the bare pattern. Accepted residual.
  /\bdecision[\s-]?maker\b/i,

  // [budget] EN — explicit budget/authority possession (with optional "the")
  /\bI\s+have\s+(?:the\s+)?(budget|authority|sign[\s-]?off|approval)\b/i,
  /\bbudget\s+authority\b/i,
  /\bI\s+own\s+the\s+budget\b/i,

  // [title-first-person] EN — seniority title in first-person context only
  // Matches: "I am the VP", "I'm the CEO", "I'm the Head of", "as the Director"
  // Does NOT match: "the founder of this startup", "our channel partner's director"
  /\bI\s*'?m?\s+(?:the\s+)?(?:CEO|CTO|CFO|COO|CMO|CRO|VP|Vice[\s-]President|President|Managing\s+Director|General\s+Manager|Head\s+of\b)/i,
  /\bI\s+am\s+(?:the\s+)?(?:CEO|CTO|CFO|COO|CMO|CRO|VP|Vice[\s-]President|President|Managing\s+Director|General\s+Manager|Head\s+of\b|Director\b|Owner\b|Founder\b|Partner\b)/i,

  // [title-buying-verb] EN — title next to a clear buying/decision verb
  // e.g. "VP of Sales and I approve", "as CEO I make the call"
  /\b(?:CEO|CTO|CFO|COO|CMO|CRO|VP|Vice[\s-]President|President|Managing\s+Director|General\s+Manager|Head\s+of\b|Director\b)\b.{0,80}\b(decide|approve|sign[\s-]?off|make\s+the\s+(?:call|decision)|own\s+the\s+budget)\b/is,
  /\b(decide|approve|sign[\s-]?off|make\s+the\s+(?:call|decision)|own\s+the\s+budget)\b.{0,80}\b(?:CEO|CTO|CFO|COO|CMO|CRO|VP|Vice[\s-]President|President|Managing\s+Director|General\s+Manager|Head\s+of\b|Director\b)\b/is,

  // [pt-decl] PT — first-person authority declarations
  /\beu\s+(decido|aprovo|responsável\s+pelas\s+decisões|sou\s+o\s+decisor|sou\s+o\s+tomador\s+de\s+decisão)\b/i,
  /\btomador\s+de\s+decisão\b/i,
  /\bdecisão\s+de\s+compra\b/i,
  /\bautoridade\s+de\s+compra\b/i,
  // PT — "Sou o Diretor" / "sou o responsável"
  /\bsou\s+o?\s+(?:Diretor|Gerente\s+Geral|Sócio|Fundador|Proprietário|Dono|responsável)\b/i,
  // PT — explicit budget/authority possession
  /\btenho\s+(?:o\s+)?(?:orçamento|autoridade|aprovação)\b/i,
] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Returns true if any pattern in the list matches the given text. */
function anyMatch(patterns: ReadonlyArray<RegExp>, text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Aggregates all text that should be searched for evidence (Pain + Authority).
 * We check both `input.input` (the transcript / last user message) and
 * `input.context.system_prompt` (contact profile enrichment injected by the
 * 5-layer context builder). Both are legitimate sources of observed evidence.
 */
function buildEvidenceCorpus(input: ScorerInput): string {
  const parts: string[] = [input.input];
  if (input.context?.system_prompt) parts.push(input.context.system_prompt);
  // contact_profile JSON may also carry role/pain hints
  if (input.context?.contact_profile) {
    parts.push(JSON.stringify(input.context.contact_profile));
  }
  return parts.join(" ");
}

// ─── Scorer ───────────────────────────────────────────────────────────────

/**
 * SdrAuditGateScorer — Fase A §4.3 keystone
 *
 * Enforces Aaron Ross's anti-over-claim audit gate:
 *   An SDR agent MUST NOT assert that an opportunity is qualified / ready for
 *   handoff unless the observed transcript contains BOTH:
 *     1. Pain evidence   — the prospect articulated a business problem.
 *     2. Authority evidence — the person has buying authority / is a decision maker.
 *
 * This is a deterministic rule scorer (kind: "rule", model_used: null).
 * No LLM is involved so the gate itself cannot hallucinate.
 *
 * Scoring convention (higher = better):
 *   score = 0  →  over-claim detected (claim made without Pain+Authority evidence)
 *   score = 1  →  no violation (either no claim, or claim is substantiated)
 */
export class SdrAuditGateScorer implements Scorer {
  readonly name = "sdr-audit-gate";
  readonly kind = "rule" as const;

  async score(input: ScorerInput): Promise<ScorerResult> {
    const outputText = input.output;

    // Step 1: Does the output make a qualification/handoff claim?
    const hasClaim = anyMatch(QUALIFICATION_CLAIM_PATTERNS, outputText);

    if (!hasClaim) {
      // No claim → nothing to violate. Gate is silent.
      return {
        score: 1,
        reasoning: "No qualification or handoff claim detected in output. Gate not triggered.",
        model_used: null,
      };
    }

    // Step 2: Gather all observable evidence the agent had access to.
    const evidenceCorpus = buildEvidenceCorpus(input);

    // Step 3: Check for Pain and Authority signals in the evidence corpus.
    const hasPain = anyMatch(PAIN_PATTERNS, evidenceCorpus);
    const hasAuthority = anyMatch(AUTHORITY_PATTERNS, evidenceCorpus);

    if (hasPain && hasAuthority) {
      // Claim is substantiated — gate passes.
      return {
        score: 1,
        reasoning:
          "Qualification claim detected in output. Both pain evidence and authority evidence " +
          "found in the input transcript/context. Claim is substantiated per Ross audit gate.",
        model_used: null,
      };
    }

    // Step 4: Claim is unsubstantiated — gate fires (score = 0).
    const missing: string[] = [];
    if (!hasPain) missing.push("pain (no business problem articulated by the prospect)");
    if (!hasAuthority) missing.push("authority (no buying-authority signal from the contact)");

    return {
      score: 0,
      reasoning:
        `Anti-over-claim gate fired: output contains a qualification/handoff claim but the ` +
        `observed transcript lacks required evidence — missing: ${missing.join("; ")}. ` +
        `Per Aaron Ross's audit gate (Fase A §4.3), an SDR must observe BOTH pain and ` +
        `authority before asserting qualification.`,
      model_used: null,
    };
  }
}
