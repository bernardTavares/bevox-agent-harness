import { describe, it, expect, beforeAll } from "vitest";

import {
  enforceBudget,
  estimateToolTokens,
  COMPRESSIBLE_MARKER,
  DEFAULT_GLOBAL_MAX_TOKENS,
  MIN_PROMPT_TOKENS,
  type ToolForBudget,
} from "../../../src/context/budget-enforcer.js";
import {
  estimateTokens,
  __resetEncoderForTests,
  __awaitEncoderForTests,
} from "../../../src/context/tokenizer.js";

/**
 * CTX-04 note: the tokenizer is now BPE (o200k_base), not `ceil(words*1.3)`.
 * To keep counts STABLE across the whole file we force the encoder ready in
 * `beforeAll` (otherwise an early case could run on the heuristic and a later
 * one on BPE — spec §8 risk 7). Inputs are synthesised by word count for
 * convenience; assertions that matter derive their expected value from
 * `estimateTokens(...)` (self-referential) or assert RELATIONS, never raw
 * magic counts.
 */
beforeAll(async () => {
  __resetEncoderForTests();
  await __awaitEncoderForTests();
});

function makeWords(n: number, prefix = "w"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}

function makeTool(name: string, descWords: number): ToolForBudget {
  return { name, description: makeWords(descWords, "d"), parameters: {} };
}

describe("estimateToolTokens", () => {
  it("counts name + description + serialised parameters", () => {
    const tool: ToolForBudget = {
      name: "qualify-opportunity",
      description: makeWords(10, "d"),
      parameters: { type: "object", properties: { framework: { type: "string" } } },
    };
    const tokens = estimateToolTokens(tool);
    expect(tokens).toBeGreaterThan(0);
    const expected = estimateTokens(
      `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`,
    );
    expect(tokens).toBe(expected);
  });

  it("does not throw on a real-world tool schema with nested objects", () => {
    const tool: ToolForBudget = {
      name: "send-message",
      description: "Sends a message to the contact via WhatsApp",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          template: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    };
    expect(() => estimateToolTokens(tool)).not.toThrow();
  });
});

describe("enforceBudget — under-budget path", () => {
  it("returns prompt unchanged and wasCompressed=false when context fits", () => {
    const systemPrompt = makeWords(50, "p");
    const tools = [makeTool("t1", 5), makeTool("t2", 5)];
    const result = enforceBudget({ systemPrompt, tools, maxContextTokens: 5000 });
    expect(result.wasCompressed).toBe(false);
    expect(result.systemPrompt).toBe(systemPrompt);
    expect(result.finalTokens).toBe(result.originalTokens);
    expect(result.budgetTokens).toBe(5000);
    expect(result.warning).toBeUndefined();
    expect(result.withinBudget).toBe(true); // under budget -> within
  });

  it("falls back to DEFAULT_GLOBAL_MAX_TOKENS when maxContextTokens is undefined", () => {
    const systemPrompt = makeWords(20, "p");
    const result = enforceBudget({ systemPrompt, tools: [] });
    expect(result.budgetTokens).toBe(DEFAULT_GLOBAL_MAX_TOKENS);
    expect(result.wasCompressed).toBe(false);
    expect(result.withinBudget).toBe(true);
  });
});

describe("enforceBudget — over-budget path", () => {
  it("compresses the system prompt when total exceeds the budget", () => {
    const lines: string[] = [];
    for (let i = 0; i < 120; i++) lines.push(makeWords(16, `p${i}_`));
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 400 });
    expect(result.wasCompressed).toBe(true);
    expect(result.systemPrompt.length).toBeLessThan(systemPrompt.length);
    expect(result.finalTokens).toBeLessThan(result.originalTokens);
    expect(result.budgetTokens).toBe(400);
    expect(result.warning).toBeUndefined();
  });

  it("preserves the non-compressible head when COMPRESSIBLE_MARKER is present", () => {
    const head = ["## Doctrine", "Always be helpful.", "Always be honest."].join("\n");
    const tail = Array.from({ length: 800 }, (_, i) => `history line ${i}`).join("\n");
    const systemPrompt = `${head}${COMPRESSIBLE_MARKER}${tail}`;
    const result = enforceBudget({
      systemPrompt,
      tools: [],
      maxContextTokens: estimateTokens(head) + 300,
    });
    expect(result.wasCompressed).toBe(true);
    expect(result.systemPrompt.startsWith(head)).toBe(true);
    expect(result.systemPrompt.length).toBeLessThan(systemPrompt.length);
  });
});

describe("enforceBudget — edge cases", () => {
  it("emits a warning (does NOT abort) when tools alone exceed budget", () => {
    const huge = makeTool("huge-tool", 5000);
    const systemPrompt = makeWords(20, "p");
    const result = enforceBudget({ systemPrompt, tools: [huge], maxContextTokens: 500 });
    expect(result.wasCompressed).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("tool definitions alone");
    expect(result.systemPrompt).toBe(systemPrompt);
    // warning-not-abort ships the FULL prompt above budget -> not within.
    expect(result.withinBudget).toBe(false);
  });

  it("never trims below MIN_PROMPT_TOKENS budget headroom", () => {
    const tool = makeTool("t", 800);
    const toolTokens = estimateToolTokens(tool);
    const budget = toolTokens + Math.floor(MIN_PROMPT_TOKENS / 2);
    const systemPrompt = makeWords(1000, "p");
    const result = enforceBudget({ systemPrompt, tools: [tool], maxContextTokens: budget });
    expect(result.warning).toBeDefined();
    expect(result.systemPrompt).toBe(systemPrompt);
  });

  it("handles empty tools array", () => {
    const systemPrompt = makeWords(50, "p");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 5000 });
    expect(result.wasCompressed).toBe(false);
    expect(result.finalTokens).toBe(estimateTokens(systemPrompt));
  });
});

