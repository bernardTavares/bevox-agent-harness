import { describe, it, expect, vi } from 'vitest';
import { ContactProfileRepository } from "../../../src/memory/contact-profile.repository.js";

function makePool() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { query, pool: { query } as any };
}

describe('ContactProfileRepository.update — column whitelist', () => {
  it('rejects unknown column keys', async () => {
    const { pool } = makePool();
    const repo = new ContactProfileRepository(pool);
    await expect(
      repo.update(1, BigInt(1), { evilColumn: 'x' } as any)
    ).rejects.toThrow(/unknown column/);
  });

  it('uses parameterized values for malicious-looking input', async () => {
    const { query, pool } = makePool();
    const repo = new ContactProfileRepository(pool);
    await repo.update(1, BigInt(1), { fullName: "'; DROP TABLE--" });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('full_name');
    expect(sql).not.toContain('DROP');
    expect(params).toContain("'; DROP TABLE--");
  });

  it('skips update when no fields are provided', async () => {
    const { query, pool } = makePool();
    const repo = new ContactProfileRepository(pool);
    await repo.update(1, BigInt(1), {});
    expect(query).not.toHaveBeenCalled();
  });
});