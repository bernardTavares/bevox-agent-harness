import { describe, it, expect } from "vitest";
import { skillManifestSchema } from "../../../src/skills/skill-manifest.schema.js";

const validManifest = {
  name: "qualify-lead",
  version: "1.0.0",
  description: "Qualify a sales lead using ICP criteria and scoring rules.",
  category: "sales",
  agentType: "pipeline",
  parameters: {
    type: "object" as const,
    properties: {
      leadId: { type: "string", description: "The lead identifier" },
    },
    required: ["leadId"],
  },
  permissions: {
    requires: [],
    sideEffects: [],
  },
  entry: "index",
};

describe("skillManifestSchema — sales category", () => {
  it("parses a valid manifest with category 'sales'", () => {
    const result = skillManifestSchema.parse(validManifest);
    expect(result.category).toBe("sales");
  });

  it("rejects an unknown category value", () => {
    const result = skillManifestSchema.safeParse({ ...validManifest, category: "bogus" });
    expect(result.success).toBe(false);
  });
});
