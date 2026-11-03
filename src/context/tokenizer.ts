/**
 * Token count — model-aware BPE (o200k_base) with a fail-open heuristic
 * fallback (CTX-04, audit `runtime-gap-audit-2026-06-02.md`).
 *
 * Replaces the `words * 1.3` heuristic (which systematically undercounted
 * PT-BR / dense JSON tool schemas / emoji) with a real BPE encoder, keeping
 * the synchronous signature `estimateTokens(text: string): number` intact so
 * none of the ~9 callers (5 layers, context-builder, budget-enforcer,
 * rag/chunker, message-embedding-indexer) or PR #61's marker-aware fold need
 * to change.
 *
 * IMPORTANT — import via the `js-tiktoken/lite` subpath + ONE rank file,
 * NEVER the default `"js-tiktoken"` entry. The default entry statically
 * imports all 7 rank tables (~5.4 MB) at `import` time; the lazy guard does
 * NOT avoid that cost. `js-tiktoken/lite` embeds no ranks; the single rank is
 * loaded by a dynamic `import()` INSIDE `getEncoder()`, so only 1 vocab loads
 * and only on the first call.
 *
 * The encoder is a module-level lazy SINGLETON: the rank is imported and the
 * BPE map built ONCE per worker process. A load failure -> fall back to the
 * legacy heuristic (fail-open; NOT a bootstrap failure). Because `import()`
 * is async but `estimateTokens` is sync, the load is fired fire-and-forget on
 * the first call and the heuristic serves until the encoder is ready (a
 * warm-up window of a few calls; spec §8 risk 1/2).
 */
import { Tiktoken, type TiktokenBPE } from "js-tiktoken/lite";

let encoder: Tiktoken | null = null;
let encoderLoadFailed = false;
let encoderLoading = false;
/**
 * Test seam only: resolves once the in-flight encoder load settles (either
 * `encoder` is set or `encoderLoadFailed` is true). Production never awaits.
 */
let loadPromise: Promise<void> | null = null;

/**
 * Optional kill-switch. When `HARNESS_BPE_TOKENIZER_ENABLED === "false"`,
 * `getEncoder()` short-circuits to the heuristic without firing the import —
 * useful if the rank ever causes a latency/memory regression in prod.
 */
function bpeDisabled(): boolean {
  return process.env.HARNESS_BPE_TOKENIZER_ENABLED === "false";
}

/**
 * Load/reuse the o200k_base encoder via the lite subpath + ONE rank.
 * Returns null while loading (early calls use the heuristic) and if the load
 * failed. Does NOT block: fires the rank `import()` fire-and-forget once.
 */
function getEncoder(): Tiktoken | null {
  if (encoder) return encoder;
  if (encoderLoadFailed || encoderLoading || bpeDisabled()) return null;
  encoderLoading = true;
  // Dynamic import of the SINGLE rank — does not pull the other 6 vocabs.
  loadPromise = import("js-tiktoken/ranks/o200k_base")
    .then((mod) => {
      encoder = new Tiktoken(mod.default as TiktokenBPE);
    })
    .catch(() => {
      encoderLoadFailed = true; // do not retry on every call
    })
    .finally(() => {
      encoderLoading = false;
    });
  return null; // first call (and any during the load) uses the heuristic
}

/** Legacy fallback: words * 1.3. Conservative for EN/PT (CTX-04 pre-fix). */
function heuristicTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

/**
 * Estimate the number of tokens in a string (integer >= 0).
 * Uses BPE o200k_base (gpt-4o/gpt-4o-mini, OpenAI primary) once the encoder
 * has loaded; falls back to the heuristic while loading or if the load fails.
 *
 * Determinism is PER-TICK: within one synchronous tick this is deterministic
 * (the encoder only swaps state on a microtask). Across the warm-up window the
 * SAME input may change value (heuristic -> BPE) the first time the encoder is
 * ready. Harmless for the gate (each execution counts once); tests that need
 * absolute determinism must force a state first (see `__awaitEncoderForTests`).
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  const enc = getEncoder();
  if (!enc) return heuristicTokens(text);
  try {
    return enc.encode(text).length;
  } catch {
    return heuristicTokens(text); // per-call defensive: never break the caller
  }
}

/** True once the encoder load has definitively failed (heuristic in use). */
export function isUsingFallbackTokenizer(): boolean {
  return encoderLoadFailed;
}

/**
 * TEST ONLY — reset the module-level singleton so a test can re-trigger the
 * load (e.g. after mocking the rank import to reject). Never called in prod.
 */
export function __resetEncoderForTests(): void {
  encoder = null;
  encoderLoadFailed = false;
  encoderLoading = false;
  loadPromise = null;
}

/**
 * TEST ONLY — force the encoder ready and resolve once the load settles, so a
 * test can pin golden BPE counts without racing the warm-up window. Triggers
 * the import (via a throwaway count) then awaits the in-flight promise. Never
 * called in prod.
 */
export async function __awaitEncoderForTests(): Promise<void> {
  estimateTokens("warm-up"); // fires getEncoder() -> sets loadPromise
  if (loadPromise) await loadPromise;
}
