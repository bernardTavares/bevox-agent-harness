import { describe, expect, it } from "vitest";

import type { LoadedSkill } from "../../../src/skills/skill-runtime.js";
import type { PermissionContext } from "../../../src/permissions/types.js";
import {
  buildExternalAgentDefinition,
  filterExposedSkills,
  isAllowedAtRuntime,
} from "../../../src/mcp/adapters/permission-filter.js";

type SideEffect = "read" | "write" | "external_call" | "stop_signal";

function makeSkill(
  category: "calendar" | "messaging" | "memory" | "knowledge",
  name: string,
  sideEffects: SideEffect[] = ["read"],
): LoadedSkill {
  return {
    manifest: {
      name,
      version: "1.0.0",
      description: "Test skill xx",
      category,
      agentType: "surface",
      parameters: { type: "object" },
      permissions: { requires: [], sideEffects },
      entry: "index",
    } as LoadedSkill["manifest"],
    module: { execute: async () => ({ success: true }) },
    manifestPath: "",
    skillDir: "",
  };
}

const calRead = makeSkill("calendar", "read-calendar");
const calCreate = makeSkill("calendar", "create-appointment", ["external_call"]);
const memRead = makeSkill("memory", "read-profile");
const memWrite = makeSkill("memory", "write-fact", ["write"]);
const knowFaq = makeSkill("knowledge", "search-faq");
const msgSend = makeSkill("messaging", "send-message", ["external_call", "stop_signal"]);
const msgHuman = makeSkill("messaging", "request-human", ["stop_signal"]);

describe("filterExposedSkills", () => {
  it("fail-closed when patterns are empty", () => {
    expect(
      filterExposedSkills([calRead, memRead, knowFaq], []),
    ).toHaveLength(0);
  });

  it("matches a category glob", () => {
    const out = filterExposedSkills(
      [calRead, calCreate, memRead, knowFaq],
      ["calendar.*"],
    );
    expect(out.map((s) => s.manifest.name).sort()).toEqual(
      ["create-appointment", "read-calendar"].sort(),
    );
  });

  it("matches an exact dotted id", () => {
    const out = filterExposedSkills(
      [calRead, memRead, knowFaq],
      ["memory.read-profile"],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.manifest.name).toBe("read-profile");
  });

  it("supports multiple patterns", () => {
    const out = filterExposedSkills(
      [calRead, memRead, knowFaq],
      ["calendar.*", "knowledge.*"],
    );
    expect(out.map((s) => s.manifest.category).sort()).toEqual([
      "calendar",
      "knowledge",
    ]);
  });

  it("auto-rejects stop_signal skills even when matched", () => {
    const out = filterExposedSkills(
      [msgSend, msgHuman, knowFaq],
      ["messaging.*", "knowledge.*"],
    );
    expect(out.map((s) => s.manifest.name)).toEqual(["search-faq"]);
  });

  it("uses category.name (not bare name) for glob matching", () => {
    // A pattern matching only the bare name should NOT match — convention is dotted.
    expect(filterExposedSkills([knowFaq], ["search-faq"])).toHaveLength(0);
    expect(filterExposedSkills([knowFaq], ["knowledge.search-faq"])).toHaveLength(1);
  });
});

function makeContext(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    executionId: "exec-test",
    agentName: "mcp-external",
    agentType: "surface",
    accountId: 1,
    conversationKey: "conv-test",
    unavailableTools: [],
    accountDeniedTools: [],
    ...overrides,
  };
}

describe("buildExternalAgentDefinition", () => {
  it("denies stop-signal and write-* skills by default", () => {
    const agent = buildExternalAgentDefinition();
    expect(agent.permissions.denied).toEqual(
      expect.arrayContaining([
        "send-message",
        "request-human",
        "write-fact",
        "write-profile",
        "read-profile",
      ]),
    );
  });

  it("merges extra denied names", () => {
    const agent = buildExternalAgentDefinition(["search-faq"]);
    expect(agent.permissions.denied).toContain("search-faq");
  });
});

describe("isAllowedAtRuntime", () => {
  const agent = buildExternalAgentDefinition();

  it("allows safe skills", () => {
    const decision = isAllowedAtRuntime(knowFaq, agent, makeContext());
    expect(decision.allowed).toBe(true);
  });

  it("denies stop-signal skills via static denied list", () => {
    const decision = isAllowedAtRuntime(msgSend, agent, makeContext());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("AGENT_STATIC_DENIED");
  });

  it("denies skills marked unavailable in context", () => {
    const decision = isAllowedAtRuntime(
      calRead,
      agent,
      makeContext({ unavailableTools: ["read-calendar"] }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("TOOL_UNAVAILABLE");
  });

  it("denies skills in account-level deny list", () => {
    const decision = isAllowedAtRuntime(
      calRead,
      agent,
      makeContext({ accountDeniedTools: ["read-calendar"] }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("EXECUTION_CONTEXT_DENIED");
  });
});
