/**
 * Integration test for the MCP SSE transport.
 *
 * Builds an in-process server and HTTP listener, then exercises bearer auth
 * and the listTools flow with a SDK SSE client.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import { buildMcpServer } from "../../src/mcp/server.js";
import { runSseTransport, type RunningSseTransport } from "../../src/mcp/transports/sse.js";
import { UnifiedToolRegistry } from "../../src/tools/unified-registry.js";
import type { LoadedSkill } from "../../src/skills/skill-runtime.js";

import { resetEnvCacheForTests } from "../../src/config/env.js";

const TOKEN = "x".repeat(32);
const HOST = "127.0.0.1";
let PORT = 0;
let running: RunningSseTransport | undefined;

function makeSkill(): LoadedSkill {
  return {
    manifest: {
      name: "search-faq",
      version: "1.0.0",
      description: "Search the FAQ knowledge base.",
      category: "knowledge",
      agentType: "surface",
      parameters: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
      },
      permissions: { requires: [], sideEffects: ["read"] },
      entry: "index",
    } as LoadedSkill["manifest"],
    module: { execute: async () => ({ success: true, data: { results: [] } }) },
    manifestPath: "",
    skillDir: "",
  };
}

describe("mcp sse transport", () => {
  beforeAll(async () => {
    // Wire env so getEnv() resolves to a valid config.
    process.env.DATABASE_URL = "postgres://x:x@127.0.0.1:1/x";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.BEVOX_CALLBACK_BASE_URL = "http://127.0.0.1:9999";
    process.env.CALENDAR_SERVICE_URL = "http://127.0.0.1:3009";
    process.env.HARNESS_LOG_LEVEL = "error";
    process.env.MCP_EXPOSED_SKILLS = "knowledge.*";
    process.env.MCP_TRANSPORT = "sse";
    process.env.MCP_SERVER_TOKEN = TOKEN;
    // Pick a port deterministically high to avoid collisions.
    PORT = 7000 + Math.floor(Math.random() * 1000);
    process.env.MCP_SSE_PORT = String(PORT);

    // Force-reset env cache by clearing module — we set vars before any import,
    // but tests may reuse a cached value. Re-import is not trivial; rely on
    // first-touch caching being correct here.
    // Module-level `createLogger` calls in security/audit.ts cache `getEnv()`
    // before this test mutates env. Force a fresh read so MCP_* vars are seen.
    resetEnvCacheForTests();

    UnifiedToolRegistry.resetForTests();
    UnifiedToolRegistry.getInstance().register(makeSkill());

    const fakeDb = {} as never; // not exercised — listTools does not run handlers
    const fakeLlm = { complete: () => Promise.reject(new Error("unused")) } as never;
    const factory = (): ReturnType<typeof buildMcpServer> =>
      buildMcpServer({ db: fakeDb, llmClient: fakeLlm });
    running = await runSseTransport(factory, { host: HOST, port: PORT, authToken: TOKEN });
  }, 30_000);

  afterAll(async () => {
    if (running) await running.close();
    UnifiedToolRegistry.resetForTests();
  });

  it("rejects unauthenticated GET /sse with 401", async () => {
    const res = await fetch(`http://${HOST}:${PORT}/sse`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("rejects wrong bearer with 401", async () => {
    const res = await fetch(`http://${HOST}:${PORT}/sse`, {
      headers: { Authorization: "Bearer wrong-token-wrong-token-wrong-token!!" },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("accepts authenticated client and lists exposed tools", async () => {
    const url = new URL(`http://${HOST}:${PORT}/sse`);
    const transport = new SSEClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      eventSourceInit: {
        // SSEClientTransport relies on fetch under the hood for EventSource;
        // pass the same auth header.
        fetch: ((input: Request | string | URL, init?: RequestInit) =>
          fetch(input as RequestInfo, {
            ...init,
            headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${TOKEN}` },
          })) as typeof fetch,
      },
    });
    const client = new Client({ name: "test", version: "0.0.1" });
    try {
      await client.connect(transport);
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain("knowledge.search-faq");
    } finally {
      await client.close().catch(() => {
        /* ignore */
      });
    }
  }, 15_000);
}, 60_000);
