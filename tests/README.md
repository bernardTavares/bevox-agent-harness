# Tests

Test infrastructure for the Bevox Agent Harness. Structure inspired by Hermes Agent.

## Layout

- `tests/unit/` — fast unit tests; all I/O mocked via fakes.
- `tests/integration/` — Postgres + Redis testcontainers; slower, requires Docker.
- `tests/helpers/` — shared helpers (integration setup, migrations runner).
- `tests/fixtures/` — static fixtures (JSON payloads, sample messages).
- `tests/fakes/` — reusable fakes shaped to the real `src/` interfaces.

## Scripts

- `npm test` — run all tests once.
- `npm run test:watch` — watch mode.
- `npm run test:unit` — unit only.
- `npm run test:integration` — integration (requires Docker).
- `npm run test:coverage` — generate coverage report.

## Status (Phase 2 Part 1)

This is the bootstrap of test infrastructure only. Coverage thresholds are
configured in `vitest.config.ts` but commented out — they will be enforced in
Phase 2 Part 2 once comprehensive coverage exists across the 5 reasoning
engines, 13 tools, and runtime layer.

Seed tests live under `tests/unit/` and validate the harness wiring:
- `tests/unit/permissions/evaluator.test.ts`
- `tests/unit/reasoning/direct.test.ts`
- `tests/unit/tools/search-faq.test.ts`
