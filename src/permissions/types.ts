export type PermissionResult =
  | { granted: true; tool: string }
  | { granted: false; tool: string; reason: PermissionDenialReason };

export type PermissionDenialReason =
  | "AGENT_STATIC_DENIED" // In agent definition denied[]
  | "AGENT_TYPE_MISMATCH" // Pipeline agent trying surface-only tool or vice versa
  | "EXECUTION_CONTEXT_DENIED" // Runtime restriction from account/inbox config
  | "TOOL_UNAVAILABLE"; // Tool not registered or marked unavailable

export interface PermissionGrant {
  tool: string;
  agentName: string;
  grantedAt: Date;
  reason: "REQUIRED" | "OPTIONAL";
}

export interface PermissionDenial {
  tool: string;
  agentName: string;
  deniedAt: Date;
  reason: PermissionDenialReason;
}

export interface PermissionContext {
  /**
   * Required for audit logging (links a permission decision back to its
   * dispatch). Phase 3 added this field; default to empty string if a caller
   * cannot supply it (the audit row will still be recorded but un-correlated).
   */
  executionId: string;
  agentName: string;
  agentType: "pipeline" | "surface";
  organizationId: string;
  inboxId?: number;
  conversationKey: string;
  // Runtime overrides: tools forcibly disabled for this execution (e.g. calendar down)
  unavailableTools: string[];
  // Account-level overrides: additional denied tools configured per account
  accountDeniedTools: string[];
}
