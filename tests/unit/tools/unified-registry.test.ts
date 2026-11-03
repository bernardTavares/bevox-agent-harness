import { describe, it, expect, beforeEach } from "vitest";

import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import type { LoadedSkill } from "../../../src/skills/skill-runtime.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";
import type { ToolDefinition, ToolResult } from "../../../src/tools/types.js";

function makeSkill(name: string): LoadedSkill {
  return {
    manifest: {
      name,
      version: "1.0.0",
      description: `${name} test skill description.`,
      category: "knowledge",
      agentType: "surface",
      parameters: { type: "object", properties: {}, required: [] },
      permissions: { requires: [], sideEffects: [] },
      entry: "index",
    },
    module: {
      async execute(_params: unknown, _ctx: AgentExecutionContext): Promise<ToolResult> {
        return { success: true, data: { ran: name } };
      },
    },
    manifestPath: `/fake/${name}/manifest.yaml`,
    skillDir: `/fake/${name}`,
  };
}

function makeToolDef(name: string): ToolDefinition {
  return {
    name,
    description: `${name} bare tool`,
    category: "messaging",
    agentType: "surface",
    parameters: {},
    async execute(): Promise<ToolResult> {
      return { success: true, data: { bare: name } };
    },
  };
}

describe("UnifiedToolRegistry", () => {
  beforeEach(() => UnifiedToolRegistry.resetForTests());

  it("registers a LoadedSkill and resolves it both ways", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("search-faq"));
    expect(reg.has("search-faq")).toBe(true);
    expect(reg.get("search-faq")?.manifest.name).toBe("search-faq");
    expect(reg.list().length).toBe(1);
    const def = reg.resolve("search-faq");
    expect(def?.name).toBe("search-faq");
    expect(def?.description).toBe("search-faq test skill description.");
  });

  it("all() returns ToolDefinition[] with a callable execute()", async () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("a"));
    reg.register(makeSkill("b"));
    const all = reg.all();
    expect(all.map((t) => t.name).sort()).toEqual(["a", "b"]);
    const res = await all[0].execute({}, {} as AgentExecutionContext);
    expect(res.success).toBe(true);
  });

  it("list().length === all().length (view parity)", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("x"));
    reg.register(makeSkill("y"));
    reg.register(makeSkill("z"));
    expect(reg.list().length).toBe(reg.all().length);
  });

  it("rejects duplicate registration", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("dup"));
    expect(() => reg.register(makeSkill("dup"))).toThrow(/already registered/i);
  });

  it("registerToolDefinition wraps a bare ToolDefinition", async () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.registerToolDefinition(makeToolDef("send-message"));
    expect(reg.has("send-message")).toBe(true);
    const def = reg.resolve("send-message");
    expect(def?.category).toBe("messaging");
    const res = await def!.execute({}, {} as AgentExecutionContext);
    expect((res.data as { bare: string }).bare).toBe("send-message");
  });

  it("tracks availability", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("avail"));
    expect(reg.isAvailable("avail")).toBe(true);
    reg.markUnavailable("avail");
    expect(reg.isAvailable("avail")).toBe(false);
    expect(reg.getUnavailableNames()).toContain("avail");
    expect(reg.isAvailable("missing")).toBe(false);
  });

  it("resolveOrThrow throws for unknown tool", () => {
    const reg = UnifiedToolRegistry.getInstance();
    expect(() => reg.resolveOrThrow("nope")).toThrow(/not found/i);
  });

  it("resetForTests clears state and replaces the singleton", () => {
    const reg = UnifiedToolRegistry.getInstance();
    reg.register(makeSkill("temp"));
    UnifiedToolRegistry.resetForTests();
    expect(UnifiedToolRegistry.getInstance().has("temp")).toBe(false);
  });
});
