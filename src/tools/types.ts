import type { AgentExecutionContext } from "../agents/execution-context.js";

export type ToolCategory = "calendar" | "messaging" | "memory" | "knowledge" | "sales";
export type ToolAgentType = "pipeline" | "surface" | "both";

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  agentType: ToolAgentType;
  parameters: Record<string, unknown>; // JSON Schema object
  execute(params: unknown, context: AgentExecutionContext): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  detail?: string;
  errorCode?: "PERMISSION_DENIED" | "NOT_FOUND" | "INVALID_PARAMS" | "EXTERNAL_ERROR" | string;
}

export interface ToolPermission {
  toolName: string;
  granted: boolean;
  reason?: string;
}
