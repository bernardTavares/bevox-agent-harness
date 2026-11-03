import { describe, it, expect } from "vitest";

import type { LLMRequestOptions } from "../../../../src/integration/llm-gateway.js";
import {
  canonicalizeRequest,
  hashRequest,
} from "../../../../src/integration/llm/request-hasher.js";

const MODEL = "gpt-4o-mini";

function opts(partial: Partial<LLMRequestOptions> = {}): LLMRequestOptions {
  return {
    messages: [{ role: "user", content: "hi" }],
    ...partial,
  };
}

describe("request-hasher", () => {
  it("produces a 64-char hex hash", () => {
    const h = hashRequest(opts(), MODEL);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces same hash regardless of key order in messages", () => {
    const a = hashRequest(opts({ messages: [{ role: "user", content: "hi" }] }), MODEL);
    // Hand-craft a re-ordered equivalent (content before role).
    const reordered = JSON.parse('{"content":"hi","role":"user"}') as LLMRequestOptions["messages"][number];
    const b = hashRequest(opts({ messages: [reordered] }), MODEL);
    expect(a).toBe(b);
  });

  it("differs when temperature changes", () => {
    const a = hashRequest(opts({ temperature: 0 }), MODEL);
    const b = hashRequest(opts({ temperature: 0.7 }), MODEL);
    expect(a).not.toBe(b);
  });

  it("treats undefined and absent equally", () => {
    const a = hashRequest(opts({ temperature: undefined }), MODEL);
    const b = hashRequest(opts(), MODEL);
    expect(a).toBe(b);
  });

  it("differs when model changes", () => {
    const a = hashRequest(opts(), MODEL);
    const b = hashRequest(opts(), "gpt-4o");
    expect(a).not.toBe(b);
  });

  it("differs when messages order swaps", () => {
    const a = hashRequest(
      opts({
        messages: [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
        ],
      }),
      MODEL,
    );
    const b = hashRequest(
      opts({
        messages: [
          { role: "user", content: "b" },
          { role: "user", content: "a" },
        ],
      }),
      MODEL,
    );
    expect(a).not.toBe(b);
  });

  it("treats absent tools as empty array", () => {
    const a = hashRequest(opts({ tools: [] }), MODEL);
    const b = hashRequest(opts(), MODEL);
    expect(a).toBe(b);
  });

  it("canonicalizes nested object keys", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const reorderedSchema = JSON.parse(
      '{"properties":{"a":{"type":"string"}},"type":"object"}',
    ) as Record<string, unknown>;
    const a = canonicalizeRequest(opts({ responseSchema: schema }), MODEL);
    const b = canonicalizeRequest(opts({ responseSchema: reorderedSchema }), MODEL);
    expect(a).toBe(b);
  });
});
