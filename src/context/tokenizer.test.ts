import { describe, it, expect } from "vitest";

import { estimateTokens } from "./tokenizer.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns a positive integer for non-empty text", () => {
    const result = estimateTokens("Hello, world!");
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("longer text produces more tokens than shorter text", () => {
    const short = estimateTokens("Hello");
    const long = estimateTokens("Hello, this is a much longer sentence with many words.");
    expect(long).toBeGreaterThan(short);
  });

  it("estimates are consistent (same input = same output)", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  it("handles multiline system prompt sections", () => {
    const section = `## Ficha do contato\n- Nome: Joao Carlos\n- Telefone: (11) 99999-1234\n- Ultima interacao: 2026-04-03`;
    const result = estimateTokens(section);
    // Rough sanity: 4 lines, ~10 tokens each
    expect(result).toBeGreaterThan(10);
    expect(result).toBeLessThan(200);
  });
});
