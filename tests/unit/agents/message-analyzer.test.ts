import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { Pool } from 'pg';
import { MessageAnalyzerAgent } from "../../../src/agents/pipeline/message-analyzer.agent.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";

function makeContext(over: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const pool = { query } as unknown as Pool;
  return {
    executionId: 'exec-1',
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    conversationKey: 'conv-1',
    db: pool,
    logger: pino({ level: 'silent' }),
    llmClient: new FakeLlmClient(),
    accountConfig: { llmModel: 'gpt-4o-mini' },
    messages: [
    { direction: 'incoming', content: 'Hello, can I book?' }],

    ...over
  };
}

describe('MessageAnalyzerAgent', () => {
  let agent: MessageAnalyzerAgent;
  let dbQuery: ReturnType<typeof vi.fn>;
  let pool: Pool;

  beforeEach(() => {
    dbQuery = vi.fn().mockResolvedValue({ rows: [] });
    pool = { query: dbQuery } as unknown as Pool;
    agent = new MessageAnalyzerAgent(pool);
  });

  it('exposes correct AgentDefinition', () => {
    expect(agent.name).toBe('message-analyzer');
    expect(agent.type).toBe('pipeline');
    expect(agent.definition.reasoning.default).toBe('direct');
  });

  it('returns success with null output when no incoming text', async () => {
    const ctx = makeContext({ messages: [{ direction: 'outgoing', content: 'hi' }] });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBeNull();
  });

  it('parses LLM output into classification', async () => {
    const llm = new FakeLlmClient({
      responses: [
      {
        content: JSON.stringify({
          sentiment: 'positive',
          sentimentConfidence: 0.9,
          intent: 'scheduling',
          intentConfidence: 0.95,
          topics: ['appointment'],
          urgency: 'medium'
        }),
        model: 'gpt-4o-mini'
      }]

    });
    const ctx = makeContext({ llmClient: llm, db: pool });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    const out = result.output as {intent: string;sentiment: string;};
    expect(out.intent).toBe('scheduling');
    expect(out.sentiment).toBe('positive');
    expect(result.modelUsed).toBe('gpt-4o-mini');
    expect(dbQuery).toHaveBeenCalledOnce();
    const params = dbQuery.mock.calls[0]?.[1] as unknown[];
    expect(params[0]).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b"); // organizationId
  });

  it('parses LLM output wrapped in a ```json markdown fence (a-agents-03)', async () => {
    const inner = JSON.stringify({
      sentiment: 'frustrated',
      sentimentConfidence: 0.7,
      intent: 'complaint',
      intentConfidence: 0.85,
      topics: ['billing'],
      urgency: 'high'
    });
    const llm = new FakeLlmClient({
      responses: [
      {
        content: 'Sure, here is the classification:\n```json\n' + inner + '\n```',
        model: 'gpt-4o-mini'
      }]

    });
    const ctx = makeContext({ llmClient: llm, db: pool });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    const out = result.output as {intent: string;sentiment: string;urgency: string;};
    expect(out.intent).toBe('complaint');
    expect(out.sentiment).toBe('frustrated');
    expect(out.urgency).toBe('high');
    expect(dbQuery).toHaveBeenCalledOnce();
  });

  it('returns success even if persistence fails', async () => {
    dbQuery.mockRejectedValueOnce(new Error('db down'));
    const llm = new FakeLlmClient({
      responses: [
      {
        content: JSON.stringify({
          sentiment: 'neutral',
          sentimentConfidence: 0.8,
          intent: 'question',
          intentConfidence: 0.8,
          topics: [],
          urgency: 'low'
        }),
        model: 'gpt-4o-mini'
      }]

    });
    const ctx = makeContext({ llmClient: llm, db: pool });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
  });

  it('returns success=false on LLM failure', async () => {
    const llm = new FakeLlmClient({ responses: [new Error('LLM exploded')] });
    const ctx = makeContext({ llmClient: llm, db: pool });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/LLM exploded/);
  });

  it('returns success=false on JSON parse error', async () => {
    const llm = new FakeLlmClient({
      responses: [{ content: 'not json', model: 'gpt-4o-mini' }]
    });
    const ctx = makeContext({ llmClient: llm, db: pool });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/LLM call failed/);
  });

  it('only processes incoming messages', async () => {
    const llm = new FakeLlmClient({
      responses: [
      {
        content: JSON.stringify({
          sentiment: 'neutral',
          sentimentConfidence: 0.5,
          intent: 'unknown',
          intentConfidence: 0.5,
          topics: [],
          urgency: 'medium'
        }),
        model: 'fake'
      }]

    });
    const ctx = makeContext({
      llmClient: llm,
      db: pool,
      messages: [
      { direction: 'incoming', content: 'first' },
      { direction: 'outgoing', content: 'IGNORED' },
      { direction: 'incoming', content: 'second' }]

    });
    await agent.execute(ctx);
    const userPrompt = llm.calls[0]?.user ?? '';
    expect(userPrompt).toContain('first');
    expect(userPrompt).toContain('second');
    expect(userPrompt).not.toContain('IGNORED');
  });
});