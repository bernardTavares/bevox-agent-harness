import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    passWithNoTests: true,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/types/**',
        'src/**/*.d.ts',
      ],
      // Coverage thresholds — NOT enforced yet (Phase 2 Part 1 bootstrap only).
      // Phase 2 Part 2 will add comprehensive coverage and re-enable these.
      // Target: lines/functions/statements >=70%, branches >=65%.
      // thresholds: {
      //   lines: 70,
      //   functions: 70,
      //   branches: 65,
      //   statements: 70,
      // },
    },
  },
})
