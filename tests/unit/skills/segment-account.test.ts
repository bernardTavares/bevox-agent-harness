/**
 * Unit tests for segment-account skill (B.4 — ABCD segmentation + Dead-End red-flag filter).
 *
 * Invariants verified here:
 *  - F5 side-effect-free: ctx.db.query is NEVER called (pure compute).
 *  - Dead-End gate takes precedence: an account with a hard red-flag is classified
 *    "D" (Dead-End) regardless of how well it fits other ABCD criteria.
 *  - Returns ToolResult shape (success boolean, data object).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { ToolResult } from "../../../src/tools/types.js";

// --- Module under test ---
import segmentAccount from "../../../src/skills-builtin/sales/segment-account/index.js";

// ---------------------------------------------------------------------------
// Minimal mock context — db.query must never be called.
// ---------------------------------------------------------------------------

function makeMockContext(): AgentExecutionContext & { db: { query: ReturnType<typeof vi.fn> } } {
  const query = vi.fn().mockRejectedValue(new Error("db.query must not be called in pure-compute skill"));
  return {
    executionId: "test-exec-b4",
    accountId: 2,
    contactId: undefined,
    conversationKey: "test-conv-b4",
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

describe("segment-account skill", () => {
  let ctx: ReturnType<typeof makeMockContext>;

  beforeEach(() => {
    ctx = makeMockContext();
  });

  // --- Module shape ---

  it("exports a default object with an execute function", () => {
    expect(segmentAccount).toBeDefined();
    expect(typeof segmentAccount.execute).toBe("function");
  });

  // --- Case 1: A-List (strategic/dream account) → segment "A" ---

  it("classifies an account as A when it matches all six ICP dimensions with top-quartile deal size and active growth signals", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 6,
        personaPresent: true,
        personaReachable: true,
        dealSizeQuartile: "top",
        growthSignals: true,
        redFlags: [],
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.segment).toBe("A");
    expect(typeof data.reason).toBe("string");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 2: Bread & Butter sweet-spot → segment "B" ---

  it("classifies an account as B when it matches 4-5 ICP dimensions with mid-range deal size and no red flags", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 4,
        personaPresent: true,
        personaReachable: true,
        dealSizeQuartile: "mid",
        growthSignals: false,
        redFlags: [],
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.segment).toBe("B");
    expect(typeof data.reason).toBe("string");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 3: Compelling-Event trigger (C account) → segment "C" ---

  it("classifies an account as C when it matches 2-3 ICP dimensions with below-median deal size and no red flags", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 2,
        personaPresent: true,
        personaReachable: false,
        dealSizeQuartile: "low",
        growthSignals: false,
        redFlags: [],
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.segment).toBe("C");
    expect(typeof data.reason).toBe("string");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 4: Dead-End gate — B&B traits + hard red-flag → "D" with red-flag named ---
  // CRITICAL: Dead-End gate takes precedence over ABCD scoring.
  // An account that would otherwise be B must become D when a hard red-flag fires.

  it("classifies an account as D (Dead-End) when it has B-level traits but carries a hard red-flag, naming the triggering flag", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 5,           // would normally qualify as B
        personaPresent: true,
        personaReachable: true,
        dealSizeQuartile: "mid",
        growthSignals: false,
        redFlags: ["budget_freeze"],  // hard red-flag → Dead-End regardless
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    // Dead-End gate must override the B classification
    expect(data.segment).toBe("D");
    // The triggering red-flag must be reported
    expect(typeof data.triggeringRedFlag).toBe("string");
    expect(data.triggeringRedFlag).toBe("budget_freeze");
    expect(typeof data.reason).toBe("string");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 5: Zero ICP dimensions (D by poor fit) → segment "D" ---

  it("classifies an account as D when it fails 4+ ICP dimensions with no red flags (poor fit)", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 0,
        personaPresent: false,
        personaReachable: false,
        dealSizeQuartile: "low",
        growthSignals: false,
        redFlags: [],
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.segment).toBe("D");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 6: do_not_contact red-flag on an otherwise A account → "D" ---

  it("classifies an account as D when a do_not_contact red-flag is present even with perfect ICP match", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 6,
        personaPresent: true,
        personaReachable: true,
        dealSizeQuartile: "top",
        growthSignals: true,
        redFlags: ["do_not_contact"],
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.segment).toBe("D");
    expect(data.triggeringRedFlag).toBe("do_not_contact");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 7: competitor_lock_in red-flag on a C account → "D" ---

  it("classifies an account as D when competitor_lock_in red-flag is present regardless of ICP match", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 3,
        personaPresent: true,
        personaReachable: false,
        dealSizeQuartile: "low",
        growthSignals: false,
        redFlags: ["competitor_lock_in"],
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.segment).toBe("D");
    expect(data.triggeringRedFlag).toBe("competitor_lock_in");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 8: icpMatchCount:3, personaPresent:false → D (D-by-poor-fit persona gate) ---
  // DOCSTRING CANONICAL: icpMatchCount ∈ [2,3] with no persona → Dead-End (D), not C.
  // An account with marginal ICP fit but NO reachable persona cannot be prospected.

  it("classifies an account as D when icpMatchCount is 3 but personaPresent is false (no reachable persona — Dead-End by poor fit)", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 3,
        personaPresent: false,
        personaReachable: false,
        dealSizeQuartile: "low",
        growthSignals: false,
        redFlags: [],
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.segment).toBe("D");
    expect(typeof data.reason).toBe("string");
    expect((data.reason as string).toLowerCase()).toMatch(/persona/);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Case 9: icpMatchCount:2, personaPresent:false → D (D-by-poor-fit persona gate) ---

  it("classifies an account as D when icpMatchCount is 2 but personaPresent is false (no reachable persona — Dead-End by poor fit)", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 2,
        personaPresent: false,
        personaReachable: false,
        dealSizeQuartile: "unknown",
        growthSignals: false,
        redFlags: [],
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.segment).toBe("D");
    expect(typeof data.reason).toBe("string");
    expect((data.reason as string).toLowerCase()).toMatch(/persona/);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Regression: icpMatchCount:3, personaPresent:true → still C (unchanged) ---

  it("still classifies as C when icpMatchCount is 3 and personaPresent is true (persona gate must not shadow valid C)", async () => {
    const result = await segmentAccount.execute(
      {
        icpMatchCount: 3,
        personaPresent: true,
        personaReachable: false,
        dealSizeQuartile: "low",
        growthSignals: false,
        redFlags: [],
      },
      ctx,
    );

    assertToolResult(result);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.segment).toBe("C");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Invariant: db.query never called regardless of params ---

  it("never calls db.query even with unusual / empty-object params", async () => {
    await segmentAccount.execute({}, ctx);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  it("never calls db.query with null params", async () => {
    await segmentAccount.execute(null, ctx);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  // --- Error handling: invalid params → success:false with INVALID_PARAMS ---

  it("returns success:false with INVALID_PARAMS errorCode when params are completely invalid (non-object)", async () => {
    const result = await segmentAccount.execute("not-an-object", ctx);
    assertToolResult(result);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_PARAMS");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });
});
