import type { Scorer, ScorerInput, ScorerResult } from "../scorer.js";
import { SDR_FORBIDDEN_PHRASES } from "../../sdr/doctrine.js";

// ─── Forbidden-phrase patterns ─────────────────────────────────────────────
//
// Each entry in SDR_FORBIDDEN_PHRASES is compiled into a case-insensitive,
// word-boundary-aware RegExp.  We use \b where the phrase naturally anchors
// to word boundaries; multi-word phrases are matched as literal substrings
// (word-boundary at start and end of the phrase only).
//
// Evasion note: an adversarial message could split the phrase with unicode
// whitespace or zero-width chars.  For an L5 gate "soundness over cleverness"
// is the design goal — deterministic substring match is intentional.  LLM
// evaluation at a higher gate catches more subtle bypasses.
const FORBIDDEN_PHRASE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = (
  SDR_FORBIDDEN_PHRASES as readonly string[]
).map((phrase) => {
  // Escape any regex metacharacters in the phrase literal (defensive).
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchor with \b if the phrase starts/ends on a word character; otherwise
  // use a lookahead/lookbehind that requires non-letter or start/end of string.
  // This prevents "touchbase" (no space) from matching "touch base".
  return [new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, "i"), phrase] as const;
});

// ─── CTA / ask-detection patterns ─────────────────────────────────────────
//
// Purpose: count distinct "ask families" in the message.  A clean SDR message
// has EXACTLY ONE ask family (letter-F rule / Bertuzzi one-CTA rule).
//
// Design philosophy — conservative heuristics:
//   - We detect ASK FAMILIES, not individual question marks.  "Can we talk?"
//     and "Could we schedule a call?" belong to the same family (call-request).
//   - Multiple question marks within one ask family do NOT trigger multi-CTA.
//   - A message with ZERO ask families ⇒ no-CTA violation.
//   - A message with >1 ask families ⇒ multi-CTA violation.
//
// Ask families (annotated):
//   [call-request]    Requesting a meeting / call / conversation
//   [referral-ask]    Asking to be pointed to another person
//   [demo-ask]        Requesting a demo / walkthrough
//   [reply-ask]       Generic "let me know" / "reply with" asks
//   [pt-call]         PT equivalents of call-request
//   [pt-referral]     PT equivalents of referral-ask
//   [pt-demo]         PT equivalents of demo-ask
//   [pt-reply]        PT equivalents of reply-ask
//
// Non-ask patterns intentionally NOT in any family:
//   - Rhetorical questions that don't request a prospect action
//     (e.g. "You know what's frustrating about no-shows?")
//   - Embedded questions in factual statements
//     (e.g. "We've been asking ourselves how to solve this.")
//
// Each family is a list of patterns.  A family "fires" if ANY of its patterns
// match.  The final ask count = number of distinct families that fired.

type AskFamily = {
  name: string;
  patterns: ReadonlyArray<RegExp>;
};

