/**
 * original_execution_id lineage — inbound payload READ-SIDE.
 *
 * Canon APPROVED (bevox-knowledge #62 harness-proposal + #63 backend-edits).
 *
 * The harness inbound `executionPayloadSchema` uses `.passthrough()`, but
 * `original_execution_id` is declared EXPLICITLY so it is typed and threaded
 * into AgentExecutionContext → wrapMutationTool bridge → ToolContext, where
 * MutationTool.deriveIdempotencyKey consumes it.
 *
 * Contract:
 *   - OPTIONAL: when ABSENT, behavior is byte-identical to today (the field is
 *     simply `undefined`; key derivation falls back to `execution_id`).
 *   - When PRESENT, it MUST be a UUID string.
 *
 * These tests bind to the REAL exported schema (not a mirror) so the field
 * cannot silently drift out of the live contract.
 */
import { describe, it, expect } from "vitest";

import { executionPayloadSchema } from "../../../src/runtime/execution-handler.js";

describe("original_execution_id — inbound payload (canon #62/#63)", () => {
  const validBase = {
    execution_id: "11111111-1111-4111-8111-111111111111",
    execution_token: "x".repeat(40),
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  };

  it("ABSENT → parses, original_execution_id is undefined (byte-identical to today)", () => {
    const r = executionPayloadSchema.safeParse(validBase);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.original_execution_id).toBeUndefined();
  });

  it("PRESENT (valid UUID) → parsed and typed", () => {
    const root = "01234567-89ab-7cde-8f01-23456789abcd";
    const r = executionPayloadSchema.safeParse({
      ...validBase,
      original_execution_id: root,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.original_execution_id).toBe(root);
  });

  it("PRESENT but NOT a UUID → rejected", () => {
    const r = executionPayloadSchema.safeParse({
      ...validBase,
      original_execution_id: "not-a-uuid",
    });
    expect(r.success).toBe(false);
  });

  it("PRESENT but wrong type (number/null) → rejected", () => {
    expect(
      executionPayloadSchema.safeParse({ ...validBase, original_execution_id: 123 }).success,
    ).toBe(false);
    expect(
      executionPayloadSchema.safeParse({ ...validBase, original_execution_id: null }).success,
    ).toBe(false);
  });

  it("a replay payload (NEW execution_id, SAME original_execution_id as root) parses", () => {
    const root = "01234567-89ab-7cde-8f01-23456789abcd";
    const r = executionPayloadSchema.safeParse({
      ...validBase,
      execution_id: "22222222-2222-4222-8222-222222222222", // NEW id
      original_execution_id: root, // SAME root
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.execution_id).toBe("22222222-2222-4222-8222-222222222222");
      expect(r.data.original_execution_id).toBe(root);
      // distinct: a replay has a new execution_id but the same lineage root
      expect(r.data.execution_id).not.toBe(r.data.original_execution_id);
    }
  });
});
