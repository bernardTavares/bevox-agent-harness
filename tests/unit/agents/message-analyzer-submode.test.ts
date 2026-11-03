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
    executionId: 'exec-submode-1',
    accountId: 99,
    conversationKey: 'conv-submode-1',
    db: pool,
    logger: pino({ level: 'silent' }),
    llmClient: new FakeLlmClient(),
    accountConfig: { llmModel: 'gpt-4o-mini' },
    messages: [{ direction: 'incoming', content: 'Oi, queria retomar nosso contato.' }],
    ...over
  };
}

describe('MessageAnalyzerAgent – sdrSubMode field (Fase B §2.3)', () => {
  let dbQuery: ReturnType<typeof vi.fn>;
  let pool: Pool;
  let agent: MessageAnalyzerAgent;

  beforeEach(() => {
    dbQuery = vi.fn().mockResolvedValue({ rows: [] });
    pool = { query: dbQuery } as unknown as Pool;
    agent = new MessageAnalyzerAgent(pool);
  });

  it('carries sdrSubMode through to output when LLM emits it', async () => {
    const llm = new FakeLlmClient({
      responses: [{
        content: JSON.stringify({
          sentiment: 'positive',
          sentimentConfidence: 0.85,
          intent: 'reativacao',
          intentConfidence: 0.9,
          topics: ['reengajamento'],
          urgency: 'medium',
          sdrSubMode: 'reativacao'
        }),
        model: 'gpt-4o-mini'
      }]
    });
    const ctx = makeContext({ llmClient: llm, db: pool });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    const out = result.output as Record<string, unknown>;
    expect(out['sdrSubMode']).toBe('reativacao');
  });

  it('output.sdrSubMode is undefined (not present) when LLM omits it — non-breaking', async () => {
    const llm = new FakeLlmClient({
      responses: [{
        content: JSON.stringify({
          sentiment: 'neutral',
          sentimentConfidence: 0.7,
          intent: 'question',
          intentConfidence: 0.8,
          topics: [],
          urgency: 'low'
          // no sdrSubMode
        }),
        model: 'gpt-4o-mini'
      }]
    });
    const ctx = makeContext({ llmClient: llm, db: pool });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    const out = result.output as Record<string, unknown>;
    expect(out['sdrSubMode']).toBeUndefined();
  });

  it('existing fields (intent, sentiment, topics, urgency) are still present alongside sdrSubMode', async () => {
    const llm = new FakeLlmClient({
      responses: [{
        content: JSON.stringify({
          sentiment: 'negative',
          sentimentConfidence: 0.6,
          intent: 'complaint',
          intentConfidence: 0.75,
          topics: ['delay', 'service'],
          urgency: 'high',
          sdrSubMode: 'handoff-iminente'
        }),
        model: 'gpt-4o-mini'
      }]
    });
    const ctx = makeContext({ llmClient: llm, db: pool });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    const out = result.output as Record<string, unknown>;
    expect(out['intent']).toBe('complaint');
    expect(out['sentiment']).toBe('negative');
    expect(out['topics']).toEqual(['delay', 'service']);
    expect(out['urgency']).toBe('high');
    expect(out['sdrSubMode']).toBe('handoff-iminente');
  });
});
