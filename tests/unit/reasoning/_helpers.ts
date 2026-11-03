import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";

export function makeContext(llm: FakeLlmClient = new FakeLlmClient(), opts?: { systemPrompt?: string }): AgentExecutionContext {
  return {
    executionId: 'exec-1',
    accountId: 1,
    conversationKey: 'conv-1',
    db: {} as never,
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} })
    } as never,
    llmClient: llm,
    accountConfig: { llmModel: 'fake-model' },
    systemPrompt: opts?.systemPrompt
  };
}

export function llmJson(obj: unknown) {
  return { content: JSON.stringify(obj), model: 'fake-model', promptTokens: 1, completionTokens: 1 };
}

export function llmText(content: string) {
  return { content, model: 'fake-model', promptTokens: 1, completionTokens: 1 };
}