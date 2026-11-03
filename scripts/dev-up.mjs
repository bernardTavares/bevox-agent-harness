#!/usr/bin/env node
import { existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

if (!existsSync(".env")) {
  console.log("→ Creating .env from .env.example");
  copyFileSync(".env.example", ".env");
  console.log("⚠ Edit .env with real values before continuing");
}

console.log("→ Starting infra...");
execSync("docker compose up -d postgres redis", { stdio: "inherit" });

console.log("→ Waiting for postgres...");
const deadline = Date.now() + 60_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    execSync(
      "docker compose exec -T postgres pg_isready -U harness -d bevox_harness",
      { stdio: "ignore" },
    );
    ready = true;
    break;
  } catch {
    await sleep(1000);
  }
}
if (!ready) {
  console.error("✗ Postgres did not become ready within 60s");
  process.exit(1);
}

console.log("→ Running migrations...");
execSync("node scripts/migrate.mjs", { stdio: "inherit" });

console.log("✓ Infra ready. Run 'npm run dev' to start harness.");
