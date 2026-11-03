import RedisMock from 'ioredis-mock'
import type Redis from 'ioredis'

/** Returns an in-memory Redis-compatible client (ioredis-mock). */
export function createFakeRedis(): Redis {
  return new RedisMock() as unknown as Redis
}
