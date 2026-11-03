// PERM-05 (auditoria 2026-06-02): tests for the Layer-2 accountDeniedTools
// derivation from the inbound execution payload. Covers the semantic model
// documented in `src/permissions/permission-context.ts:deriveAccountDeniedTools`
// (explicit blacklist + allowlist negation, deduplicated).

import { describe, it, expect } from "vitest";
import {
  buildPermissionContext,
  deriveAccountDeniedTools,
} from "../../../src/permissions/permission-context.js";
import type { AgentDefinition } from "../../../src/agents/types.js";
import type { ExecutionPayload } from "../../../src/runtime/execution-handler.js";

const agent: AgentDefinition = {
  name: "scheduler",
  type: "surface",
  description: "t",
  reasoning: { default: "react" },
  permissions: { required: [], optional: [], denied: [] },
};

const ORG = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";

function makePayload(overrides: Partial<Record<string, unknown>> = {}): ExecutionPayload {
  return {
    execution_id: "11111111-1111-4111-8111-111111111111",
    execution_token: "a-very-long-token-value-1234567890",
    organization_id: ORG,
    messages: [],
    skills: [],
    account_denied_tools: [],
    ...overrides,
  } as unknown as ExecutionPayload;
}

describe("deriveAccountDeniedTools (PERM-05)", () => {
  describe("legacy / empty inputs", () => {
    it("returns [] when both skills and account_denied_tools are empty", () => {
      const result = deriveAccountDeniedTools(makePayload(), ["a", "b", "c"]);
      expect(result).toEqual([]);
    });

    it("returns [] when payload is missing both fields entirely", () => {
      const payload = {
        execution_id: "x",
        execution_token: "y",
        organization_id: ORG,
        messages: [],
      } as unknown as ExecutionPayload;
      const result = deriveAccountDeniedTools(payload, ["a", "b"]);
      expect(result).toEqual([]);
    });
  });

  describe("explicit blacklist (account_denied_tools)", () => {
    it("uses account_denied_tools as-is when no allowlist is set", () => {
      const result = deriveAccountDeniedTools(
        makePayload({ account_denied_tools: ["send-message", "create-appointment"] }),
        ["a", "b", "c"],
      );
      expect(result).toEqual(["send-message", "create-appointment"]);
    });

    it("deduplicates the explicit blacklist", () => {
      const result = deriveAccountDeniedTools(
        makePayload({ account_denied_tools: ["x", "x", "y", "x"] }),
        ["a"],
      );
      expect(result).toEqual(["x", "y"]);
    });

    it("filters non-string entries defensively", () => {
      const result = deriveAccountDeniedTools(
        makePayload({ account_denied_tools: ["ok", 123, null, "fine"] as unknown as string[] }),
        ["a"],
      );
      expect(result).toEqual(["ok", "fine"]);
    });
  });

  describe("allowlist (skills) → complement", () => {
    it("derives the complement of allowlist vs registry tool names", () => {
      const result = deriveAccountDeniedTools(
        makePayload({ skills: ["read-calendar", "send-message"] }),
        ["read-calendar", "send-message", "create-appointment", "cancel-appointment"],
      );
      expect(result.sort()).toEqual(["cancel-appointment", "create-appointment"].sort());
    });

    it("returns [] when allowlist covers all registered tools", () => {
      const result = deriveAccountDeniedTools(makePayload({ skills: ["a", "b"] }), ["a", "b"]);
      expect(result).toEqual([]);
    });

    it("falls back to explicit blacklist when registry is empty (safe degradation)", () => {
      const result = deriveAccountDeniedTools(
        makePayload({ skills: ["a"], account_denied_tools: ["forbidden"] }),
        [],
      );
      // No allKnownToolNames available → cannot compute complement → only the
      // explicit blacklist applies. Documented "safe degradation" path.
      expect(result).toEqual(["forbidden"]);
    });

    it("falls back to explicit blacklist when registry is undefined", () => {
      const result = deriveAccountDeniedTools(
        makePayload({ skills: ["a"], account_denied_tools: ["forbidden"] }),
        undefined,
      );
      expect(result).toEqual(["forbidden"]);
    });
  });

  describe("union of explicit blacklist + allowlist complement", () => {
    it("merges both, explicit-deny entries appear first, then complement", () => {
      const result = deriveAccountDeniedTools(
        makePayload({
          skills: ["read-calendar"],
          account_denied_tools: ["send-message"],
        }),
        ["read-calendar", "send-message", "create-appointment"],
      );
      // send-message comes first (explicit), then complement entries
      // (create-appointment) — read-calendar is in skills allowlist so excluded.
      expect(result[0]).toBe("send-message");
      expect(result).toContain("create-appointment");
      expect(result).not.toContain("read-calendar");
    });

    it("deduplicates across explicit-deny and complement", () => {
      const result = deriveAccountDeniedTools(
        makePayload({
          skills: ["read-calendar"],
          account_denied_tools: ["send-message"], // also in complement
        }),
        ["read-calendar", "send-message"],
      );
      // send-message appears in both buckets — final result has it once.
      expect(result).toEqual(["send-message"]);
    });
  });
});

describe("buildPermissionContext + PERM-05 derivation", () => {
  it("propagates derived accountDeniedTools when allKnownToolNames is provided", () => {
    const payload = makePayload({ skills: ["read-calendar"], account_denied_tools: [] });
    const ctx = buildPermissionContext({
      agent,
      payload,
      unavailableTools: [],
      allKnownToolNames: ["read-calendar", "send-message", "create-appointment"],
    });
    expect(ctx.accountDeniedTools.sort()).toEqual(["create-appointment", "send-message"].sort());
  });

  it("preserves explicit accountDeniedTools opt (test escape hatch wins over derivation)", () => {
    const payload = makePayload({ skills: ["read-calendar"] });
    const ctx = buildPermissionContext({
      agent,
      payload,
      unavailableTools: [],
      accountDeniedTools: ["explicit-override"],
      allKnownToolNames: ["read-calendar", "send-message"],
    });
    expect(ctx.accountDeniedTools).toEqual(["explicit-override"]);
  });

  it("returns empty accountDeniedTools when both inputs absent (backward compat)", () => {
    const ctx = buildPermissionContext({
      agent,
      payload: makePayload(),
      unavailableTools: [],
    });
    expect(ctx.accountDeniedTools).toEqual([]);
  });

  it("uses payload.account_denied_tools as authoritative blacklist", () => {
    const payload = makePayload({ account_denied_tools: ["forbidden-tool"] });
    const ctx = buildPermissionContext({
      agent,
      payload,
      unavailableTools: [],
      allKnownToolNames: ["forbidden-tool", "ok-tool"],
    });
    expect(ctx.accountDeniedTools).toContain("forbidden-tool");
  });
});
