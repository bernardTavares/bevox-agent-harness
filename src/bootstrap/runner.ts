import { Redis } from "ioredis";
import { Pool } from "pg";
import pino from "pino";

import { getHarnessConfig } from "../config/harness-config.js";

import type { BootstrapContext } from "./stages.js";
import { buildStages } from "./stages.js";

const config = getHarnessConfig();
const logger = pino({ level: config.harness.logLevel, name: "bootstrap" });

export async function runBootstrap(): Promise<BootstrapContext> {
  logger.info("Bootstrap starting");

  const db = new Pool({ connectionString: config.db.connectionString });
  const redis = new Redis(config.redis.url, { lazyConnect: true });
  await redis.connect();

  const ctx: BootstrapContext = { db, redis };
  const stages = buildStages(ctx);

  for (const stage of stages) {
    logger.info({ stage: stage.name }, "Running bootstrap stage");
    try {
      await stage.execute();
      logger.info({ stage: stage.name }, "Bootstrap stage complete");
    } catch (err) {
      logger.error({ stage: stage.name, err }, "Bootstrap stage failed — aborting");
      process.exit(1);
    }
  }

  logger.info("Bootstrap complete — harness is ready");
  return ctx;
}
