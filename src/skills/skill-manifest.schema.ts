import { z } from "zod";

/**
 * Skill manifest schema (Phase 8 — Pluggable Skills).
 *
 * Each skill in `src/skills-builtin/<category>/<name>/manifest.yaml` is
 * validated against this schema at load time. Skills loaded from
 * `SKILLS_PATH` (opt-in external) are subject to the same validation.
 *
 * NOTE (V1): `permissions.requires` and `permissions.sideEffects` are
 * documentary metadata. They are NOT enforced by the permission evaluator
 * in this phase — current 3-layer enforcement remains based on agent
 * static permissions (denied/agentType) + execution context. See
 * `docs/architecture/skills.md` for the V2 roadmap.
 */

// `parameters` must be a JSON Schema object — validate the minimal shape.
const jsonSchemaParametersShape = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  })
  .passthrough();

// Reject path traversal and absolute paths in `entry`.
const safeEntryName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9._-]+$/i, "entry must be a simple filename, no slashes or ..");

export const skillManifestSchema = z
  .object({
    // Local skills are kebab-case (`read-profile`). MCP-proxied skills carry a
    // `mcp:<server>.<tool>` prefix — the tool segment can be PascalCase or
    // snake_case because real servers expose names like `read_text_file` or
    // `writeFile`. Max 96 chars to fit a 32-char server id + 64-char tool.
    name: z
      .string()
      .max(96)
      .regex(
        /^([a-z][a-z0-9-]*|mcp:[a-z0-9-]+\.[A-Za-z0-9_-]+)$/,
        "name: kebab-case local id OR mcp:<server>.<tool>",
      ),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver MAJOR.MINOR.PATCH"),
    description: z.string().min(10).max(500),
    category: z.enum(["calendar", "messaging", "memory", "knowledge", "sales"]),
    agentType: z.enum(["pipeline", "surface", "both"]),
    parameters: jsonSchemaParametersShape,
    // V1: metadata only — not enforced by evaluator
    permissions: z
      .object({
        requires: z.array(z.string()).default([]),
        sideEffects: z.array(z.enum(["read", "write", "external_call", "stop_signal"])).default([]),
      })
      .default({ requires: [], sideEffects: [] }),
    entry: safeEntryName.default("index"),
  })
  .strict();

export type SkillManifest = z.infer<typeof skillManifestSchema>;
