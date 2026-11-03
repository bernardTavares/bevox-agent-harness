import { z } from "zod";

/**
 * Schema for `mcp.config.json` — the per-environment manifest of external
 * MCP servers the harness should connect to as a *client*.
 *
 * Each server entry is keyed by a short id (`filesystem`, `github`, …). The
 * id is used to namespace tools registered in `SkillRegistry` as
 * `mcp:<server>.<tool>` (see `mcp-tool-adapter.ts`).
 *
 * Two transports supported in V1:
 *   - `stdio`: spawn a local subprocess (e.g. `npx -y …`)
 *   - `sse`:   connect to a remote HTTP/SSE endpoint
 *
 * Interpolation: values of `headers` and `env` that match `${NAME}` are
 * substituted from `process.env` by the loader — NOT by the SDK. The loader
 * throws if a referenced env var is undefined.
 */

const stdioServer = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
});

const sseServer = z.object({
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});

const serverEntry = z.discriminatedUnion("transport", [stdioServer, sseServer]);

export const mcpClientConfigSchema = z
  .object({
    servers: z.record(
      z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "server id: lowercase, [a-z0-9-], max 32"),
      serverEntry,
    ),
    defaults: z
      .object({
        timeoutMs: z.number().int().min(100).max(60000).default(10000),
        enabledByDefault: z.boolean().default(true),
      })
      .default({ timeoutMs: 10000, enabledByDefault: true }),
  })
  .strict();

export type McpClientConfig = z.infer<typeof mcpClientConfigSchema>;
export type McpServerEntry = McpClientConfig["servers"][string];
export type McpStdioServer = Extract<McpServerEntry, { transport: "stdio" }>;
export type McpSseServer = Extract<McpServerEntry, { transport: "sse" }>;
