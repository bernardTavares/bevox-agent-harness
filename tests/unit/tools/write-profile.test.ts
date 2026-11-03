import { describe, it, expect, vi, beforeEach } from 'vitest';
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; logic lives in the skill impl.
import { execute } from "../../../src/skills-builtin/memory/write-profile/write-profile.impl.js";
import { makeToolContext } from "../../helpers/tool-context.js";

describe('write-profile skill execute', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns INVALID_PARAMS when contact_id missing', async () => {
    const result = await execute(
      { fields: { fullName: 'x' } },
      makeToolContext()
    );
    expect(result.error).toBe('INVALID_PARAMS');
  });

  it('returns INVALID_PARAMS when fields missing', async () => {
    const result = await execute({ contact_id: 1 }, makeToolContext());
    expect(result.error).toBe('INVALID_PARAMS');
  });

  it('updates whitelisted fields', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const ctx = makeToolContext({ query, organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b" });
    const result = await execute(
      { contact_id: 99, fields: { fullName: 'Alice', email: 'a@b.com' } },
      ctx
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ updated: true });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE contact_profiles');
    expect(params[0]).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
    expect(params[1]).toBe(BigInt(99));
  });

  it('rejects unknown column names', async () => {
    const query = vi.fn();
    const ctx = makeToolContext({ query });
    const result = await execute(
      { contact_id: 1, fields: { not_a_column: 'x' } },
      ctx
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('EXTERNAL_ERROR');
    expect(result.detail).toContain('unknown column');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns success without querying when no fields are set', async () => {
    const query = vi.fn();
    const ctx = makeToolContext({ query });
    const result = await execute(
      { contact_id: 1, fields: {} },
      ctx
    );
    // No-op update — repository returns without issuing a query
    expect(result.success).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns EXTERNAL_ERROR on DB failure', async () => {
    const query = vi.fn().mockRejectedValue(new Error('deadlock'));
    const ctx = makeToolContext({ query });
    const result = await execute(
      { contact_id: 1, fields: { fullName: 'X' } },
      ctx
    );
    expect(result.error).toBe('EXTERNAL_ERROR');
    expect(result.detail).toContain('deadlock');
  });
});