import { describe, it, expect } from "vitest";

import {
  extractJsonObject,
  JsonExtractionError,
} from "../../../../../src/agents/pipeline/_shared/extract-json.js";

describe("extractJsonObject", () => {
  it("(a) parses plain JSON", () => {
    const out = extractJsonObject<{ intent: string }>(
      '{"intent":"scheduling","confidence":0.9}',
    );
    expect(out.intent).toBe("scheduling");
  });

  it("(b) parses ```json-fenced JSON", () => {
    const raw = '```json\n{"intent":"scheduling","topics":["appointment"]}\n```';
    const out = extractJsonObject<{ intent: string; topics: string[] }>(raw);
    expect(out.intent).toBe("scheduling");
    expect(out.topics).toEqual(["appointment"]);
  });

  it("(b') parses a bare ``` fence with no language tag", () => {
    const raw = '```\n{"ok":true}\n```';
    const out = extractJsonObject<{ ok: boolean }>(raw);
    expect(out.ok).toBe(true);
  });

  it("(c) parses prose preceding JSON", () => {
    const raw =
      'Sure! Here is the classification you asked for:\n{"intent":"question","urgency":"low"}';
    const out = extractJsonObject<{ intent: string; urgency: string }>(raw);
    expect(out.intent).toBe("question");
    expect(out.urgency).toBe("low");
  });

  it("(d) parses JSON with trailing text after the object", () => {
    const raw =
      '{"intent":"complaint","urgency":"high"}\n\nLet me know if you need anything else.';
    const out = extractJsonObject<{ intent: string; urgency: string }>(raw);
    expect(out.intent).toBe("complaint");
    expect(out.urgency).toBe("high");
  });

  it("(c+d) parses prose + fenced JSON + trailing prose together", () => {
    const raw =
      "Here you go:\n```json\n" +
      '{"intent":"scheduling","nested":{"a":1,"b":[2,3]}}' +
      "\n```\nHope that helps!";
    const out = extractJsonObject<{ intent: string; nested: { a: number; b: number[] } }>(
      raw,
    );
    expect(out.intent).toBe("scheduling");
    expect(out.nested).toEqual({ a: 1, b: [2, 3] });
  });

  it("respects braces inside string literals (does not split on '}' in a string)", () => {
    const raw = '{"note":"a } brace and a { brace inside a string","ok":true}';
    const out = extractJsonObject<{ note: string; ok: boolean }>(raw);
    expect(out.note).toBe("a } brace and a { brace inside a string");
    expect(out.ok).toBe(true);
  });

  it("handles escaped quotes inside strings", () => {
    const raw = '{"q":"she said \\"hi\\" to me"}';
    const out = extractJsonObject<{ q: string }>(raw);
    expect(out.q).toBe('she said "hi" to me');
  });

  it("throws JsonExtractionError on genuinely non-JSON input (no object present)", () => {
    expect(() => extractJsonObject("totally not json, just prose")).toThrow(
      JsonExtractionError,
    );
  });

  it("throws JsonExtractionError (not a silent wrong object) on malformed JSON object", () => {
    // looks like an object but is syntactically broken
    expect(() => extractJsonObject('{"intent": "scheduling", broken')).toThrow(
      JsonExtractionError,
    );
  });

  it("throws on empty / whitespace-only input", () => {
    expect(() => extractJsonObject("   \n  ")).toThrow(JsonExtractionError);
  });

  it("error message is clear and identifies the source as the LLM output", () => {
    let captured: unknown;
    try {
      extractJsonObject("no json here");
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(JsonExtractionError);
    expect((captured as Error).message).toMatch(/JSON/i);
  });
});
