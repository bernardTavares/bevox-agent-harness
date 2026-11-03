import { describe, expect, it } from "vitest";

import type { LoadedSkill } from "../../../src/skills/skill-runtime.js";
import {
  mcpToolId,
  skillToMcpTool,
  toolResultToMcpContent,
} from "../../../src/mcp/adapters/skill-to-mcp.js";

function makeSkill(overrides: Partial<LoadedSkill["manifest"]> = {}): LoadedSkill {
  return {
    manifest: {
      name: "search-faq",
      version: "1.0.0",
      description: "Search the FAQ knowledge base.",
      category: "knowledge",
      agentType: "surface",
      parameters: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
      },
      permissions: { requires: [], sideEffects: ["read"] },
      entry: "index",
      ...overrides,
    } as LoadedSkill["manifest"],
    module: { execute: async () => ({ success: true }) },
    manifestPath: "",
    skillDir: "",
  };
}

describe("mcpToolId", () => {
  it("returns category.name", () => {
    expect(mcpToolId(makeSkill())).toBe("knowledge.search-faq");
    expect(
      mcpToolId(
        makeSkill({ category: "calendar", name: "read-calendar" }),
      ),
    ).toBe("calendar.read-calendar");
  });
});

describe("skillToMcpTool", () => {
  it("uses dotted id as the MCP tool name", () => {
    const tool = skillToMcpTool(makeSkill());
    expect(tool.name).toBe("knowledge.search-faq");
  });

  it("propagates description", () => {
    const tool = skillToMcpTool(makeSkill({ description: "Some desc xx" }));
    expect(tool.description).toBe("Some desc xx");
  });

  it("forces draft-07 $schema and preserves parameters", () => {
    const tool = skillToMcpTool(makeSkill());
    expect(tool.inputSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["query"]);
  });
});

describe("toolResultToMcpContent", () => {
  it("wraps successful data as text JSON", () => {
    const out = toolResultToMcpContent({ success: true, data: { hits: 3 } });
    expect(out.isError).toBeUndefined();
    expect(out.content).toHaveLength(1);
    expect(out.content[0].type).toBe("text");
    expect(JSON.parse(out.content[0].text)).toEqual({ hits: 3 });
  });

  it("falls back to empty object for missing data", () => {
    const out = toolResultToMcpContent({ success: true });
    expect(JSON.parse(out.content[0].text)).toEqual({});
  });

  it("marks failures with isError and surfaces controlled fields only", () => {
    const out = toolResultToMcpContent({
      success: false,
      error: "VALIDATION",
      errorCode: "INVALID_PARAMS",
      detail: "missing query",
    });
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed).toEqual({
      error: "VALIDATION",
      errorCode: "INVALID_PARAMS",
      detail: "missing query",
    });
  });
});
