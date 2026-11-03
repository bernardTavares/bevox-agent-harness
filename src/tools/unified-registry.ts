import type { LoadedSkill, SkillModule } from "../skills/skill-runtime.js";

import type { ToolDefinition } from "./types.js";

/**
 * Adapt a LoadedSkill (manifest = metadata source) to the ToolDefinition shape
 * the executor consumes. The `execute` binding preserves the skill module's
 * closure — for mutation tools this is the `mutationExecute(...)` closure that
 * implements ADR-006 executeOrPropose.
 */
export function skillToToolDefinition(skill: LoadedSkill): ToolDefinition {
  return {
    name: skill.manifest.name,
    description: skill.manifest.description,
    category: skill.manifest.category,
    agentType: skill.manifest.agentType,
    parameters: skill.manifest.parameters,
    execute: skill.module.execute.bind(skill.module),
  };
}

/**
 * Canonical single registry for tools/skills (SKILLS-05).
 *
 * Stores `LoadedSkill` — the manifest is the single source of metadata.
 * Exposes a `ToolDefinition` view (derived via `skillToToolDefinition`) for the
 * executor hot path, and the raw `LoadedSkill` view for MCP outbound exposure.
 * Replaces the legacy `ToolRegistry` + `SkillRegistry` pair.
 *
 * Singleton, populated during bootstrap stage 5 (built-in skills) and the MCP
 * stage (synthetic `mcp:<server>.<tool>` skills). Use `resetForTests()` instead
 * of the old `(X as any).instance = undefined` hack.
 */
export class UnifiedToolRegistry {
  private static instance: UnifiedToolRegistry | undefined;
  private skills = new Map<string, LoadedSkill>();
  private unavailable = new Set<string>();

  static getInstance(): UnifiedToolRegistry {
    if (!UnifiedToolRegistry.instance) {
      UnifiedToolRegistry.instance = new UnifiedToolRegistry();
    }
    return UnifiedToolRegistry.instance;
  }

  /** Test-only: drop all state and replace the singleton. */
  static resetForTests(): void {
    UnifiedToolRegistry.instance = new UnifiedToolRegistry();
  }

  // --- Primary (manifest-based) registration ---

  register(skill: LoadedSkill): void {
    if (this.skills.has(skill.manifest.name)) {
      throw new Error(`Tool already registered: ${skill.manifest.name}`);
    }
    this.skills.set(skill.manifest.name, skill);
  }

  /**
   * Convenience for tests / call sites that hold a bare `ToolDefinition`.
   * Wraps it into a synthetic `LoadedSkill` whose manifest mirrors the tool
   * metadata, so the unified store stays homogeneous.
   */
  registerToolDefinition(tool: ToolDefinition): void {
    const module: SkillModule = { execute: tool.execute.bind(tool) };
    const skill: LoadedSkill = {
      manifest: {
        name: tool.name,
        version: "0.0.0",
        description: tool.description,
        category: tool.category,
        agentType: tool.agentType,
        parameters: tool.parameters as LoadedSkill["manifest"]["parameters"],
        permissions: { requires: [], sideEffects: [] },
        entry: "index",
      },
      module,
      manifestPath: `synthetic://${tool.name}`,
      skillDir: `synthetic://${tool.name}`,
    };
    this.register(skill);
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  /** LoadedSkill view — consumed by `mcp/server.ts` outbound exposure. */
  list(): LoadedSkill[] {
    return Array.from(this.skills.values());
  }

  // --- ToolDefinition views (executor hot path) ---

  /** Most-called method (handler hot path). */
  all(): ToolDefinition[] {
    return this.list().map((skill) => skillToToolDefinition(skill));
  }

  resolve(name: string): ToolDefinition | undefined {
    const skill = this.skills.get(name);
    return skill ? skillToToolDefinition(skill) : undefined;
  }

  resolveOrThrow(name: string): ToolDefinition {
    const def = this.resolve(name);
    if (!def) {
      throw new Error(`Tool not found: ${name}`);
    }
    return def;
  }

  // --- Availability (preserved from ToolRegistry) ---

  markUnavailable(name: string): void {
    this.unavailable.add(name);
  }

  isAvailable(name: string): boolean {
    return this.skills.has(name) && !this.unavailable.has(name);
  }

  getUnavailableNames(): string[] {
    return Array.from(this.unavailable);
  }
}
