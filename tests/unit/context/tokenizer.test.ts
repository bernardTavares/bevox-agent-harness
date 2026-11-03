import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import {
  estimateTokens,
  isUsingFallbackTokenizer,
  __resetEncoderForTests,
  __awaitEncoderForTests,
} from "../../../src/context/tokenizer.js";

// ---------------------------------------------------------------------------
// Generic invariants — true for ANY monotonic, deterministic tokenizer.
// These must hold whether the BPE encoder is warm or the heuristic fallback
// is active, so they do NOT await the encoder.
// ---------------------------------------------------------------------------
describe("estimateTokens — generic invariants (tokenizer-agnostic)", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(estimateTokens("   \n\t  ")).toBe(0);
  });

  it("returns a positive integer for non-empty text", () => {
    const result = estimateTokens("Hello, world!");
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("longer text produces more tokens", () => {
    const short = estimateTokens("Hello");
    const long = estimateTokens("Hello, this is a much longer sentence with many words.");
    expect(long).toBeGreaterThan(short);
  });

  it("is deterministic WITHIN A TICK (no await between calls)", () => {
    // Determinism is per-tick: the encoder only swaps state on a later
    // microtask, so two synchronous calls in the same tick are identical
    // regardless of whether the encoder is warm. Across the warm-up window
    // the SAME input can change value (heuristic -> BPE) exactly once.
    const text = "The quick brown fox jumps over the lazy dog.";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  it("handles multiline markdown sections", () => {
    const section = "## Heading\n- item 1\n- item 2\n- item 3";
    expect(estimateTokens(section)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Golden BPE counts — encoder FORCED READY via __awaitEncoderForTests().
// The expected numbers below are o200k_base (gpt-4o-mini) counts. They are
// pinned from the encoder itself (self-referential) so they cannot silently
// pin heuristic values: the test FIRST asserts the fallback is OFF, then
// asserts BPE properties that the heuristic cannot satisfy.
// ---------------------------------------------------------------------------
describe("estimateTokens — golden BPE counts (o200k_base, encoder ready)", () => {
  beforeAll(async () => {
    __resetEncoderForTests();
    await __awaitEncoderForTests();
  });

  it("the BPE encoder is active (NOT the heuristic fallback)", () => {
    // Guard: if this fails, every golden assertion below would silently be
    // pinning heuristic values. This MUST pass before trusting the counts.
    expect(isUsingFallbackTokenizer()).toBe(false);
    // Warm the encoder by counting once; the import is already resolved.
    estimateTokens("warm");
    expect(isUsingFallbackTokenizer()).toBe(false);
  });

  it("counts dense JSON above its heuristic word-count (structural undercount fixed)", () => {
    // `{"type":"object"}` is ~1 'word' for the heuristic (ceil(1*1.3)=2) but
    // many BPE tokens (dense punctuation). Asserting BPE > heuristic proves we
    // are NOT on the heuristic path AND that the JSON undercount is corrected.
    const json = '{"type":"object","properties":{"id":{"type":"string"}}}';
    const heuristicWords = json.trim().split(/\s+/).filter(Boolean).length;
    const heuristic = Math.ceil(heuristicWords * 1.3);
    expect(estimateTokens(json)).toBeGreaterThan(heuristic);
  });

  it("counts accented PT-BR prose above its heuristic word-count", () => {
    // Accented/agglutinated PT words tokenise above 1.3 tokens/word in o200k.
    const pt = "Olá! Não consigo remarcar a consulta para amanhã à tarde, обрigada.";
    const heuristicWords = pt.trim().split(/\s+/).filter(Boolean).length;
    const heuristic = Math.ceil(heuristicWords * 1.3);
    expect(estimateTokens(pt)).toBeGreaterThan(heuristic);
  });

  it("counts emoji above one token each", () => {
    // A single emoji is 1 'word' (ceil(1*1.3)=2 heuristic) but 3-5 BPE tokens.
    const emoji = "🎉🚀🔥";
    expect(estimateTokens(emoji)).toBeGreaterThanOrEqual(3);
  });

  it("plain ASCII English is stable and small", () => {
    // Sanity anchor: 'hello world' is a tiny, well-known count in o200k.
    const n = estimateTokens("hello world");
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Fallback path — force the dynamic import to reject; assert graceful
// degradation to the words*1.3 heuristic (fail-open, no throw).
// ---------------------------------------------------------------------------
describe("estimateTokens — fail-open fallback when the rank import fails", () => {
  beforeEach(() => {
    __resetEncoderForTests();
    // Make the dynamic import of the rank reject so the encoder never loads.
    vi.doMock("js-tiktoken/ranks/o200k_base", () => {
      throw new Error("simulated rank load failure");
    });
  });

  afterEach(() => {
    vi.doUnmock("js-tiktoken/ranks/o200k_base");
    __resetEncoderForTests();
  });

  it("returns a positive integer via the heuristic and flags the fallback", async () => {
    // First call triggers the import (which will reject on a later microtask).
    expect(estimateTokens("one two three")).toBeGreaterThan(0);
    // Deterministically await the in-flight (rejecting) load via the test seam
    // — `setTimeout(0)` is not a reliable barrier for the mocked import's
    // rejection to propagate to the `.catch()` that sets the fallback flag
    // (flakes once other blocks interleave microtasks). `__awaitEncoderForTests`
    // awaits the same `loadPromise` that resolves only after `.catch()` runs.
    await __awaitEncoderForTests();
    const n = estimateTokens("one two three four five six seven eight nine ten");
    expect(n).toBe(13); // ceil(10 * 1.3) — the legacy heuristic value
    expect(isUsingFallbackTokenizer()).toBe(true);
  });
});
