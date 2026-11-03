/**
 * Sprint D.3 — Dedicated BullMQ worker for `harness.memory.condense`.
 *
 * Runs as a separate node process so condensation never competes with the
 * main execution worker's CPU/LLM budget. Booted with:
 *   npm run worker:condense
 *
 * Feature flag: MEMORY_CONDENSE_ENABLED must be true; otherwise process
 * exits immediately. This makes Compose / Kubernetes templates safe to
 * keep around without bouncing them when the feature is off.
 */

import { Redis } from "ioredis";
import { Pool } from "pg";

import { runMemoryCondenser } from "../agents/pipeline/memory-condenser.agent.js";
import { getEnv } from "../config/env.js";
import { getHarnessConfig } from "../config/harness-config.js";
import { createLogger } from "../config/logger.js";
import { createCondenseWorker } from "../integration/condense-queue.js";
import { createLLMGateway } from "../integration/llm-gateway.js";
import { ContactFactsRepository } from "../memory/contact-facts.repository.js";
import { ObservationalCondenser } from "../memory/observational-condenser.js";

const config = getHarnessConfig();
const logger = createLogger({ name: "worker:condense", level: config.harness.logLevel });

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.MEMORY_CONDENSE_ENABLED) {
    logger.warn("MEMORY_CONDENSE_ENABLED=false — exiting without booting worker");
    return;
  }

  const db = new Pool({ connectionString: config.db.connectionString });
  const redis = new Redis(config.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: null, // BullMQ requirement
  });
  await redis.connect();

  const llmGateway = createLLMGateway({});
  const factsRepo = new ContactFactsRepository(db);
  const condenser = new ObservationalCondenser(
    db,
    {
      thresholdMessages: env.MEMORY_CONDENSE_THRESHOLD_MESSAGES,
      thresholdTokens: env.MEMORY_CONDENSE_THRESHOLD_TOKENS,
      thresholdDays: env.MEMORY_CONDENSE_THRESHOLD_DAYS,
    },
    runMemoryCondenser,
    { llmGateway, factsRepo, db },
  );

  const worker = createCondenseWorker({
    connection: redis,
    condenser,
    concurrency: env.MEMORY_CONDENSE_WORKER_CONCURRENCY,
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "condense job completed");
  });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err?.message }, "condense job failed");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutdown signal received");
    await worker.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info({ concurrency: env.MEMORY_CONDENSE_WORKER_CONCURRENCY }, "condense worker started");
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error in condense worker");
  process.exit(1);
});
