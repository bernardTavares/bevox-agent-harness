import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactProfileRepository } from "../../../src/memory/contact-profile.repository.js";
import type { Pool, PoolClient } from 'pg';

function makePool(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool;
}

function row() {
  return {
    id: 1,
    account_id: 42,
    contact_id: '100',
    full_name: 'Ada',
    preferred_name: null,
    birth_date: null,
    gender: null,
    document_number: null,
    phone: '+1',
    email: 'ada@example.com',
    address: null,
    city: null,
    state: null,
    preferred_language: 'pt-BR',
    preferred_contact_channel: null,
    preferred_time_from: null,
    preferred_time_to: null,
    first_seen_at: '2024-01-01T00:00:00Z',
    last_interaction_at: '2024-01-02T00:00:00Z',
    total_interactions: 3,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  };
}

describe('ContactProfileRepository', () => {
  let query: ReturnType<typeof vi.fn>;
  let pool: Pool;
  let repo: ContactProfileRepository;

  beforeEach(() => {
    query = vi.fn();
    pool = makePool(query);
    repo = new ContactProfileRepository(pool);
  });

  describe('findByContact', () => {
    it('returns mapped row when found', async () => {
      query.mockResolvedValueOnce({ rows: [row()] });
      const profile = await repo.findByContact(42, 100n);
      expect(profile?.fullName).toBe('Ada');
      expect(profile?.contactId).toBe(100n);
      expect(profile?.preferredLanguage).toBe('pt-BR');
      expect(profile?.totalInteractions).toBe(3);
      expect(query.mock.calls[0]?.[1]).toEqual([42, 100n]);
    });

    it('returns null when not found', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      const profile = await repo.findByContact(42, 100n);
      expect(profile).toBeNull();
    });
  });

  describe('findOrCreate', () => {
    it('upserts and returns mapped row', async () => {
      query.mockResolvedValueOnce({ rows: [row()] });
      const profile = await repo.findOrCreate(42, 100n);
      expect(profile.id).toBe(1);
      expect(profile.fullName).toBe('Ada');
      const sql = query.mock.calls[0]?.[0] as string;
      expect(sql).toContain('INSERT INTO contact_profiles');
      expect(sql).toContain('ON CONFLICT');
    });
  });

  describe('update', () => {
    it('builds dynamic SET clause from whitelisted fields', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await repo.update(42, 100n, { fullName: 'Grace', email: 'g@ex.com' });
      const sql = query.mock.calls[0]?.[0] as string;
      const params = query.mock.calls[0]?.[1] as unknown[];
      expect(sql).toContain('full_name = $3');
      expect(sql).toContain('email = $4');
      expect(sql).toContain('updated_at = now()');
      expect(params).toEqual([42, 100n, 'Grace', 'g@ex.com']);
    });

    it('throws on unknown column', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo.update(42, 100n, { ssn: 'x' } as any)
      ).rejects.toThrow(/unknown column/);
      expect(query).not.toHaveBeenCalled();
    });

    it('is a no-op when no defined fields', async () => {
      await repo.update(42, 100n, { fullName: undefined });
      expect(query).not.toHaveBeenCalled();
    });

    it('uses a PoolClient when provided', async () => {
      const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
      const client = { query: clientQuery } as unknown as PoolClient;
      await repo.update(42, 100n, { fullName: 'Grace' }, client);
      expect(clientQuery).toHaveBeenCalledOnce();
      expect(query).not.toHaveBeenCalled();
    });
  });
});