# Harness local smoke tests

Local-only smoke scripts that exercise a real round-trip against the
**local dev stack** brought up by `pnpm docker:up` (Postgres + Redis on
localhost).

## What this is NOT

These scripts do NOT replace the **cluster-level smokes** maintained in the
hub repo `bevox-PRD-consolidation/scripts/smoke/01..16-*.sh`. Those run
against the production Hetzner cluster over SSH. They are operationally
distinct:

| Concern         | Hub smokes (`bevox-PRD-consolidation`)        | Harness smokes (this folder) |
|-----------------|-----------------------------------------------|------------------------------|
| Target          | Hetzner production cluster                    | Local dev (`pnpm docker:up`) |
| Transport       | SSH + curl + docker exec                      | Direct BullMQ enqueue        |
| When to run     | Post-deploy / pre-go-live                     | Pre-PR / dev sanity          |
| Failure cost    | Touches prod state                            | Isolated to local Redis      |

## Prerequisites

1. Local dev infra running:
   ```bash
   pnpm docker:up
   ```
2. Harness worker running in another terminal (it consumes the queue):
   ```bash
   fnm exec --using=v22.22.2 pnpm dev
   ```
   Without the worker, smoke 01 will time out (exit code 2).

## Available scripts

| ID | Script                            | What it checks                                                |
|----|-----------------------------------|---------------------------------------------------------------|
| 01 | `01-execution-roundtrip.sh`       | enqueue → worker consumes → `job.getState() === "completed"`  |

## Usage

```bash
./scripts/smoke/01-execution-roundtrip.sh
```

Exit codes propagate from the underlying TS runner:

- `0` — job completed
- `1` — job failed (worker reported failure)
- `2` — timeout (worker likely not running, or stuck)
- `3` — unexpected runtime error

## Env overrides

| Var                    | Default                       |
|------------------------|-------------------------------|
| `REDIS_URL`            | `redis://localhost:6379`      |
| `HARNESS_QUEUE_NAME`   | `bevox.execution.dispatch`    |
| `SMOKE_TIMEOUT_MS`     | `30000`                       |
| `SMOKE_POLL_MS`        | `500`                         |
