/**
 * Sprint C.2 — Streaming types.
 *
 * Streaming is OPT-IN and BACKWARD-COMPATIBLE: the classic `LLMGateway.complete()`
 * contract is unchanged. Adapters that implement `completeStream()` yield
 * `StreamChunk` events; `StreamPublisher` (per execution) forwards them to
 * Bevox via `POST /executions/{id}/stream-chunk`.
 *
 * Design notes:
 *  - `seq` is a monotonic integer per StreamPublisher. Bevox uses it to
 *    reorder/deduplicate chunks under unreliable networks.
 *  - `payload` shape depends on `type` (see comments below).
 *  - Streaming bypasses retry and circuit breaker decorators by design.
 *    See `docs/adr/013-streaming-bypasses-retry-circuit.md`.
 */

import type { LLMRequestOptions } from "../../llm-gateway.js";

export type StreamChunkType =
  | "token" // delta de texto do LLM
  | "tool_call_start" // LLM começou a emitir tool_call (nome conhecido)
  | "tool_call_delta" // delta de arguments JSON (parcial)
  | "tool_call_complete" // arguments parsed OK
  | "tool_result" // resultado da execução da tool
  | "reasoning_step" // engine avançou um step (ReAct/Plan-Execute)
  | "engine_strategy" // engine escolhido (após escalation)
  | "error" // erro recuperável (não fatal)
  | "done"; // fim do stream

export interface StreamChunk {
  type: StreamChunkType;
  /** Sequence number monotônico por execution — Bevox usa para reordenar/deduplicar. */
  seq: number;
  timestamp: number;
  payload: unknown;
}

/**
 * Per-type payload shapes (documentation only — kept loose at the type level
 * to avoid a discriminated union breaking ad-hoc emission from engines).
 *
 *  token:               { delta: string }
 *  tool_call_start:     { toolCallId: string, name: string }
 *  tool_call_delta:     { toolCallId: string, argsDelta: string }
 *  tool_call_complete:  { toolCallId: string, name: string, args: unknown }
 *  tool_result:         { toolCallId: string, success: boolean, output: unknown, durationMs: number }
 *  reasoning_step:      { strategy: string, stepIndex: number, summary: string }
 *  engine_strategy:     { from: string, to: string, reason: string }
 *  error:               { message: string, recoverable: boolean }
 *  done:                { totalTokens?: number, totalDurationMs: number }
 */

export interface TokenPayload {
  delta: string;
}
export interface ToolCallStartPayload {
  toolCallId: string;
  name: string;
}
export interface ToolCallDeltaPayload {
  toolCallId: string;
  argsDelta: string;
}
export interface ToolCallCompletePayload {
  toolCallId: string;
  name: string;
  args: unknown;
}
export interface ToolResultPayload {
  toolCallId: string;
  success: boolean;
  output: unknown;
  durationMs: number;
}
export interface ReasoningStepPayload {
  strategy: string;
  stepIndex: number;
  summary: string;
}
export interface EngineStrategyPayload {
  from: string;
  to: string;
  reason: string;
}
export interface ErrorPayload {
  message: string;
  recoverable: boolean;
}
export interface DonePayload {
  totalTokens?: number;
  totalDurationMs: number;
}

export interface CompleteStreamOptions extends LLMRequestOptions {
  /** Sinal de abort (timeout, client disconnect). */
  signal?: AbortSignal;
}

/**
 * Optional stream callback passed down through AgentExecutionContext.
 * Reasoning engines call it (when defined) to emit reasoning_step / engine_strategy.
 * The interface is opt-in: undefined = engines preserve existing behavior.
 */
export type StreamCallback = (event: {
  type: "reasoning_step" | "engine_strategy" | "tool_result";
  payload: unknown;
}) => Promise<void>;
