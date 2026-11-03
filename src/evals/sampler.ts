import { z } from "zod";

/**
 * Sampling policies. Validated at boot via `samplingPolicySchema` — invalid
 * JSON in `EVALS_SAMPLING_POLICY` fails fast rather than silently skipping
 * sampling in production.
 */
export const samplingPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("never") }),
  z.object({ type: z.literal("ratio"), rate: z.number().min(0).max(1) }),
  z.object({ type: z.literal("tagged"), tag: z.string().min(1) }),
]);

export type SamplingPolicy = z.infer<typeof samplingPolicySchema>;

export interface SampleContext {
  execution_id: string;
  tags?: string[];
}

export interface SampleDecision {
  sample: boolean;
  /** Human-readable explanation persisted with the eval row. */
  reason: string;
}

export function shouldSample(
  policy: SamplingPolicy,
  ctx: SampleContext,
  rng: () => number = Math.random,
): SampleDecision {
  switch (policy.type) {
    case "always":
      return { sample: true, reason: "policy:always" };
    case "never":
      return { sample: false, reason: "policy:never" };
    case "ratio": {
      const sample = rng() < policy.rate;
      return {
        sample,
        reason: sample ? `policy:ratio:${policy.rate}` : "policy:ratio:miss",
      };
    }
    case "tagged": {
      const sample = ctx.tags?.includes(policy.tag) ?? false;
      return {
        sample,
        reason: sample ? `policy:tagged:${policy.tag}` : "policy:tagged:miss",
      };
    }
  }
}

/**
 * Parses & validates a JSON sampling policy string (typically from
 * EVALS_SAMPLING_POLICY env). Throws on invalid input — call from boot.
 */
export function parseSamplingPolicy(raw: string): SamplingPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`EVALS_SAMPLING_POLICY is not valid JSON: ${(err as Error).message}`);
  }
  return samplingPolicySchema.parse(parsed);
}
