import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { Pool, PoolClient } from 'pg';
import { MemoryExtractorAgent } from "../../../src/agents/pipeline/memory-extractor.agent.js";
import { FakeLlmClient } from "../../fakes/llm-client.fake.js";
import { ContactProfileRepository } from "../../../src/memory/contact-profile.repository.js";
import { ContactFactsRepository } from "../../../src/memory/contact-facts.repository.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";

function makeContext(over: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    executionId: 'exec-1',
    accountId: 42,
    contactId: 100n,
    conversationKey: 'conv-1',
    db: { query: vi.fn(), connect: vi.fn() } as unknown as Pool,
    logger: pino({ level: 'silent' }),
    llmClient: new FakeLlmClient(),
    accountConfig: { llmModel: 'gpt-4o-mini' },
    messages: [{ direction: 'incoming', content: 'My name is Grace and my email is g@ex.com' }],
    ...over
  };
}

function fakeClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn()
  } as unknown as PoolClient;
}

describe('MemoryExtractorAgent', () => {
  let profileRepo: ContactProfileRepository;
  let factsRepo: ContactFactsRepository;
  let pool: Pool;
  let client: PoolClient;
  let agent: MemoryExtractorAgent;

  beforeEach(() => {
    profileRepo = {
      findOrCreate: vi.fn().mockResolvedValue({
        id: 1,
        accountId: 42,
        contactId: 100n,
        fullName: null,
        phone: null,
        email: null
      }),
      update: vi.fn().mockResolvedValue(undefined)
    } as unknown as ContactProfileRepository;

    factsRepo = {
      listActive: vi.fn().mockResolvedValue([]),
      upsertFact: vi.fn().mockResolvedValue({ id: 1n })
    } as unknown as ContactFactsRepository;

    client = fakeClient();
    pool = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client)
    } as unknown as Pool;

    agent = new MemoryExtractorAgent(pool, profileRepo, factsRepo);
  });

  it('exposes correct AgentDefinition', () => {
    expect(agent.name).toBe('memory-extractor');
    expect(agent.type).toBe('pipeline');
  });

  it('skips when no contactId', async () => {
    const ctx = makeContext({ contactId: undefined });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect((result.output as {skipped: boolean;}).skipped).toBe(true);
  });

  it('skips when no incoming text', async () => {
    const ctx = makeContext({
      messages: [{ direction: 'outgoing', content: 'agent reply' }]
    });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect((result.output as {skipped: boolean;}).skipped).toBe(true);
  });

  it('returns success with empty extracted when LLM returns nothingFound', async () => {
    const llm = new FakeLlmClient({
      responses: [
      { content: JSON.stringify({ extracted: [], nothingFound: true }), model: 'fake' }]

    });
    const ctx = makeContext({ llmClient: llm });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect((result.output as {extracted: unknown[];}).extracted).toEqual([]);
  });

  it('discards low-confidence items', async () => {
    const llm = new FakeLlmClient({
      responses: [
      {
        content: JSON.stringify({
          extracted: [{ type: 'fixed', key: 'full_name', value: 'Grace', confidence: 0.2 }],
          nothingFound: false
        }),
        model: 'fake'
      }]

    });
    const ctx = makeContext({ llmClient: llm });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect((result.output as {lowConfidenceDiscarded: number;}).lowConfidenceDiscarded).toBe(1);
  });

  it('writes fixed fields via profileRepo.update', async () => {
    const llm = new FakeLlmClient({
      responses: [
      {
        content: JSON.stringify({
          extracted: [
          { type: 'fixed', key: 'full_name', value: 'Grace', confidence: 0.9 },
          { type: 'fixed', key: 'email', value: 'g@ex.com', confidence: 0.95 }],

          nothingFound: false
        }),
        model: 'fake'
      }]

    });
    const ctx = makeContext({ llmClient: llm });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect(profileRepo.update).toHaveBeenCalledOnce();
    const callArgs = (profileRepo.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[2]).toEqual({ fullName: 'Grace', email: 'g@ex.com' });
  });

  it('writes dynamic facts via factsRepo.upsertFact', async () => {
    const llm = new FakeLlmClient({
      responses: [
      {
        content: JSON.stringify({
          extracted: [
          {
            type: 'dynamic',
            key: 'favourite_color',
            value: 'blue',
            category: 'preference',
            confidence: 0.85
          }],

          nothingFound: false
        }),
        model: 'fake'
      }]

    });
    const ctx = makeContext({ llmClient: llm });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect(factsRepo.upsertFact).toHaveBeenCalledOnce();
  });

  it('runs transactional BEGIN / COMMIT and acquires advisory lock', async () => {
    const llm = new FakeLlmClient({
      responses: [
      {
        content: JSON.stringify({
          extracted: [
          { type: 'dynamic', key: 'k', value: 'v', confidence: 0.9 }],

          nothingFound: false
        }),
        model: 'fake'
      }]

    });
    const ctx = makeContext({ llmClient: llm });
    await agent.execute(ctx);
    const queries = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('COMMIT');
    expect(queries.some((q: string) => q.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back when fact write fails', async () => {
    ;(factsRepo.upsertFact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const llm = new FakeLlmClient({
      responses: [
      {
        content: JSON.stringify({
          extracted: [{ type: 'dynamic', key: 'k', value: 'v', confidence: 0.9 }],
          nothingFound: false
        }),
        model: 'fake'
      }]

    });
    const ctx = makeContext({ llmClient: llm });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Write failed/);
    const queries = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(queries).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('returns failure when LLM throws', async () => {
    const llm = new FakeLlmClient({ responses: [new Error('llm bad')] });
    const ctx = makeContext({ llmClient: llm });
    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/llm bad/);
  });
});