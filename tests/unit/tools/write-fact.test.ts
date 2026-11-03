import { describe, it, expect, vi, beforeEach } from 'vitest';
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; logic lives in the skill impl.
import { execute } from "../../../src/skills-builtin/memory/write-fact/write-fact.impl.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";

const baseFactRow = (overrides: Record<string, unknown> = {}) => {
  const now = new Date().toISOString();
  return {
    id: '1001',
    account_id: 42,
    contact_id: '99',
    fact_key: 'pet_name',
    fact_value: 'Rex',
    category: null,
    confidence: '0.9',
    source_conversation_key: 'conv-test',
    source_execution_id: 'exec-test',
    extracted_at: now,
    confirmed: true,
    superseded_by: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
};

function makeCtxWithClient(clientQuery: ReturnType<typeof vi.fn>): {
  ctx: AgentExecutionContext;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const client = { query: clientQuery, release };
  const db = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn()
  };
  const ctx = {
    executionId: 'exec-test',
    accountId: 42,
    conversationKey: 'conv-test',
    db: db as never,
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {}
    } as never,
    llmClient: { complete: async () => ({ content: '', model: 'fake' }) }
  };
  return { ctx, release };
}

describe('write-fact skill execute', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns INVALID_PARAMS when required field missing', async () => {
    const { ctx } = makeCtxWithClient(vi.fn());
    const r1 = await execute({}, ctx);
    expect(r1.error).toBe('INVALID_PARAMS');

    const r2 = await execute(
      { contact_id: 1, fact_key: 'x', confidence: 0.9 },
      ctx
    );
    expect(r2.error).toBe('INVALID_PARAMS');
  });

  it('skips low-confidence facts (< 0.5)', async () => {
    const clientQuery = vi.fn();
    const { ctx } = makeCtxWithClient(clientQuery);
    const result = await execute(
      { contact_id: 1, fact_key: 'maybe', fact_value: 'unsure', confidence: 0.3 },
      ctx
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ skipped: true, reason: 'LOW_CONFIDENCE' });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('inserts fact and commits when no existing fact', async () => {
    const clientQuery = vi.
    fn()
    // BEGIN
    .mockResolvedValueOnce({ rows: [] })
    // SELECT existing
    .mockResolvedValueOnce({ rows: [] })
    // INSERT new
    .mockResolvedValueOnce({ rows: [baseFactRow()] })
    // COMMIT
    .mockResolvedValueOnce({ rows: [] });
    const { ctx, release } = makeCtxWithClient(clientQuery);
    const result = await execute(
      { contact_id: 99, fact_key: 'pet_name', fact_value: 'Rex', confidence: 0.9 },
      ctx
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ inserted: true, confirmed: true, factId: '1001' });
    expect(clientQuery).toHaveBeenCalledWith('BEGIN');
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('supersedes existing fact when present', async () => {
    const clientQuery = vi.
    fn()
    // BEGIN
    .mockResolvedValueOnce({ rows: [] })
    // SELECT existing returns old fact id
    .mockResolvedValueOnce({ rows: [{ id: '500' }] })
    // INSERT new
    .mockResolvedValueOnce({ rows: [baseFactRow({ id: '1001' })] })
    // UPDATE supersede
    .mockResolvedValueOnce({ rows: [] })
    // COMMIT
    .mockResolvedValueOnce({ rows: [] });
    const { ctx } = makeCtxWithClient(clientQuery);
    const result = await execute(
      { contact_id: 99, fact_key: 'pet_name', fact_value: 'Rex II', confidence: 0.95 },
      ctx
    );
    expect(result.success).toBe(true);
    const supersedeCall = clientQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('superseded_by')
    );
    expect(supersedeCall).toBeDefined();
  });

  it('marks confirmed=false for medium confidence (0.5–0.8)', async () => {
    const clientQuery = vi.
    fn().
    mockResolvedValueOnce({ rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rows: [] }) // SELECT
    .mockResolvedValueOnce({ rows: [baseFactRow({ confidence: '0.6', confirmed: false })] }).
    mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { ctx } = makeCtxWithClient(clientQuery);
    const result = await execute(
      { contact_id: 1, fact_key: 'x', fact_value: 'y', confidence: 0.6 },
      ctx
    );
    expect(result.success).toBe(true);
    expect((result.data as {confirmed: boolean;}).confirmed).toBe(false);
  });

  it('rolls back and returns EXTERNAL_ERROR on insert failure', async () => {
    const clientQuery = vi.
    fn().
    mockResolvedValueOnce({ rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rows: [] }) // SELECT
    .mockRejectedValueOnce(new Error('insert failed')) // INSERT
    .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    const { ctx, release } = makeCtxWithClient(clientQuery);
    const result = await execute(
      { contact_id: 1, fact_key: 'x', fact_value: 'y', confidence: 0.9 },
      ctx
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('EXTERNAL_ERROR');
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});