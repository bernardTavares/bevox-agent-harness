import type { Redis } from "ioredis";

import type { Session, SessionState } from "./types.js";

const SESSION_TTL_SECONDS = 86400; // 24 hours

function key(executionId: string): string {
  return `harness:session:${executionId}`;
}

export class SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(executionId: string, state: SessionState): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: executionId,
      state,
      createdAt: now,
      updatedAt: now,
    };
    await this.redis.set(key(executionId), JSON.stringify(session), "EX", SESSION_TTL_SECONDS);
    return session;
  }

  async get(executionId: string): Promise<Session | null> {
    const raw = await this.redis.get(key(executionId));
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  }

  async update(executionId: string, patch: Partial<SessionState>): Promise<Session | null> {
    const existing = await this.get(executionId);
    if (!existing) return null;

    const updated: Session = {
      ...existing,
      state: { ...existing.state, ...patch },
      updatedAt: new Date().toISOString(),
    };
    await this.redis.set(key(executionId), JSON.stringify(updated), "EX", SESSION_TTL_SECONDS);
    return updated;
  }

  async delete(executionId: string): Promise<void> {
    await this.redis.del(key(executionId));
  }
}
