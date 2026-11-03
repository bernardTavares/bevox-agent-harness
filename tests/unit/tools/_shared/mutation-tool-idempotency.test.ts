import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import {
  MutationTool,
  canonicalize,
  type ToolContext,
} from "../../../../src/tools/_shared/mutation-tool.js";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

describe("canonicalize", () => {
  it("orders object keys lexicographically (insertion order irrelevant)", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("orders keys recursively in nested objects", () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe(
      canonicalize({ outer: { a: 2, z: 1 } }),
    );
  });

  it("preserves array order (semantically meaningful)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("serializes primitives and null via JSON.stringify", () => {
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(null)).toBe("null");
  });
});

describe("MutationTool.deriveIdempotencyKey (static, sha256 + params)", () => {
  const ctx: ToolContext = {
    execution_id: "01234567-89ab-7000-8000-000000000001",
    organization_id: "01234567-89ab-7000-8000-000000000002",
    step_index: 3,
  };

  it("produces sha256-hex of `execution_id:step_index:tool_name:canonical(params)`", () => {
    const params = { calendar_id: "cal-1" };
    const expected = sha256Hex(
      `${ctx.execution_id}:3:create-appointment:${canonicalize(params)}`,
    );
    const key = MutationTool.deriveIdempotencyKey(ctx, "create-appointment", params);
    expect(key).toBe(expected);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input → same key", () => {
    const params = { a: 1 };
    expect(MutationTool.deriveIdempotencyKey(ctx, "send-message", params)).toBe(
      MutationTool.deriveIdempotencyKey(ctx, "send-message", params),
    );
  });

  it("param key ORDER is irrelevant (canonicalize)", () => {
    expect(
      MutationTool.deriveIdempotencyKey(ctx, "create-appointment", { b: 1, a: 2 }),
    ).toBe(MutationTool.deriveIdempotencyKey(ctx, "create-appointment", { a: 2, b: 1 }));
  });

  it("DISTINCT params → DISTINCT keys (regression: lost-mutation bug)", () => {
    expect(
      MutationTool.deriveIdempotencyKey(ctx, "create-appointment", { date: "A" }),
    ).not.toBe(MutationTool.deriveIdempotencyKey(ctx, "create-appointment", { date: "B" }));
  });

  it("step_index absent vs 0 → same key (degenerate pin)", () => {
    const withZero: ToolContext = { ...ctx, step_index: 0 };
    const without: ToolContext = {
      execution_id: ctx.execution_id,
      organization_id: ctx.organization_id,
    };
    expect(MutationTool.deriveIdempotencyKey(withZero, "x", {})).toBe(
      MutationTool.deriveIdempotencyKey(without, "x", {}),
    );
  });

  it("matches the backend regex ^[A-Za-z0-9._\\-:/=+]{1,128}$", () => {
    const key = MutationTool.deriveIdempotencyKey(ctx, "x", { a: 1 });
    expect(key).toMatch(/^[A-Za-z0-9._\-:/=+]{1,128}$/);
  });
});

describe("MutationTool.deriveIdempotencyKey — original_execution_id lineage (canon #62/#63)", () => {
  const ROOT = "01234567-89ab-7000-8000-00000000root";
  const ORIGINAL_EXEC = "01234567-89ab-7000-8000-0000000orig0";
  const REPLAY_EXEC = "01234567-89ab-7000-8000-000000replay";

  it("absent original_execution_id → key uses execution_id (byte-identical to today)", () => {
    const ctx: ToolContext = {
      execution_id: ORIGINAL_EXEC,
      organization_id: "org-1",
      step_index: 2,
    };
    const params = { calendar_id: "cal-1", slot: "2026-06-10T14:00Z" };
    // The expected hash is derived from execution_id (the legacy/today path).
    const expected = sha256Hex(`${ORIGINAL_EXEC}:2:create-appointment:${canonicalize(params)}`);
    expect(MutationTool.deriveIdempotencyKey(ctx, "create-appointment", params)).toBe(expected);
  });

  it("staff replay: DIFFERENT execution_id but SAME original_execution_id + same params + same tool → SAME key", () => {
    const params = { calendar_id: "cal-1", slot: "2026-06-10T14:00Z" };
    // Original execution: NO original_execution_id yet — it IS the root, but a
    // replay chains to the root. The root's own key uses its execution_id.
    const originalCtx: ToolContext = {
      execution_id: ROOT,
      organization_id: "org-1",
      step_index: 2,
    };
    // Replay: NEW execution_id, SAME original_execution_id (the root).
    const replayCtx: ToolContext = {
      execution_id: REPLAY_EXEC,
      original_execution_id: ROOT,
      organization_id: "org-1",
      step_index: 2,
    };
    const originalKey = MutationTool.deriveIdempotencyKey(originalCtx, "create-appointment", params);
    const replayKey = MutationTool.deriveIdempotencyKey(replayCtx, "create-appointment", params);
    expect(replayKey).toBe(originalKey);
  });

  it("two contexts with DIFFERENT execution_id but SAME original_execution_id → SAME key (backend dedups)", () => {
    const params = { appointment_id: "appt-9", reason: "staff replay" };
    const ctxA: ToolContext = {
      execution_id: "01234567-89ab-7000-8000-0000000000aa",
      original_execution_id: ROOT,
      organization_id: "org-1",
    };
    const ctxB: ToolContext = {
      execution_id: "01234567-89ab-7000-8000-0000000000bb",
      original_execution_id: ROOT,
      organization_id: "org-1",
    };
    expect(ctxA.execution_id).not.toBe(ctxB.execution_id);
    expect(MutationTool.deriveIdempotencyKey(ctxA, "cancel-appointment", params)).toBe(
      MutationTool.deriveIdempotencyKey(ctxB, "cancel-appointment", params),
    );
  });

  it("original_execution_id present → key IGNORES the (new) execution_id entirely", () => {
    const params = { x: 1 };
    const ctxNewExec: ToolContext = {
      execution_id: REPLAY_EXEC,
      original_execution_id: ROOT,
      organization_id: "org-1",
    };
    // Equivalent legacy context where execution_id == the root (no lineage).
    const ctxRootAsExec: ToolContext = {
      execution_id: ROOT,
      organization_id: "org-1",
    };
    expect(MutationTool.deriveIdempotencyKey(ctxNewExec, "create-appointment", params)).toBe(
      MutationTool.deriveIdempotencyKey(ctxRootAsExec, "create-appointment", params),
    );
  });

  it("DIFFERENT original_execution_id (distinct lineages) → DISTINCT keys", () => {
    const params = { x: 1 };
    const ctxLineageA: ToolContext = {
      execution_id: REPLAY_EXEC,
      original_execution_id: ROOT,
      organization_id: "org-1",
    };
    const ctxLineageB: ToolContext = {
      execution_id: REPLAY_EXEC,
      original_execution_id: "01234567-89ab-7000-8000-000000other0",
      organization_id: "org-1",
    };
    expect(MutationTool.deriveIdempotencyKey(ctxLineageA, "create-appointment", params)).not.toBe(
      MutationTool.deriveIdempotencyKey(ctxLineageB, "create-appointment", params),
    );
  });
});
