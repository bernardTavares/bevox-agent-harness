// Tool/skill machinery barrel.
//
// Built-in tools are defined as skills under `src/skills-builtin/**` and loaded
// into `UnifiedToolRegistry` at bootstrap stage 5. Mutation business logic lives
// in `src/tools/<cat>/<name>.mutation.ts` and is wired via `mutationExecute()`.
// The legacy `registerAllTools` + per-tool `.tool.ts` wrappers were removed in
// SKILLS-05 (Phase 3).
export { UnifiedToolRegistry, skillToToolDefinition } from "./unified-registry.js";
export type { ToolDefinition, ToolResult, ToolCategory, ToolAgentType } from "./types.js";