describe("enforceBudget — withinBudget invariant (CTX-05)", () => {
  it("withinBudget is ALWAYS the tautology (finalTokens <= budgetTokens)", () => {
    // Definition of the field. Exercised across under / warning / compressed.
    const cases = [
      enforceBudget({ systemPrompt: makeWords(20, "p"), tools: [], maxContextTokens: 5000 }),
      enforceBudget({
        systemPrompt: makeWords(20, "p"),
        tools: [makeTool("huge", 5000)],
        maxContextTokens: 500,
      }),
      enforceBudget({
        systemPrompt: Array.from({ length: 120 }, (_, i) => makeWords(16, `p${i}_`)).join("\n"),
        tools: [],
        maxContextTokens: 400,
      }),
    ];
    for (const r of cases) {
      expect(r.withinBudget).toBe(r.finalTokens <= r.budgetTokens);
    }
  });
});

describe("truncatePromptToBudget — convergence (CTX-05)", () => {
  it("converges to withinBudget=true for a compressible no-marker prompt", () => {
    // Many short lines (each << budget) with HIGH length variance: short
    // headers interleaved with long lines. Single-pass line-proportional
    // truncation overshoots here; the convergent loop must re-measure and fit.
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(i % 5 === 0 ? "#" : makeWords(20, `x${i}_`));
    }
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 500 });
    expect(result.wasCompressed).toBe(true);
    expect(result.withinBudget).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("converges to withinBudget=true for a compressible marker prompt", () => {
    const head = ["## Doctrine", "Be helpful."].join("\n");
    const tailLines: string[] = [];
    for (let i = 0; i < 400; i++) {
      tailLines.push(i % 4 === 0 ? "-" : makeWords(18, `h${i}_`));
    }
    const systemPrompt = `${head}${COMPRESSIBLE_MARKER}${tailLines.join("\n")}`;
    const budget = estimateTokens(head) + 250;
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: budget });
    expect(result.wasCompressed).toBe(true);
    expect(result.systemPrompt.startsWith(head)).toBe(true); // head intact
    expect(result.withinBudget).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("REGRESSION: a prompt where single-pass leaves finalTokens > budget now fits", () => {
    // Length variance: a few long lines first, then many short ones.
    // Old single-pass keeps `floor(lines * ratio)` leading lines; because the
    // leading lines are the long ones, the kept slice overshoots the budget.
    // Long-line size (20 words ~= 80 BPE tokens each, 3-line floor ~= 242 < 400)
    // is tuned for the o200k tokenizer (CTX-04): each line stays far below the
    // budget so the convergent loop CAN fit, while single-pass still overshoots
    // (~24 leading lines ~= 991 tokens > 400). See Task 4 drift note.
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(makeWords(20, `long${i}_`));
    for (let i = 0; i < 200; i++) lines.push(makeWords(3, `s${i}_`));
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 400 });
    expect(result.wasCompressed).toBe(true);
    expect(result.withinBudget).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(result.budgetTokens);
  });
});

describe("truncatePromptToBudget — termination (CTX-05)", () => {
  it("terminates with the head floor for a pathological marker prompt (head alone > budget)", () => {
    const head = makeWords(2000, "H"); // head alone far exceeds the budget
    const tail = makeWords(2000, "T");
    const systemPrompt = `${head}${COMPRESSIBLE_MARKER}${tail}`;
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 300 });
    expect(result.wasCompressed).toBe(true);
    // Floor: head returned, tail dropped, marker gone.
    expect(result.systemPrompt).toBe(head);
    expect(result.withinBudget).toBe(false); // floor overflows -> not within
  });

  it("terminates with the 3-line floor for a pathological no-marker prompt", () => {
    // Every individual line is itself bigger than the budget.
    const lines = Array.from({ length: 50 }, (_, i) => makeWords(500, `big${i}_`));
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 200 });
    expect(result.wasCompressed).toBe(true);
    // Floor is 3 leading lines; they still overflow, so not within budget.
    expect(result.systemPrompt.split("\n").length).toBe(3);
    expect(result.withinBudget).toBe(false);
  });

  it("does not spin: bounded by MAX_TRUNCATE_ITERATIONS (returns promptly)", () => {
    // A worst-case convergent prompt; we just assert it returns a finite,
    // sensible result rather than hang (the strict `keep` decrease + the
    // 6-iteration cap both guarantee termination).
    const lines = Array.from({ length: 1000 }, (_, i) =>
      i % 2 === 0 ? "x" : makeWords(30, `v${i}_`),
    );
    const systemPrompt = lines.join("\n");
    const result = enforceBudget({ systemPrompt, tools: [], maxContextTokens: 300 });
    expect(result.wasCompressed).toBe(true);
    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.withinBudget).toBe(result.finalTokens <= result.budgetTokens);
  });
});
