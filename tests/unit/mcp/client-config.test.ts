import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { mcpClientConfigSchema } from "../../../src/mcp/client-config.schema.js";
import { substituteEnvVars, loadMcpClientConfig } from "../../../src/config/mcp-servers.js";
import { resetEnvCacheForTests } from "../../../src/config/env.js";

describe("mcpClientConfigSchema", () => {
  it("accepts stdio + sse mix", () => {
    const parsed = mcpClientConfigSchema.parse({
      servers: {
        fs: { transport: "stdio", command: "npx", args: ["-y", "pkg"] },
        gh: { transport: "sse", url: "https://example.com/sse" },
      },
    });
    expect(Object.keys(parsed.servers)).toHaveLength(2);
    expect(parsed.defaults.timeoutMs).toBe(10000);
  });

  it("rejects unknown transport", () => {
    expect(() =>
      mcpClientConfigSchema.parse({
        servers: { x: { transport: "http", url: "https://x" } },
      }),
    ).toThrow();
  });

  it("rejects invalid server id (uppercase)", () => {
    expect(() =>
      mcpClientConfigSchema.parse({
        servers: { FS: { transport: "stdio", command: "x" } },
      }),
    ).toThrow();
  });

  it("rejects strict mode unknown top-level key", () => {
    expect(() =>
      mcpClientConfigSchema.parse({
        servers: {},
        bogus: 1,
      }),
    ).toThrow();
  });

  it("defaults to enabledByDefault true and timeoutMs 10000", () => {
    const parsed = mcpClientConfigSchema.parse({ servers: {} });
    expect(parsed.defaults.enabledByDefault).toBe(true);
    expect(parsed.defaults.timeoutMs).toBe(10000);
  });
});

describe("substituteEnvVars", () => {
  beforeEach(() => {
    process.env.TEST_TOKEN_X = "secret-value";
  });
  afterEach(() => {
    delete process.env.TEST_TOKEN_X;
  });

  it("interpolates ${VAR}", () => {
    expect(substituteEnvVars("Bearer ${TEST_TOKEN_X}")).toBe("Bearer secret-value");
  });

  it("returns string unchanged when no placeholders", () => {
    expect(substituteEnvVars("plain")).toBe("plain");
  });

  it("throws on undefined env var", () => {
    expect(() => substituteEnvVars("Bearer ${NOT_DEFINED_VAR_999}")).toThrow(
      /NOT_DEFINED_VAR_999/,
    );
  });
});

describe("loadMcpClientConfig", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "mcp-cfg-"));
    resetEnvCacheForTests();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    delete process.env.MCP_CLIENT_ENABLED;
    delete process.env.MCP_SERVERS_CONFIG_PATH;
    delete process.env.TEST_BEARER;
    resetEnvCacheForTests();
  });

  it("returns null when MCP_CLIENT_ENABLED=false", async () => {
    process.env.MCP_CLIENT_ENABLED = "false";
    const cfg = await loadMcpClientConfig();
    expect(cfg).toBeNull();
  });

  it("loads, validates and interpolates a config file", async () => {
    process.env.TEST_BEARER = "abc123";
    const cfgPath = path.join(tmp, "mcp.json");
    await writeFile(
      cfgPath,
      JSON.stringify({
        servers: {
          remote: {
            transport: "sse",
            url: "https://example.com/sse",
            headers: { Authorization: "Bearer ${TEST_BEARER}" },
          },
        },
      }),
    );
    process.env.MCP_CLIENT_ENABLED = "true";
    process.env.MCP_SERVERS_CONFIG_PATH = cfgPath;
    resetEnvCacheForTests();

    const cfg = await loadMcpClientConfig();
    expect(cfg).not.toBeNull();
    const remote = cfg!.servers.remote;
    if (remote.transport !== "sse") throw new Error("expected sse");
    expect(remote.headers.Authorization).toBe("Bearer abc123");
  });
});
