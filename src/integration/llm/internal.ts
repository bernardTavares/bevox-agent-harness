/**
 * Internal contracts for LLM adapters and decorators.
 *
 * The PUBLIC surface (`LLMGateway`, `LLMRequestOptions`, `LLMResponse`,
 * `LLMMessage`, `LLMTool`, `LLMToolCall`, `LLMProviderError`) lives in
 * `../llm-gateway.ts` and MUST NOT change — every reasoning engine, pipeline
 * agent, and the LlmClientBridge depends on its exact shape.
 */
import type { LLMGateway } from "../llm-gateway.js";

export type Provider = "openai" | "anthropic" | "gemini";

export interface LLMAdapter extends LLMGateway {
  readonly provider: Provider;
  readonly model: string;
  supportsModel(model: string): boolean;
}

export interface LLMDecorator extends LLMGateway {
  readonly wrapped: LLMGateway;
}
