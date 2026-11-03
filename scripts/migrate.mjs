#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import "dotenv/config";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

const files = readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const f of files) {
  const { rows } = await client.query(
    "SELECT 1 FROM schema_migrations WHERE filename=$1",
    [f],
  );
  if (rows.length > 0) {
    console.log(`✓ ${f} already applied`);
    continue;
  }
  const sql = readFileSync(join("migrations", f), "utf8");
  const upMatch = sql.match(/-- UP[\s\S]*?(?=-- DOWN|$)/);
  await client.query("BEGIN");
  try {
    await client.query(upMatch ? upMatch[0] : sql);
    await client.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      [f],
    );
    await client.query("COMMIT");
    console.log(`→ Applied ${f}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
await client.end();
