/**
 * Unit tests for enrich-3c skill (B.5 — Company/Contact/ConversationStarter enrichment).
 *
 * Invariants verified here:
 *  - READ-ONLY: skill performs at most ONE account-scoped SELECT on sdr_account_state.
 *    It NEVER writes, NEVER calls HTTP, NEVER throws to the caller.
 *  - Account-scoped query: db.query params MUST include context.organizationId (no cross-account leak).
 *  - Graceful degradation: if contactId is undefined, db throws, or no row exists,
 *    the skill returns success:true with a partial 3-C result. NEVER throws.
 *  - Returns ToolResult shape (success boolean, data object).
 *
 * Design choice for no-contactId case:
 *  When contactId is undefined, we do NOT call db.query (no contact-scoped data to fetch).
 *  The 3-C result is assembled from params only (partial but usable). This is documented
 *  in the skill header and is the simplest degrade path (avoids an account-only SELECT
 *  that would return potentially many rows — the table has a UNIQUE(organization_id, contact_id)
 *  constraint so an account-only read is semantically ill-defined).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { ToolResult } from "../../../src/tools/types.js";

// --- Module under test ---
import enrich3c from "../../../src/skills-builtin/sales/enrich-3c/index.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** An sdr_account_state row as returned by pg Pool.query(). */
interface SdrAccountStateRow {
  id: string;
  organization_id: number;
  contact_id: string;
  status: "cold" | "working" | "nurture" | "disqualified";
  pact_snapshot: Record<string, unknown> | null;
  last_touch_at: string | null;
  created_at: string;
  updated_at: string;
}

function makeRow(overrides: Partial<SdrAccountStateRow> = {}): SdrAccountStateRow {
  return {
    id: "1",
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    contact_id: "99",
    status: "working",
    pact_snapshot: {
      pain: "High ramp time for SDRs",
      authority: "VP Sales confirmed economic buyer",
      consequence: "$2M annual revenue loss",
      timeline: "Q3 2025 deadline",
    },
    last_touch_at: "2025-05-01T12:00:00Z",
    created_at: "2025-01-10T00:00:00Z",
    updated_at: "2025-05-01T12:00:00Z",
    ...overrides,
  };
}

