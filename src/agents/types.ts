export type AgentType = "pipeline" | "surface";

export interface AgentPermissions {
  required: string[];
  optional?: string[];
  denied: string[];
}

export interface ReasoningConfig {
  default: "direct" | "react" | "plan-execute" | "rewoo";
  escalation?: {
    stepThreshold?: number;
    escalateTo?: "plan-execute" | "rewoo";
    parallelThreshold?: number;
    onFailure?: "reflexion";
  };
}

export interface AgentDefinition {
  name: string;
  type: AgentType;
  description: string;
  reasoning: ReasoningConfig;
  /**
   * Optional declarative workflow id (Sprint C.1).
   *
   * **Precedence:** when both `reasoning` and `workflow` are present,
   * **workflow wins** — the dispatcher routes to the workflow engine and
   * does NOT instantiate a reasoning engine.
   *
   * **Hard fail on missing registration:** if `workflow` references an id
   * not present in `WorkflowRegistry`, dispatch fails fast. There is no
   * silent fallback to reasoning — that would mask configuration errors.
   *
   * Reasoning engines stay intact for agents that do not set this field.
   */
  workflow?: string;
  permissions: AgentPermissions;
}

export interface AgentResult {
  success: boolean;
  output: unknown;
  error?: string;
  modelUsed?: string;
  processingMs?: number;
}
