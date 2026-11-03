import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach } from "vitest";

import { SkillLoader } from "../../../src/skills/skill-loader.js";
import { UnifiedToolRegistry } from "../../../src/tools/unified-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// tests/unit/bootstrap -> repo root -> src/skills-builtin
const builtinRoot = path.resolve(__dirname, "..", "..", "..", "src", "skills-builtin");

describe("stage 5 — load-tools-permissions (unified registry)", () => {
  beforeEach(() => UnifiedToolRegistry.resetForTests());

  it("loads all built-in skills into the unified registry (12 tools + 3 sales = 15)", async () => {
    const reg = UnifiedToolRegistry.getInstance();
    const loader = new SkillLoader();
    const skills = await loader.loadFromPath(builtinRoot);
    for (const skill of skills) reg.register(skill);

    expect(reg.list().length).toBe(15);
    // ToolDefinition view parity
    expect(reg.all().length).toBe(15);
    // a representative read tool, mutation tool, and sales skill all resolve
    expect(reg.has("read-calendar")).toBe(true);
    expect(reg.has("create-appointment")).toBe(true);
    expect(reg.has("qualify-opportunity")).toBe(true);
  });

  it("required-tool validation passes for a registered tool and fails for a missing one", async () => {
    const reg = UnifiedToolRegistry.getInstance();
    const loader = new SkillLoader();
    for (const skill of await loader.loadFromPath(builtinRoot)) reg.register(skill);

    // Mimic the stage-5 validation predicate.
    const required = ["read-calendar", "create-appointment"];
    for (const name of required) {
      expect(reg.has(name)).toBe(true);
    }
    expect(reg.has("nonexistent-tool")).toBe(false);
  });
});
