/**
 * Integration test for the MCP stdio transport.
 *
 * Spawns the compiled `dist/bin/bevox-mcp.js` as a child process and uses
 * the official MCP `Client` + `StdioClientTransport` to verify:
 *   - The exposed-skills glob is enforced.
 *   - Skills with `sideEffects: ["stop_signal"]` are auto-rejected.
 *   - Tool names follow the `${category}.${name}` convention.
 *
 * Tool invocation is exercised in a sibling test only when DB is available,
 * to keep this fast smoke check unit-test-friendly.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const BIN = join(REPO_ROOT, "dist", "bin", "bevox-mcp.js");

// Minimum env to satisfy the Zod schema in `src/config/env.ts` — these are
// validated at process startup. They never touch the network for the stdio
// `tools/list` flow because the bootstrap only opens the PG pool lazily on
// first query (pg.Pool is lazy).
const MIN_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://x:x@127.0.0.1:1/x",
  REDIS_URL: "redis://127.0.0.1:6379",
  BEVOX_CALLBACK_BASE_URL: "http://127.0.0.1:9999",
  CALENDAR_SERVICE_URL: "http://127.0.0.1:3009",
  HARNESS_LOG_LEVEL: "error",
};

describe("mcp stdio transport", () => {
  beforeAll(() => {
    if (!existsSync(BIN)) {
      throw new Error(
        `Compiled binary missing at ${BIN} — run \`npm run build\` before integration tests`,
      );
    }
  });

  let client: Client | undefined;
  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {
        /* best effort */
      });
      client = undefined;
    }
  });

  async function connect(env: Record<string, string>): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "--transport", "stdio"],
      env: { ...process.env, ...MIN_ENV, ...env } as Record<string, string>,
    });
    const c = new Client({ name: "test-client", version: "0.0.1" });
    await c.connect(transport);
    return c;
  }

  it("exposes only skills matching the configured glob", async () => {
    client = await connect({ MCP_EXPOSED_SKILLS: "knowledge.*" });
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("knowledge.search-faq");
    // No calendar/memory leaks
    expect(names.every((n) => n.startsWith("knowledge."))).toBe(true);
  });

  it("uses `${category}.${name}` ids exclusively", async () => {
    client = await connect({ MCP_EXPOSED_SKILLS: "calendar.*,knowledge.*" });
    const list = await client.listTools();
    for (const t of list.tools) {
      expect(t.name).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
    }
  });

  it("auto-rejects skills with stop_signal side-effects", async () => {
    client = await connect({ MCP_EXPOSED_SKILLS: "messaging.*,knowledge.*" });
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).not.toContain("messaging.send-message");
    expect(names).not.toContain("messaging.request-human");
    expect(names).toContain("knowledge.search-faq");
  });

  it("fail-closed when MCP_EXPOSED_SKILLS is empty", async () => {
    client = await connect({ MCP_EXPOSED_SKILLS: "" });
    // With zero tools registered the SDK does NOT advertise the tools
    // capability, so `tools/list` returns -32601 Method not found. This is
    // the strongest possible "no tools exposed" signal — any client that
    // probes for tools immediately sees the surface is closed.
    await expect(client.listTools()).rejects.toThrow(/Method not found/);
  });
}, 30_000);
