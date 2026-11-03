import { readFile } from "node:fs/promises";

import { mcpClientConfigSchema, type McpClientConfig } from "../mcp/client-config.schema.js";

import { getEnv } from "./env.js";

/**
 * Substitute `${NAME}` references in a string with `process.env.NAME`.
 *
 * Used to interpolate secrets into `headers` / `env` of MCP server entries
 * BEFORE the values reach the SDK. Throws if a referenced var is missing —
 * we refuse to send a literal `Bearer ${TOKEN}` to a remote server.
 *
 * Only the exact `${NAME}` form is supported (no defaults, no expressions).
 */
export function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`mcp config interpolation: env var "${name}" is not defined`);
    }
    return v;
  });
}

function interpolateRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = substituteEnvVars(v);
  }
  return out;
}

function interpolateConfig(cfg: McpClientConfig): McpClientConfig {
  const out: McpClientConfig = {
    ...cfg,
    servers: {},
  };
  for (const [id, server] of Object.entries(cfg.servers)) {
    if (server.transport === "stdio") {
      out.servers[id] = {
        ...server,
        env: interpolateRecord(server.env),
      };
    } else {
      out.servers[id] = {
        ...server,
        headers: interpolateRecord(server.headers),
      };
    }
  }
  return out;
}

/**
 * Load and validate the MCP client config file.
 * Returns `null` when MCP client is disabled or no path configured.
 */
export async function loadMcpClientConfig(): Promise<McpClientConfig | null> {
  const env = getEnv();
  if (!env.MCP_CLIENT_ENABLED) return null;
  const filePath = env.MCP_SERVERS_CONFIG_PATH;
  if (!filePath) return null;

  const raw = await readFile(filePath, "utf8");
  const json: unknown = JSON.parse(raw);
  const parsed = mcpClientConfigSchema.parse(json);
  return interpolateConfig(parsed);
}
