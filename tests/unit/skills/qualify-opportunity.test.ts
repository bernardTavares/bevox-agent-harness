/**
 * Unit tests for qualify-opportunity skill (B.3 — PACT scoring, pure compute).
 *
 * Invariants verified here:
 *  - F5 side-effect-free: ctx.db.query is NEVER called.
 *  - Anti-over-claim: qualified=true requires both Pain AND Authority evidence.
 *  - Returns ToolResult shape (success boolean, data object).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { ToolResult } from "../../../src/tools/types.js";

// --- Module under test ---
import qualifyOpportunity from "../../../src/skills-builtin/sales/qualify-opportunity/index.js";

// ---------------------------------------------------------------------------
// Minimal mock context — db.query must never be called.
// ---------------------------------------------------------------------------

function makeMockContext(): AgentExecutionContext & { db: { query: ReturnType<typeof vi.fn> } } {
  const query = vi.fn().mockRejectedValue(new Error("db.query must not be called in pure-compute skill"));
  return {
    executionId: "test-exec-1",
    accountId: 1,
    contactId: undefined,
    conversationKey: "test-conv",
    messageId: undefined,
    db: { query } as unknown as AgentExecutionContext["db"] & { query: ReturnType<typeof vi.fn> },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as AgentExecutionContext["logger"],
    llmClient: {} as AgentExecutionContext["llmClient"],
  } as unknown as AgentExecutionContext & { db: { query: ReturnType<typeof vi.fn> } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertToolResult(result: unknown): asserts result is ToolResult {
  expect(result).toBeDefined();
  expect(typeof (result as ToolResult).success).toBe("boolean");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("qualify-opportunity skill", () => {
  let ctx: ReturnType<typeof makeMockContext>;

  beforeEach(() => {
    ctx = makeMockContext();
  });

  // --- Module shape ---

  it("exports a default object with an execute function", () => {
    expect(qualifyOpportunity).toBeDefined();
    expect(typeof qualifyOpportunity.execute).toBe("function");
  });

  // --- Case 1: No pain and no authority evidence → NOT qualified ---

  it("returns NOT qualified when no pain and no authority evidence are provided", async () => {
    const result = await qualifyOpportunity.execute(
      {
        pain: null,
        authority: null,
        consequence: null,
        targetProfile: null,
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.qualified).toBe(false);
    expect(Array.isArray(data.missing)).toBe(true);
    const missing = data.missing as string[];
    expect(missing).toContain("pain");
    expect(missing).toContain("authority");
    expect(typeof data.reason).toBe("string");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 2: Only pain provided (no authority) → NOT qualified ---

  it("returns NOT qualified when only pain is present but authority is missing", async () => {
    const result = await qualifyOpportunity.execute(
      {
        pain: {
          description: "Our ramp time is 6 months and we lose 30% of new reps in the first quarter.",
          evidenceType: "prospect_stated",
        },
        authority: null,
        consequence: null,
        targetProfile: null,
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.qualified).toBe(false);
    const missing = data.missing as string[];
    expect(missing).toContain("authority");
    expect(missing).not.toContain("pain"); // pain IS present
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 3: Full PACT evidence → qualified=true with score breakdown ---

  it("returns qualified=true with score breakdown when all four PACT dimensions have evidence", async () => {
    const result = await qualifyOpportunity.execute(
      {
        pain: {
          description: "Our ramp time is 6 months and we lose 30% of new reps in the first quarter.",
          evidenceType: "prospect_stated",
        },
        authority: {
          description: "Contact is VP of Sales and confirmed ownership of the budget line.",
          evidenceType: "economic_buyer",
        },
        consequence: {
          description: "Estimated $2.4M annual revenue lost per rep cohort due to attrition.",
          evidenceType: "quantified_impact",
        },
        targetProfile: {
          icpMatchCount: 5,
          personaMatch: true,
          notes: "SaaS, 200–1000 employees, high-growth signal.",
        },
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.qualified).toBe(true);
    expect(typeof data.score).toBe("number");
    expect(data.score).toBeGreaterThanOrEqual(3); // PACT pass gate: ≥3/4 with P+A
    expect(data.breakdown).toBeDefined();

    const breakdown = data.breakdown as Record<string, unknown>;
    expect(breakdown.pain).toBeDefined();
    expect(breakdown.authority).toBeDefined();
    expect(breakdown.consequence).toBeDefined();
    expect(breakdown.targetProfile).toBeDefined();

    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 4: Pain + Authority only (score=2) does NOT qualify (need ≥3) ---

  it("returns NOT qualified when pain and authority are present but no consequence or target profile (score < 3)", async () => {
    const result = await qualifyOpportunity.execute(
      {
        pain: {
          description: "Sales reps take 8 months to ramp, costing us market share.",
          evidenceType: "prospect_stated",
        },
        authority: {
          description: "Contact named the CFO as economic buyer and scheduled an internal meeting.",
          evidenceType: "named_decision_maker",
        },
        consequence: null,
        targetProfile: null,
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    // score=2 < 3 → fails qualification gate even though P+A are present
    expect(data.qualified).toBe(false);
    expect(typeof data.score).toBe("number");
    expect(data.score).toBe(2);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Invariant: db.query never called regardless of params ---

  it("never calls db.query even with unusual / empty-object params", async () => {
    await qualifyOpportunity.execute({}, ctx);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  it("never calls db.query with null params", async () => {
    await qualifyOpportunity.execute(null, ctx);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Error handling: invalid params → success:false with INVALID_PARAMS ---

  it("returns success:false with INVALID_PARAMS errorCode when params are completely invalid", async () => {
    const result = await qualifyOpportunity.execute("not-an-object", ctx);
    assertToolResult(result);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_PARAMS");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });
});
