export type SessionStatus = "pending" | "running" | "completed" | "failed";

export interface SessionState {
  executionId: string;
  organizationId: string;
  conversationId: number;
  contactId?: number;
  status: SessionStatus;
  startedAt: string;
  completedAt?: string;
  // Arbitrary metadata modules can attach during the pipeline
  meta?: Record<string, unknown>;
}

// A full session as stored in Redis
export interface Session {
  id: string; // execution_id
  state: SessionState;
  createdAt: string;
  updatedAt: string;
}
