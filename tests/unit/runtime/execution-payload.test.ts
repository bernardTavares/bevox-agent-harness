/**
 * SP-3 Task 4 — live receive contract tenant = organization_id (UUID).
 *
 * ADR-019 (landed canon): organization_id (UUID string) is the SOLE tenant
 * identifier for the harness; legacy INT account_id / account.id is retired.
 *
 * The LIVE receive contract is the handler-local Zod schema
 * `executionPayloadSchema` in src/runtime/execution-handler.ts (NOT the file
 * named like a contract). This test pins:
 *  (a) a payload with a valid organization_id UUID PASSES and carries it;
 *  (b) a legacy account / account_id payload with NO organization_id is REJECTED;
 *  (c) the dead tenant surface (ExecutionPayloadSchema / resolveWorkspaceId)
 *      is removed from src/integration/execution-payload.schema.js while
 *      ExecutionModeSchema / ExecutionMode remain.
 */
import { describe, it, expect } from "vitest";
import {
  executionPayloadSchema,
  parseExecutionPayload,
} from "../../../src/runtime/execution-handler.js";

const VALID_ORG_ID = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";

function base() {
  return {
    execution_id: "11111111-1111-4111-8111-111111111111",
    execution_token: "a-very-long-token-string-1234567890",
    messages: [{ role: "user" as const, content: "hi" }],
  };
}

describe("executionPayloadSchema — tenant = organization_id UUID (ADR-019)", () => {
  it("(a) accepts a payload with a valid organization_id UUID and carries it", () => {
    const parsed = parseExecutionPayload({ ...base(), organization_id: VALID_ORG_ID });
    expect(parsed.organization_id).toBe(VALID_ORG_ID);
  });

  it("(a) organization_id must be a UUID — non-UUID string is rejected", () => {
    const r = executionPayloadSchema.safeParse({ ...base(), organization_id: "not-a-uuid" });
    expect(r.success).toBe(false);
  });

  it("(b) rejects a legacy account/account_id payload with no organization_id", () => {
    const legacy = { ...base(), account: { id: 123 }, account_id: 123 };
    const r = executionPayloadSchema.safeParse(legacy);
    expect(r.success).toBe(false);
  });

  it("(b) rejects a payload with no tenant identifier at all", () => {
    const r = executionPayloadSchema.safeParse(base());
    expect(r.success).toBe(false);
  });
});

describe("integration/execution-payload.schema — dead tenant surface stripped", () => {
  it("(c) ExecutionModeSchema and ExecutionMode-producing schema remain present", async () => {
    const mod = await import("../../../src/integration/execution-payload.schema.js");
    expect(mod).toHaveProperty("ExecutionModeSchema");
    // ExecutionMode is a type — assert the producing schema validates a known value.
    expect(mod.ExecutionModeSchema.safeParse("autonomous_supervised").success).toBe(true);
  });

  it("(c) ExecutionPayloadSchema and resolveWorkspaceId are removed", async () => {
    const mod = await import("../../../src/integration/execution-payload.schema.js");
    expect(mod).not.toHaveProperty("ExecutionPayloadSchema");
    expect(mod).not.toHaveProperty("resolveWorkspaceId");
  });
});

describe("max_cost_usd (J9 optional per-execution ceiling)", () => {
  const ORG = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";
  const withOrg = (over: Record<string, unknown> = {}) => ({
    ...base(),
    organization_id: ORG,
    ...over,
  });

  it("accepts a positive max_cost_usd", () => {
    const parsed = executionPayloadSchema.parse(withOrg({ max_cost_usd: 1.5 }));
    expect(parsed.max_cost_usd).toBe(1.5);
  });

  it("absent → undefined (falls back to env default)", () => {
    const parsed = executionPayloadSchema.parse(withOrg());
    expect(parsed.max_cost_usd).toBeUndefined();
  });

  it("rejects a negative max_cost_usd", () => {
    expect(() => executionPayloadSchema.parse(withOrg({ max_cost_usd: -1 }))).toThrow();
  });

  it("rejects zero (use absence/env=0 for 'no ceiling', not an explicit 0 override)", () => {
    expect(() => executionPayloadSchema.parse(withOrg({ max_cost_usd: 0 }))).toThrow();
  });

  it("rejects an absurd ceiling above the 1000 USD cap", () => {
    expect(() => executionPayloadSchema.parse(withOrg({ max_cost_usd: 5000 }))).toThrow();
  });
});
