import { describe, it, expect, vi, beforeEach } from 'vitest';
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; logic lives in the skill impl.
import { execute } from "../../../src/skills-builtin/memory/read-profile/read-profile.impl.js";
import { makeToolContext } from "../../helpers/tool-context.js";

describe('read-profile skill execute', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns INVALID_PARAMS when contact_id missing', async () => {
    const result = await execute({}, makeToolContext());
    expect(result.error).toBe('INVALID_PARAMS');
  });

  it('returns null profile and empty facts when contact has no data', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const ctx = makeToolContext({ query });
    const result = await execute({ contact_id: 5 }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ profile: null, facts: [] });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns profile data and facts when present', async () => {
    const now = new Date().toISOString();
    const profileRow = {
      id: 1,
      organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contact_id: '99',
      full_name: 'Alice',
      preferred_name: null,
      birth_date: null,
      gender: null,
      document_number: null,
      phone: null,
      email: null,
      address: null,
      city: null,
      state: null,
      preferred_language: 'pt-BR',
      preferred_contact_channel: null,
      preferred_time_from: null,
      preferred_time_to: null,
      first_seen_at: now,
      last_interaction_at: null,
      total_interactions: 1,
      created_at: now,
      updated_at: now
    };
    const factRow = {
      id: '1',
      organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contact_id: '99',
      fact_key: 'likes',
      fact_value: 'coffee',
      category: null,
      confidence: '0.9',
      source_conversation_key: null,
      source_execution_id: null,
      extracted_at: now,
      confirmed: true,
      superseded_by: null,
      created_at: now,
      updated_at: now
    };
    const query = vi.
    fn().
    mockResolvedValueOnce({ rows: [profileRow] }).
    mockResolvedValueOnce({ rows: [factRow] });
    const ctx = makeToolContext({ query });
    const result = await execute({ contact_id: 99 }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as {profile: {fullName: string;};facts: unknown[];};
    expect(data.profile.fullName).toBe('Alice');
    expect(data.facts).toHaveLength(1);
  });

  it('returns EXTERNAL_ERROR on database failure', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connection refused'));
    const ctx = makeToolContext({ query });
    const result = await execute({ contact_id: 5 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('EXTERNAL_ERROR');
    expect(result.detail).toContain('connection refused');
  });

  it('scopes queries by organization_id and contact_id', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const ctx = makeToolContext({ query, organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b" });
    await execute({ contact_id: 123 }, ctx);
    for (const call of query.mock.calls) {
      const [, params] = call;
      expect((params as unknown[])[0]).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
      expect((params as unknown[])[1]).toBe(BigInt(123));
    }
  });
});