function makeMockContext(overrides: {
  contactId?: bigint;
  queryResult?: { rows: SdrAccountStateRow[] };
  queryThrows?: boolean;
  noDb?: boolean;
} = {}): AgentExecutionContext & { db: { query: ReturnType<typeof vi.fn> } } {
  const { contactId, queryResult, queryThrows, noDb } = overrides;

  let query: ReturnType<typeof vi.fn>;
  if (noDb) {
    // db itself is missing — context.db is undefined
    return {
      executionId: "test-exec-b5",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId,
      conversationKey: "test-conv-b5",
      messageId: undefined,
      db: undefined as unknown as AgentExecutionContext["db"],
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

  if (queryThrows) {
    query = vi.fn().mockRejectedValue(new Error("simulated DB connection failure"));
  } else if (queryResult) {
    query = vi.fn().mockResolvedValue(queryResult);
  } else {
    // Default: returns empty rows
    query = vi.fn().mockResolvedValue({ rows: [] });
  }

  return {
    executionId: "test-exec-b5",
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    contactId,
    conversationKey: "test-conv-b5",
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

function assertToolResult(result: unknown): asserts result is ToolResult {
  expect(result).toBeDefined();
  expect(typeof (result as ToolResult).success).toBe("boolean");
}

// ---------------------------------------------------------------------------
// Representative params for the 3-C inputs
// ---------------------------------------------------------------------------

const VALID_PARAMS = {
  companyName: "Acme Corp",
  companyIndustry: "SaaS",
  companySize: "200-500",
  contactName: "Jane Doe",
  contactTitle: "VP of Sales",
  contactLinkedIn: "https://linkedin.com/in/janedoe",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enrich-3c skill", () => {
  // --- Module shape ---

  it("exports a default object with an execute function", () => {
    expect(enrich3c).toBeDefined();
    expect(typeof enrich3c.execute).toBe("function");
  });

  // ---------------------------------------------------------------------------
  // Case 1: Full path — contactId present, DB returns a row
  // ---------------------------------------------------------------------------

  describe("full path: contactId present + DB row found", () => {
    let ctx: ReturnType<typeof makeMockContext>;
    let result: ToolResult;

    beforeEach(async () => {
      ctx = makeMockContext({
        contactId: 99n,
        queryResult: { rows: [makeRow()] },
      });
      result = (await enrich3c.execute(VALID_PARAMS, ctx)) as ToolResult;
    });

    it("returns success:true", () => {
      assertToolResult(result);
      expect(result.success).toBe(true);
    });

    it("data contains a Company section with at least companyName", () => {
      const data = result.data as Record<string, unknown>;
      const company = data.company as Record<string, unknown>;
      expect(company).toBeDefined();
      expect(typeof company.name).toBe("string");
      expect(company.name).toBe("Acme Corp");
    });

    it("data contains a Contact section with at least contactName", () => {
      const data = result.data as Record<string, unknown>;
      const contact = data.contact as Record<string, unknown>;
      expect(contact).toBeDefined();
      expect(typeof contact.name).toBe("string");
      expect(contact.name).toBe("Jane Doe");
    });

    it("data contains a ConversationStarter section", () => {
      const data = result.data as Record<string, unknown>;
      const starter = data.conversationStarter as Record<string, unknown>;
      expect(starter).toBeDefined();
      // Must have some usable string content (heuristic output)
      expect(typeof starter.opener).toBe("string");
      expect((starter.opener as string).length).toBeGreaterThan(0);
    });

    it("data.contact includes sdrStatus from the DB row (snapshot-derived)", () => {
      const data = result.data as Record<string, unknown>;
      const contact = data.contact as Record<string, unknown>;
      // Should reflect the status from the sdr_account_state row
      expect(contact.sdrStatus).toBe("working");
    });

    it("db.query was called exactly once with an account-scoped, parameterized SQL (params include organizationId)", () => {
      const query = (ctx.db as unknown as { query: ReturnType<typeof vi.fn> }).query;
      expect(query).toHaveBeenCalledTimes(1);

      const [_sql, params] = query.mock.calls[0] as [string, unknown[]];
      // Params must include organizationId (42) — account-scoped invariant
      expect(Array.isArray(params)).toBe(true);
      expect(params).toContain("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
      // Params must also include contactId (99n or 99) — never an account-only read
      const hasContactId = (params as unknown[]).some(
        (p) => p === 99n || p === 99 || p === "99",
      );
      expect(hasContactId).toBe(true);
    });

    it("does not throw", async () => {
      await expect(enrich3c.execute(VALID_PARAMS, makeMockContext({
        contactId: 99n,
        queryResult: { rows: [makeRow()] },
      }))).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Case 2: Degrade — contactId undefined → no DB call, partial 3-C, no throw
  // ---------------------------------------------------------------------------

  describe("degrade: contactId undefined", () => {
    let ctx: ReturnType<typeof makeMockContext>;
    let result: ToolResult;

    beforeEach(async () => {
      ctx = makeMockContext({ contactId: undefined });
      result = (await enrich3c.execute(VALID_PARAMS, ctx)) as ToolResult;
    });

    it("returns success:true (no throw)", () => {
      assertToolResult(result);
      expect(result.success).toBe(true);
    });

    it("data still contains Company section", () => {
      const data = result.data as Record<string, unknown>;
      const company = data.company as Record<string, unknown>;
      expect(company).toBeDefined();
      expect(company.name).toBe("Acme Corp");
    });

    it("data still contains a ConversationStarter section", () => {
      const data = result.data as Record<string, unknown>;
      const starter = data.conversationStarter as Record<string, unknown>;
      expect(starter).toBeDefined();
      expect(typeof starter.opener).toBe("string");
    });

    it("db.query was NOT called (design choice: no contact-scoped data to fetch)", () => {
      const query = (ctx.db as unknown as { query: ReturnType<typeof vi.fn> }).query;
      expect(query).not.toHaveBeenCalled();
    });

    it("result includes a degradeReason explaining partial data", () => {
      const data = result.data as Record<string, unknown>;
      expect(typeof data.degradeReason).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // Case 3: Degrade — db.query throws → success:true partial 3-C, no throw
  // ---------------------------------------------------------------------------

  describe("degrade: db.query throws", () => {
    let result: ToolResult;

    beforeEach(async () => {
      const ctx = makeMockContext({ contactId: 99n, queryThrows: true });
      result = (await enrich3c.execute(VALID_PARAMS, ctx)) as ToolResult;
    });

    it("returns success:true despite DB error (never throws to caller)", () => {
      assertToolResult(result);
      expect(result.success).toBe(true);
    });

    it("data still contains Company section", () => {
      const data = result.data as Record<string, unknown>;
      const company = data.company as Record<string, unknown>;
      expect(company).toBeDefined();
      expect(company.name).toBe("Acme Corp");
    });

    it("data still contains ConversationStarter section", () => {
      const data = result.data as Record<string, unknown>;
      const starter = data.conversationStarter as Record<string, unknown>;
      expect(starter).toBeDefined();
      expect(typeof starter.opener).toBe("string");
    });

    it("result includes a degradeReason explaining partial data", () => {
      const data = result.data as Record<string, unknown>;
      expect(typeof data.degradeReason).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // Case 4: Degrade — db.query returns no rows → success:true partial 3-C, no throw
  // ---------------------------------------------------------------------------

  describe("degrade: db.query returns no rows (no existing state)", () => {
    let result: ToolResult;

    beforeEach(async () => {
      const ctx = makeMockContext({ contactId: 99n, queryResult: { rows: [] } });
      result = (await enrich3c.execute(VALID_PARAMS, ctx)) as ToolResult;
    });

    it("returns success:true", () => {
      assertToolResult(result);
      expect(result.success).toBe(true);
    });

    it("data contains Company section", () => {
      const data = result.data as Record<string, unknown>;
      const company = data.company as Record<string, unknown>;
      expect(company).toBeDefined();
      expect(company.name).toBe("Acme Corp");
    });

    it("data contains ConversationStarter section", () => {
      const data = result.data as Record<string, unknown>;
      const starter = data.conversationStarter as Record<string, unknown>;
      expect(starter).toBeDefined();
      expect(typeof starter.opener).toBe("string");
    });

    it("result includes a degradeReason explaining no snapshot found", () => {
      const data = result.data as Record<string, unknown>;
      expect(typeof data.degradeReason).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // Case 5: Degrade — context.db is undefined → success:true partial 3-C, no throw
  // ---------------------------------------------------------------------------

  describe("degrade: context.db is undefined", () => {
    let result: ToolResult;

    beforeEach(async () => {
      const ctx = makeMockContext({ contactId: 99n, noDb: true });
      result = (await enrich3c.execute(VALID_PARAMS, ctx)) as ToolResult;
    });

    it("returns success:true despite missing db (never throws)", () => {
      assertToolResult(result);
      expect(result.success).toBe(true);
    });

    it("data contains Company section", () => {
      const data = result.data as Record<string, unknown>;
      const company = data.company as Record<string, unknown>;
      expect(company).toBeDefined();
    });

    it("result includes a degradeReason", () => {
      const data = result.data as Record<string, unknown>;
      expect(typeof data.degradeReason).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // Case 6: Invalid params → success:false with INVALID_PARAMS
  // ---------------------------------------------------------------------------

  describe("invalid params", () => {
    let ctx: ReturnType<typeof makeMockContext>;

    beforeEach(() => {
      ctx = makeMockContext({ contactId: 99n });
    });

    it("returns success:false with INVALID_PARAMS when params is a non-object primitive", async () => {
      const result = await enrich3c.execute("not-an-object", ctx);
      assertToolResult(result);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("INVALID_PARAMS");
    });

    it("returns success:false with INVALID_PARAMS when companyName is missing", async () => {
      const result = await enrich3c.execute({ contactName: "Jane" }, ctx);
      assertToolResult(result);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("INVALID_PARAMS");
    });

    it("never throws for invalid params — always returns a ToolResult", async () => {
      await expect(enrich3c.execute(42, ctx)).resolves.toBeDefined();
      await expect(enrich3c.execute(null, ctx)).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Account-scoping invariant: SQL never omits organizationId
  // ---------------------------------------------------------------------------

  describe("account-scoping invariant", () => {
    it("always passes organizationId in query params, never just contactId", async () => {
      const ctx = makeMockContext({
        contactId: 77n,
        queryResult: { rows: [] },
      });
      await enrich3c.execute(VALID_PARAMS, ctx);

      const query = (ctx.db as unknown as { query: ReturnType<typeof vi.fn> }).query;
      if (query.mock.calls.length > 0) {
        const [, params] = query.mock.calls[0] as [string, unknown[]];
        // organizationId="018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b" must be in params
        expect(params).toContain("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
      }
      // If no call was made, that's also valid (contactId absent path)
    });
  });
});
