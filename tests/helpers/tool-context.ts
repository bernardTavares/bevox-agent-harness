import { vi } from "vitest";
import type { AgentExecutionContext } from "../../src/agents/execution-context.js";

/**
 * Build a minimal AgentExecutionContext for tool unit tests.
 * The Pool / Logger / LlmClient are all duck-typed — supply the methods
 * actually exercised by the tool under test.
 */
export function makeToolContext(
  overrides: Partial<AgentExecutionContext> & {
    query?: ReturnType<typeof vi.fn>;
    connect?: ReturnType<typeof vi.fn>;
    executionToken?: string;
  } = {},
): AgentExecutionContext & { executionToken?: string } {
  const query = overrides.query ?? vi.fn();
  const connect = overrides.connect;
  const db = (overrides.db ?? { query, connect }) as never;

  const ctx = {
    executionId: overrides.executionId ?? "exec-test",
    organizationId: overrides.organizationId ?? "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    conversationKey: overrides.conversationKey ?? "conv-test",
    contactId: overrides.contactId,
    messageId: overrides.messageId,
    db,
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
        trace: () => {},
        fatal: () => {},
      }),
    } as never,
    llmClient: overrides.llmClient ?? { complete: async () => ({ content: "", model: "fake" }) },
    accountConfig: overrides.accountConfig,
    messages: overrides.messages,
    executionMode: overrides.executionMode,
    executionToken: overrides.executionToken,
  } as AgentExecutionContext & { executionToken?: string };

  return ctx;
}
