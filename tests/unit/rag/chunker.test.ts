import { describe, expect, it } from "vitest";

import { RecursiveChunker } from "../../../src/rag/chunker.js";
import { estimateTokens } from "../../../src/context/tokenizer.js";

describe("RecursiveChunker", () => {
  it("returns empty array for empty/whitespace content", () => {
    const c = new RecursiveChunker();
    expect(c.chunk("")).toEqual([]);
    expect(c.chunk("   \n\n  ")).toEqual([]);
  });

  it("returns a single chunk for content under the budget", () => {
    const c = new RecursiveChunker({ maxTokens: 100, overlapTokens: 0 });
    const out = c.chunk("Hello world. Short text.");
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain("Hello world");
  });

  it("splits along paragraph boundaries first", () => {
    const c = new RecursiveChunker({ maxTokens: 20, overlapTokens: 0 });
    const para1 = "alpha ".repeat(15).trim();
    const para2 = "beta ".repeat(15).trim();
    const out = c.chunk(`${para1}\n\n${para2}`);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // First chunks should not mix alpha+beta if the paragraph split worked.
    const first = out[0]!.content;
    expect(first.includes("alpha") && first.includes("beta")).toBe(false);
  });

  it("respects maxTokens budget on every chunk (within heuristic margin)", () => {
    const c = new RecursiveChunker({ maxTokens: 50, overlapTokens: 0 });
    const long = "word ".repeat(500).trim();
    const out = c.chunk(long);
    for (const chunk of out) {
      // Tokenizer is heuristic; allow small overshoot.
      expect(chunk.tokenCount).toBeLessThanOrEqual(60);
    }
    expect(out.length).toBeGreaterThan(5);
  });

  it("applies overlap by carrying trailing words from previous chunk", () => {
    // maxTokens must leave room for overlap on top of chunk content.
    const c = new RecursiveChunker({ maxTokens: 25, overlapTokens: 5 });
    const text =
      "one two three four five six seven eight nine ten\n\n" +
      "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const out = c.chunk(text);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Words at the end of chunk 0 should reappear at the head of chunk 1.
    const tailWordsFirst = out[0]!.content.split(/\s+/).slice(-5);
    const secondHead = out[1]!.content.split(/\s+/).slice(0, 8).join(" ");
    const overlap = tailWordsFirst.some((w) => secondHead.includes(w));
    expect(overlap).toBe(true);
  });

  it("overlap=0 produces no shared words between adjacent chunks", () => {
    const c = new RecursiveChunker({ maxTokens: 10, overlapTokens: 0 });
    const text = "alpha bravo charlie delta echo foxtrot\n\ngolf hotel india juliet kilo lima";
    const out = c.chunk(text);
    expect(out.length).toBeGreaterThanOrEqual(2);
    const w0 = new Set(out[0]!.content.split(/\s+/));
    for (const w of out[1]!.content.split(/\s+/)) {
      expect(w0.has(w)).toBe(false);
    }
  });

  it("preserves total content roughly (no silent data loss)", () => {
    const c = new RecursiveChunker({ maxTokens: 30, overlapTokens: 0 });
    const original = "The quick brown fox jumps over the lazy dog. ".repeat(10).trim();
    const out = c.chunk(original);
    const reconstructed = out.map((c) => c.content).join(" ");
    // Same set of words (order may shift slightly due to trimming).
    const origWords = new Set(original.toLowerCase().split(/\s+/));
    for (const w of origWords) {
      expect(reconstructed.toLowerCase()).toContain(w);
    }
  });

  it("estimateTokens stays consistent with chunker", () => {
    // Smoke test that our token estimate is sane (≥0, monotonic).
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("one")).toBeGreaterThan(0);
    expect(estimateTokens("one two three")).toBeGreaterThan(estimateTokens("one"));
  });
});
