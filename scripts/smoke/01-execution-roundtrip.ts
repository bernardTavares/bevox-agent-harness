#!/usr/bin/env tsx
/**
 * Smoke 01 — execution roundtrip (local dev only).
 *
 * Enqueues one real execution job into the BullMQ queue against the local
 * Redis from `pnpm docker:up`, then polls until the harness worker reports
 * `completed` (success), `failed` (assertion failure), or a 30 s timeout.
 *
 * Scope: local dev environment only. The hub repo `bevox-PRD-consolidation`
 * owns cluster-level smokes under `scripts/smoke/01..16-*.sh` (Hetzner via
 * SSH). This file is harness-local and does NOT replace those.
 *
 * Exit codes:
 *   0 → job completed
 *   1 → job failed
 *   2 → timeout (job did not reach a terminal state in 30 s)
 *   3 → unexpected error / env / wiring problem
 *
 * Usage:
 *   pnpm docker:up
 *   pnpm tsx scripts/smoke/01-execution-roundtrip.ts
 *
 * Env:
 *   REDIS_URL              default `redis://localhost:6379`
 *   HARNESS_QUEUE_NAME     default `bevox.execution.dispatch` (matches src/config/env.ts)
 *   SMOKE_TIMEOUT_MS       default 30000
 *   SMOKE_POLL_MS          default 500
 */

import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const QUEUE_NAME = process.env.HARNESS_QUEUE_NAME ?? "bevox.execution.dispatch";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);
const POLL_MS = Number(process.env.SMOKE_POLL_MS ?? 500);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const executionId = randomUUID();
  const organizationId = randomUUID();
  // execution_token min length 20 (src/runtime/execution-handler.ts
  // executionPayloadSchema). Prefix + uuid ⇒ ≥ 30 chars.
  const executionToken = `smoke-${randomUUID()}`;

  const payload = {
    execution_id: executionId,
    execution_token: executionToken,
    organization_id: organizationId,
    messages: [{ role: "user", content: "smoke 01 — execution roundtrip" }],
    execution_mode: "autonomous_supervised" as const,
    agent_config: {},
  };

  console.log(
    `==> queue="${QUEUE_NAME}" redis="${REDIS_URL}" execution_id=${executionId}`,
  );

  const queue = new Queue(QUEUE_NAME, {
    connection: { url: REDIS_URL },
  });

  try {
    const job = await queue.add("execution.dispatch", payload, {
      removeOnComplete: { age: 60 },
      removeOnFail: 100,
    });
    console.log(`==> enqueued jobId=${job.id}`);

    const deadline = Date.now() + TIMEOUT_MS;
    let state: string = "unknown";
    while (Date.now() < deadline) {
      state = await job.getState();
      if (state === "completed") {
        console.log(`==> jobId=${job.id} state=completed`);
        return 0;
      }
      if (state === "failed") {
        const reason = job.failedReason ?? "(no reason)";
        console.error(`==> jobId=${job.id} state=failed reason=${reason}`);
        return 1;
      }
      await sleep(POLL_MS);
    }

    console.error(`==> jobId=${job.id} timeout after ${TIMEOUT_MS}ms; last state=${state}`);
    return 2;
  } finally {
    await queue.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("==> smoke 01 crashed:", err);
    process.exit(3);
  });
