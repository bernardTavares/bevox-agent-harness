import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from "../../../src/session/session-store.js";
import type { SessionState } from "../../../src/session/types.js";
import { createFakeRedis } from "../../fakes/redis.fake.js";

const baseState: SessionState = {
  executionId: 'exec-1',
  accountId: 42,
  conversationId: 7,
  status: 'pending',
  startedAt: new Date('2025-01-01T00:00:00.000Z').toISOString()
};

describe('SessionStore', () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let store: SessionStore;

  beforeEach(async () => {
    redis = createFakeRedis();
    await redis.flushall();
    store = new SessionStore(redis);
  });

  it('create stores session JSON under harness:session:<id>', async () => {
    const session = await store.create('exec-1', baseState);
    expect(session.id).toBe('exec-1');
    expect(session.state).toEqual(baseState);
    expect(session.createdAt).toBeDefined();

    const raw = await redis.get('harness:session:exec-1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.id).toBe('exec-1');
    expect(parsed.state.accountId).toBe(42);
  });

  it('create sets TTL of 86400 seconds', async () => {
    await store.create('exec-1', baseState);
    const ttl = await redis.ttl('harness:session:exec-1');
    expect(ttl).toBeGreaterThan(86000);
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  it('get returns null when not found', async () => {
    const result = await store.get('missing');
    expect(result).toBeNull();
  });

  it('get returns the stored session', async () => {
    await store.create('exec-1', baseState);
    const fetched = await store.get('exec-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.state.accountId).toBe(42);
  });

  it('update merges patch into state and returns updated session', async () => {
    await store.create('exec-1', baseState);
    const updated = await store.update('exec-1', { status: 'completed' });
    expect(updated?.state.status).toBe('completed');
    expect(updated?.state.accountId).toBe(42);
    expect(updated?.updatedAt).toBeDefined();
  });

  it('update returns null when session does not exist', async () => {
    const result = await store.update('missing', { status: 'failed' });
    expect(result).toBeNull();
  });

  it('update preserves other state fields', async () => {
    await store.create('exec-1', baseState);
    await store.update('exec-1', { completedAt: '2025-01-01T01:00:00.000Z' });
    const fetched = await store.get('exec-1');
    expect(fetched?.state.status).toBe('pending');
    expect(fetched?.state.completedAt).toBe('2025-01-01T01:00:00.000Z');
  });

  it('delete removes the session', async () => {
    await store.create('exec-1', baseState);
    await store.delete('exec-1');
    const fetched = await store.get('exec-1');
    expect(fetched).toBeNull();
  });

  it('delete is a no-op when session does not exist', async () => {
    await expect(store.delete('missing')).resolves.toBeUndefined();
  });
});