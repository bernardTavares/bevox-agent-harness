import type { Job } from 'bullmq'

/** Builds a minimal Job-shaped object suitable for handler tests. */
export function makeFakeJob<T>(data: T, id = 'job_1'): Job<T> {
  return {
    id,
    data,
    name: 'execution.dispatch',
    timestamp: Date.now(),
    attemptsMade: 0,
    opts: {},
    updateProgress: async () => undefined,
    log: async () => 0,
    moveToCompleted: async () => undefined,
    moveToFailed: async () => undefined,
  } as unknown as Job<T>
}
