import type { AgentExecutionContext } from "../agents/execution-context.js";
import type { ToolResult } from "../tools/types.js";

import type { SkillManifest } from "./skill-manifest.schema.js";

/**
 * Interface that every skill module must implement.
 *
 * Skills return the existing `ToolResult` shape unchanged
 * (`{ success, data?, error?, errorCode?, detail? }`). Stop signals
 * (`send-message`, `request-human`) are detected by tool NAME in the
 * reasoning loop, not by a field on the result.
 */
export interface SkillModule {
  execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult>;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  module: SkillModule;
  manifestPath: string;
  /** Absolute path of the skill directory — kept for diagnostics. */
  skillDir: string;
}
