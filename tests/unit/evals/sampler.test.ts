import { describe, expect, it } from "vitest";

import {
  parseSamplingPolicy,
  shouldSample,
  type SamplingPolicy,
} from "../../../src/evals/sampler.js";

const ctx = { execution_id: "11111111-1111-1111-1111-111111111111" };

describe("shouldSample", () => {
  it("always policy → sample=true", () => {
    expect(shouldSample({ type: "always" }, ctx).sample).toBe(true);
  });

  it("never policy → sample=false", () => {
    expect(shouldSample({ type: "never" }, ctx).sample).toBe(false);
  });

  it("ratio policy: rng < rate → sample", () => {
    const r = shouldSample({ type: "ratio", rate: 0.1 }, ctx, () => 0.05);
    expect(r.sample).toBe(true);
    expect(r.reason).toMatch(/ratio:0.1$/);
  });

  it("ratio policy: rng >= rate → no sample", () => {
    const r = shouldSample({ type: "ratio", rate: 0.1 }, ctx, () => 0.5);
    expect(r.sample).toBe(false);
    expect(r.reason).toBe("policy:ratio:miss");
  });

  it("tagged policy matches", () => {
    expect(
      shouldSample(
        { type: "tagged", tag: "high-risk" },
        { ...ctx, tags: ["high-risk", "vip"] },
      ).sample,
    ).toBe(true);
  });

  it("tagged policy no match", () => {
    expect(
      shouldSample({ type: "tagged", tag: "high-risk" }, ctx).sample,
    ).toBe(false);
  });
});

describe("parseSamplingPolicy", () => {
  it("parses valid always policy", () => {
    expect(parseSamplingPolicy('{"type":"always"}')).toEqual({ type: "always" });
  });

  it("parses valid ratio policy", () => {
    const p = parseSamplingPolicy('{"type":"ratio","rate":0.25}');
    expect(p).toEqual({ type: "ratio", rate: 0.25 });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSamplingPolicy("not json")).toThrow(/not valid JSON/);
  });

  it("throws on unknown policy type", () => {
    expect(() => parseSamplingPolicy('{"type":"bogus"}')).toThrow();
  });

  it("throws on ratio rate out of range", () => {
    expect(() => parseSamplingPolicy('{"type":"ratio","rate":2}')).toThrow();
  });

  it("never type is exhaustively handled", () => {
    const p: SamplingPolicy = { type: "never" };
    expect(shouldSample(p, ctx).sample).toBe(false);
  });
});