const ASK_FAMILIES: ReadonlyArray<AskFamily> = [
  {
    // [call-request] EN — any form of scheduling / booking a live conversation
    name: "call-request",
    patterns: [
      /\b(?:can|could|would)\s+(?:we|you)\s+(?:schedule|book|set\s+up|arrange|hop\s+on|get\s+on|have|grab)\b/i,
      /\bschedule\s+(?:a\s+)?(?:call|chat|meeting|time|conversation)\b/i,
      /\bbook\s+(?:a\s+)?(?:call|slot|time|meeting)\b/i,
      /\b(?:15|30|45|60)[\s-]?min(?:ute)?\s+call\b/i,
      /\bopen\s+(?:for|to)\s+(?:a\s+)?(?:\w+\s+)?(?:call|chat|conversation|talk)\b/i,
      /\blet'?s\s+(?:connect|talk|chat|meet|schedule)\b/i,
    ],
  },
  {
    // [referral-ask] EN — asking to be directed to another contact
    // Note: "point me to them" in a single-ask referral message is ONE family.
    // "if you're not the right person" is a FORBIDDEN PHRASE caught separately.
    name: "referral-ask",
    patterns: [
      /\b(?:could|can|would)\s+you\s+(?:\w+\s+)?(?:point|refer|direct|connect|introduce|forward)\s+me\b/i,
      /\bpoint\s+me\s+(?:to|toward|in\s+the\s+right\s+direction)\b/i,
      /\brefer\s+me\s+to\b/i,
      /\bintroduce\s+me\s+to\b/i,
      /\bwho\s+(?:would\s+be|is)\s+the\s+(?:right|best)\s+person\b/i,
    ],
  },
  {
    // [demo-ask] EN — requesting a demo / product walkthrough
    name: "demo-ask",
    patterns: [
      /\b(?:want|like|interested\s+in|open\s+to)\s+(?:a\s+)?demo\b/i,
      /\bwould\s+you\s+(?:like|want)\s+(?:to\s+see|a\s+demo|a\s+walkthrough)\b/i,
      /\bshow\s+you\s+(?:how|a\s+demo|the\s+platform)\b/i,
    ],
  },
  {
    // [reply-ask] EN — generic "let me know" or "reply with" asks
    // These count as a CTA when they request a prospect commitment.
    name: "reply-ask",
    patterns: [
      /\blet\s+me\s+know\s+(?:if|whether|when|what)\b/i,
      /\breply\s+(?:with|to\s+this|back)\b/i,
      /\bsend\s+me\s+(?:a\s+note|an\s+email|your\s+availability)\b/i,
    ],
  },
  {
    // [pt-call] PT — call/meeting request variants
    name: "pt-call",
    patterns: [
      /\bpodemos\s+(?:agendar|marcar|conversar|falar)\b/i,
      /\bpoderia\s+(?:reservar|agendar|marcar)\b/i,
      /\bagende\s+(?:uma\s+)?(?:ligação|conversa|reunião|call)\b/i,
      /\bvamos\s+(?:agendar|marcar|conversar)\b/i,
      /\buma\s+conversa\s+(?:rápida|de\s+\d+\s+min)\b/i,
    ],
  },
  {
    // [pt-referral] PT — referral / redirection asks
    name: "pt-referral",
    patterns: [
      /\bpoderia\s+me\s+(?:indicar|encaminhar|redirecionar|apresentar)\b/i,
      /\bquem\s+seria\s+a\s+pessoa\s+(?:certa|ideal|responsável)\b/i,
      /\bindique\s+(?:quem|a\s+pessoa)\b/i,
    ],
  },
  {
    // [pt-demo] PT — demo requests
    name: "pt-demo",
    patterns: [
      /\bgostaria\s+de\s+(?:ver|conhecer|uma\s+demo)\b/i,
      /\bposso\s+(?:te\s+)?mostrar\b/i,
    ],
  },
  {
    // [pt-reply] PT — generic reply/let-me-know asks
    name: "pt-reply",
    patterns: [
      /\bme\s+avise\s+(?:se|quando|o\s+que)\b/i,
      /\bresponda\s+(?:este|esse|com)\b/i,
      /\bme\s+diga\s+(?:se|quando)\b/i,
    ],
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the name of the first forbidden phrase found in `text`, or null
 * if none matched.
 */
function detectForbiddenPhrase(text: string): string | null {
  for (const [pattern, phrase] of FORBIDDEN_PHRASE_PATTERNS) {
    if (pattern.test(text)) return phrase;
  }
  return null;
}

/**
 * Counts the number of distinct ask families present in `text`.
 * Returns an array of the matched family names for use in reasoning.
 */
function detectAskFamilies(text: string): string[] {
  const matched: string[] = [];
  for (const family of ASK_FAMILIES) {
    if (family.patterns.some((p) => p.test(text))) {
      matched.push(family.name);
    }
  }
  return matched;
}

// ─── Scorer ──────────────────────────────────────────────────────────────

/**
 * SdrMessageReadyScorer — Fase A §4.3 certification gate (letter-F / L5)
 *
 * Enforces Bertuzzi's Message-Ready rules deterministically:
 *   1. No forbidden phrase (sourced from SDR_FORBIDDEN_PHRASES in doctrine.ts).
 *   2. Exactly one call-to-action / ask family per message (one-CTA rule).
 *      Zero asks ⇒ no-CTA violation.  More than one ⇒ multi-CTA violation.
 *
 * Letter-F structure and the 4 voicemail rules (Bertuzzi) have partial
 * deterministic coverage here:
 *   - The one-CTA rule is directly enforced (letter-F closes with one ask).
 *   - Zero-ask detection catches messages that lack a letter-F closing ask.
 *   - Full letter-F compliance (opening hook, value bridge, ask) requires
 *     LLM-as-judge; this gate is the deterministic complement.
 *
 * Scoring convention (higher = better, consistent with harness):
 *   score = 1  →  no violation detected; message is message-ready.
 *   score = 0  →  at least one violation found; reasoning names it.
 *
 * This is a rule scorer: kind = "rule", model_used = null, deterministic.
 */
export class SdrMessageReadyScorer implements Scorer {
  readonly name = "sdr-message-ready";
  readonly kind = "rule" as const;

  async score(input: ScorerInput): Promise<ScorerResult> {
    const text = input.output;

    // ── Gate 1: Forbidden phrases ────────────────────────────────────────
    const forbiddenHit = detectForbiddenPhrase(text);
    if (forbiddenHit !== null) {
      return {
        score: 0,
        reasoning:
          `Forbidden phrase detected: "${forbiddenHit}". ` +
          `Per SDR doctrine (Fase A §4.3 / Bertuzzi), this phrase is banned ` +
          `from SDR messages because it signals relationship-theater or ` +
          `lack of prior research. Remove or rewrite the passage.`,
        model_used: null,
      };
    }

    // ── Gate 2: CTA count ────────────────────────────────────────────────
    const matchedFamilies = detectAskFamilies(text);
    const ctaCount = matchedFamilies.length;

    if (ctaCount === 0) {
      return {
        score: 0,
        reasoning:
          `No CTA / ask detected in the message. ` +
          `Per Bertuzzi's letter-F structure (Fase A §4.3), every SDR message ` +
          `must close with exactly one explicit ask (referral XOR call). ` +
          `A message with zero asks has no forward momentum.`,
        model_used: null,
      };
    }

    if (ctaCount > 1) {
      return {
        score: 0,
        reasoning:
          `Multi-CTA violation: ${ctaCount} distinct ask families detected ` +
          `(${matchedFamilies.join(", ")}). ` +
          `Per SDR doctrine's one-CTA rule (Fase A §4.1/§4.3), each message ` +
          `may contain exactly one ask — referral XOR call, never both. ` +
          `Asking for multiple things in one message splits prospect attention ` +
          `and signals seller-based (not buyer-based) framing.`,
        model_used: null,
      };
    }

    // ── All gates passed ─────────────────────────────────────────────────
    return {
      score: 1,
      reasoning:
        `No forbidden phrases detected. Exactly one ask family found ` +
        `(${matchedFamilies[0]}). Message passes the deterministic ` +
        `message-ready gate (forbidden-phrase check + one-CTA rule).`,
      model_used: null,
    };
  }
}
