#!/usr/bin/env node
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import "dotenv/config";

const queue = new Queue(
  process.env.HARNESS_QUEUE_NAME ?? "bevox.execution.dispatch",
  {
    connection: { url: process.env.REDIS_URL },
  },
);

await queue.add("execution.dispatch", {
  execution_id: randomUUID(),
  execution_token: "test-token-" + randomUUID(),
  account: { id: "00000000-0000-0000-0000-000000000001" },
  messages: [{ role: "user", content: "quero marcar uma consulta" }],
  agent_config: {},
});

console.log("✓ Test job enqueued");
await queue.close();
