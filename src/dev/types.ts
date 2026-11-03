// Dev-mode event types. Kept deliberately flat/JSON-serializable so the
// WS bridge can JSON.stringify(event) without any custom encoder.
//
// MIRROR: playground/src/state/types.ts must stay in sync (copy-paste).

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
  organizationId: string;
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
