import { z } from "zod";

import type { LLMGateway } from "../integration/llm-gateway.js";

/**
 * JSON Schema enforced on judge responses (forwarded to LLMGateway via
 * `responseSchema`). Provider adapters use this to coerce structured output.
 */
export const judgeResponseSchema = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string", maxLength: 800 },
  },
  required: ["score", "reasoning"],
  additionalProperties: false,
} as const;

export interface JudgePrompts {
  system: string;
  user: string;
}

export function buildJudgePrompt(args: {
  rubric: string;
  scoringGuide: string;
  input: string;
  output: string;
  contextBlock?: string;
}): JudgePrompts {
  return {
    system:
      `You are an impartial evaluator. ${args.rubric}\n\n${args.scoringGuide}\n\n` +
      "Return ONLY JSON matching the schema {score: number in [0,1], reasoning: string}.",
    user: [
      args.contextBlock ? `<context>\n${args.contextBlock}\n</context>` : null,
      `<user_message>\n${args.input}\n</user_message>`,
      `<agent_response>\n${args.output}\n</agent_response>`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

const parsedJudgeSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
});

export interface JudgeMeta {
  executionId?: string;
  organizationId?: string;
  /** Free-form purpose tag forwarded to LLM telemetry (e.g. "eval:relevancy"). */
  purpose?: string;
}

/**
 * Invokes the gateway with `temperature: 0` + `responseSchema` and parses the
 * response with Zod. Throws on empty or invalid output (caller decides whether
 * to swallow — the EvalRunner does, persistence is skipped).
 */
export async function runJudge(
  gateway: LLMGateway,
  model: string,
  prompts: JudgePrompts,
  meta?: JudgeMeta,
): Promise<{ score: number; reasoning: string; model_used: string }> {
  const response = await gateway.complete({
    messages: [
      { role: "system", content: prompts.system },
      { role: "user", content: prompts.user },
    ],
    responseSchema: judgeResponseSchema as unknown as Record<string, unknown>,
    temperature: 0,
    maxTokens: 500,
    meta,
  });
  if (!response.content) {
    throw new Error("Judge returned empty content");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(response.content);
  } catch (err) {
    throw new Error(`Judge returned non-JSON content: ${(err as Error).message}`);
  }
  const parsed = parsedJudgeSchema.parse(raw);
  return { score: parsed.score, reasoning: parsed.reasoning, model_used: response.model };
}
