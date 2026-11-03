import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactFactsRepository } from "../../../src/memory/contact-facts.repository.js";
import type { Pool, PoolClient } from 'pg';

function factRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: '10',
    account_id: 42,
    contact_id: '100',
    fact_key: 'favourite_color',
    fact_value: 'blue',
    category: 'preference',
    confidence: '0.9',
    source_conversation_key: 'conv-1',
    source_execution_id: 'exec-1',
    extracted_at: '2024-01-01T00:00:00Z',
    confirmed: true,
    superseded_by: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...over
  };
}

describe('ContactFactsRepository', () => {
  let query: ReturnType<typeof vi.fn>;
  let pool: Pool;
  let repo: ContactFactsRepository;

  beforeEach(() => {
    query = vi.fn();
    pool = { query } as unknown as Pool;
    repo = new ContactFactsRepository(pool);
  });

  it('listActive maps multiple rows', async () => {
    query.mockResolvedValueOnce({
      rows: [
      factRow(),
      factRow({ id: '11', fact_key: 'allergy', fact_value: 'peanuts', confidence: '0.6', confirmed: false })]

    });
    const facts = await repo.listActive(42, 100n);
    expect(facts).toHaveLength(2);
    expect(facts[0]!.factKey).toBe('favourite_color');
    expect(facts[0]!.confidence).toBe(0.9);
    expect(facts[0]!.id).toBe(10n);
    expect(facts[1]!.confidence).toBeCloseTo(0.6);
    expect(facts[1]!.confirmed).toBe(false);
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('superseded_by IS NULL');
  });

  it('insert persists and maps the result, marking confirmed for high confidence', async () => {
    query.mockResolvedValueOnce({ rows: [factRow({ confidence: '0.95', confirmed: true })] });
    const fact = await repo.insert({
      accountId: 42,
      contactId: 100n,
      factKey: 'k',
      factValue: 'v',
      confidence: 0.95
    });
    expect(fact.confirmed).toBe(true);
    const params = query.mock.calls[0]?.[1] as unknown[];
    // params order: account_id, contact_id, fact_key, fact_value, category,
    // confidence, source_conversation_key, source_execution_id, source_agent,
    // confirmed. (Sprint D.3 inserted `source_agent` at position 8.)
    expect(params[8]).toBeNull();
    expect(params[9]).toBe(true); // confirmed param
  });

  it('insert marks confirmed=false for moderate confidence', async () => {
    query.mockResolvedValueOnce({ rows: [factRow({ confidence: '0.6', confirmed: false })] });
    await repo.insert({
      accountId: 42,
      contactId: 100n,
      factKey: 'k',
      factValue: 'v',
      confidence: 0.6
    });
    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(params[9]).toBe(false);
  });

  it('insert uses provided PoolClient', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [factRow()] });
    const client = { query: clientQuery } as unknown as PoolClient;
    await repo.insert(
      { accountId: 42, contactId: 100n, factKey: 'k', factValue: 'v', confidence: 0.9 },
      client
    );
    expect(clientQuery).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
  });

  it('supersede updates the old fact row', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await repo.supersede(10n, 11n);
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('UPDATE contact_facts');
    expect(sql).toContain('superseded_by = $2');
    expect(query.mock.calls[0]?.[1]).toEqual([10n, 11n]);
  });

  it('upsertFact inserts new and supersedes existing when found', async () => {
    const clientQuery = vi.
    fn()
    // find existing
    .mockResolvedValueOnce({ rows: [{ id: '7' }] })
    // insert new
    .mockResolvedValueOnce({ rows: [factRow({ id: '12' })] })
    // supersede call
    .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery } as unknown as PoolClient;

    const result = await repo.upsertFact(
      {
        accountId: 42,
        contactId: 100n,
        factKey: 'favourite_color',
        factValue: 'red',
        confidence: 0.95
      },
      client
    );

    expect(result.id).toBe(12n);
    expect(clientQuery).toHaveBeenCalledTimes(3);
    const supersedeCallParams = clientQuery.mock.calls[2]?.[1] as unknown[];
    expect(supersedeCallParams).toEqual([7n, 12n]);
  });

  it('upsertFact only inserts when no existing fact', async () => {
    const clientQuery = vi.
    fn().
    mockResolvedValueOnce({ rows: [] }).
    mockResolvedValueOnce({ rows: [factRow({ id: '12' })] });
    const client = { query: clientQuery } as unknown as PoolClient;

    await repo.upsertFact(
      { accountId: 42, contactId: 100n, factKey: 'k', factValue: 'v', confidence: 0.9 },
      client
    );
    expect(clientQuery).toHaveBeenCalledTimes(2); // no supersede call
  });

  it('mapRow handles superseded_by present', async () => {
    query.mockResolvedValueOnce({
      rows: [factRow({ superseded_by: '99' })]
    });
    const [fact] = await repo.listActive(42, 100n);
    expect(fact!.supersededBy).toBe(99n);
  });
});