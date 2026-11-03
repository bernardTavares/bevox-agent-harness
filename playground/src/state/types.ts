// MIRROR of src/dev/types.ts — keep in sync manually.
// Workspace path aliases are fragile under Vite + tsc -b; we duplicate
// the 70 LOC instead. Any drift is caught by the validation tests
// (tests/unit/dev/types-sync.test.ts).

export type DevEventKind =
  | "execution.started"
  | "execution.completed"
  | "span.finished"
  | "llm.call"
  | "tool.call"
  | "reasoning.step";

export interface ExecutionStartedEvent {
  kind: "execution.started";
  executionId: string;
  accountId: number;
  ts: number;
  payload: unknown;
}

export interface ExecutionCompletedEvent {
  kind: "execution.completed";
  executionId: string;
  ts: number;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface SpanFinishedEvent {
  kind: "span.finished";
  executionId: string;
  name: string;
  ts: number;
  durationMs: number;
  attrs: Record<string, unknown>;
  parentSpanId?: string;
  spanId: string;
}

export interface LLMCallEvent {
  kind: "llm.call";
  executionId: string;
  ts: number;
  provider: string;
  model: string;
  prompt: string;
  response: string;
  tokens: { input: number; output: number };
  latencyMs: number;
  purpose?: string;
}

export interface ToolCallEvent {
  kind: "tool.call";
  executionId: string;
  ts: number;
  tool: string;
  params: unknown;
  result: unknown;
  success: boolean;
  latencyMs: number;
}

export interface ReasoningStepEvent {
  kind: "reasoning.step";
  executionId: string;
  ts: number;
  engine: string;
  stepIndex: number;
  action?: string;
  observation?: string;
}

export type DevEvent =
  | ExecutionStartedEvent
  | ExecutionCompletedEvent
  | SpanFinishedEvent
  | LLMCallEvent
  | ToolCallEvent
  | ReasoningStepEvent;

export interface DevHelloMessage {
  kind: "hello";
  version: number;
  serverTime: number;
}

export type DevWireMessage = DevEvent | DevHelloMessage;

// ---- Derived client-side state types ----

export interface SpanRecord {
  spanId: string;
  parentSpanId?: string;
  name: string;
  ts: number;
  durationMs: number;
  attrs: Record<string, unknown>;
}

export interface LLMCallRecord {
  ts: number;
  provider: string;
  model: string;
  prompt: string;
  response: string;
  tokens: { input: number; output: number };
  latencyMs: number;
  purpose?: string;
}

export interface ToolCallRecord {
  ts: number;
  tool: string;
  params: unknown;
  result: unknown;
  success: boolean;
  latencyMs: number;
}

export interface ExecutionState {
  id: string;
  accountId?: number;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  status: "running" | "ok" | "error";
  spans: SpanRecord[];
  llmCalls: LLMCallRecord[];
  toolCalls: ToolCallRecord[];
  agentName?: string;
  error?: string;
}
