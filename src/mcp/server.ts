import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "pg";

import type { AgentExecutionContext, LlmClient } from "../agents/execution-context.js";
import { getEnv } from "../config/env.js";
import { UnifiedToolRegistry } from "../tools/unified-registry.js";

import { manifestParametersToZodShape } from "./adapters/json-schema-to-zod.js";
import {
  buildExternalAgentDefinition,
  filterExposedSkills,
  isAllowedAtRuntime,
} from "./adapters/permission-filter.js";
import { mcpToolId, toolResultToMcpContent } from "./adapters/skill-to-mcp.js";
import { buildMcpPermissionContext } from "./execution-context.js";
import { getMcpLogger } from "./logger.js";

export interface BuildMcpServerOptions {
  /** Override of the default organizationId for MCP-originated calls. */
  organizationId?: string;
  /** Required: PG pool used by skills that touch `ctx.db`. */
  db: Pool;
  /** Required: LLM client passed to skills that touch `ctx.llmClient`. */
  llmClient: LlmClient;
}

function parseDeniedList(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build an `McpServer` exposing the configured subset of skills as MCP tools.
 *
 * Wiring:
 *   - Skills are pulled from `SkillRegistry.getInstance().list()` — populated by
 *     the (separate) MCP-side bootstrap before this is called.
 *   - `MCP_EXPOSED_SKILLS` (csv glob over `${category}.${name}`) controls
 *     exposure at startup. Empty ⇒ zero tools (fail-closed).
 *   - Each exposed skill becomes a `registerTool(name, { description, inputSchema })`
 *     call. `inputSchema` is converted from the manifest JSON Schema into a
 *     Zod raw shape (the form the MCP SDK requires).
 *   - At call time the synthetic `mcp-external` AgentDefinition + a fresh
 *     `PermissionContext` go through the existing 3-layer evaluator so audit
 *     and account-level denials work uniformly.
 */
export function buildMcpServer(opts: BuildMcpServerOptions): McpServer {
  const env = getEnv();
  const logger = getMcpLogger();

  const patterns = (env.MCP_EXPOSED_SKILLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const extraDenied = parseDeniedList(env.MCP_DENIED_SKILLS);
  const externalAgent = buildExternalAgentDefinition(extraDenied);

  const all = UnifiedToolRegistry.getInstance().list();
  const exposed = filterExposedSkills(all, patterns);

  logger.info(
    {
      total: all.length,
      exposed: exposed.length,
      patterns,
      deniedAtRuntime: externalAgent.permissions.denied,
    },
    "mcp server exposing skills",
  );

  const server = new McpServer({
    name: "bevox-agent-harness",
    version: process.env.npm_package_version ?? "0.0.0",
  });

  const organizationId = opts.organizationId ?? env.BEVOX_DEFAULT_ORGANIZATION_ID ?? "";

  for (const skill of exposed) {
    const toolName = mcpToolId(skill);
    const inputSchema = manifestParametersToZodShape(skill.manifest.parameters);
    server.registerTool(
      toolName,
      {
        description: skill.manifest.description,
        inputSchema,
      },
      async (params) => {
        const permCtx = buildMcpPermissionContext({ organizationId });
        const gate = isAllowedAtRuntime(skill, externalAgent, permCtx);
        if (!gate.allowed) {
          return toolResultToMcpContent({
            success: false,
            error: "PERMISSION_DENIED",
            errorCode: "PERMISSION_DENIED",
            detail: gate.reason ?? "denied by permission evaluator",
          });
        }

        const execCtx: AgentExecutionContext = {
          executionId: permCtx.executionId,
          organizationId: permCtx.organizationId,
          conversationKey: permCtx.conversationKey,
          db: opts.db,
          logger: logger,
          llmClient: opts.llmClient,
        };

        try {
          const result = await skill.module.execute(params, execCtx);
          return toolResultToMcpContent(result);
        } catch (err) {
          return toolResultToMcpContent({
            success: false,
            error: "SKILL_EXCEPTION",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  }

  return server;
}
