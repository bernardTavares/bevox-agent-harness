import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as AjvNs from "ajv";
import pTimeout from "p-timeout";

import type { AgentExecutionContext } from "../agents/execution-context.js";
import { createLogger } from "../config/logger.js";
import { skillManifestSchema } from "../skills/skill-manifest.schema.js";
import type { LoadedSkill, SkillModule } from "../skills/skill-runtime.js";
import type { ToolCategory, ToolResult } from "../tools/types.js";

// Ajv ships as a CJS module. Under NodeNext ESM resolution the constructor
// can sit on `default` (preferred) or be the namespace itself. Normalise.
type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => unknown;
};
const Ajv = (AjvNs as unknown as { default?: AjvCtor }).default ?? (AjvNs as unknown as AjvCtor);

const logger = createLogger({ name: "mcp-adapter" });

const ajv = new Ajv({ strict: false, allErrors: true });

export interface AdapterOpts {
  serverId: string;
  client: Client;
  timeoutMs: number;
  /**
   * Defaults to `"knowledge"` (most restrictive). Operators can override per
   * tool via a mapping config in a future iteration; V1 treats all remote
   * tools as knowledge-class read-only by default.
   */
  category?: ToolCategory;
}

/**
 * Validate the `inputSchema` returned by a remote MCP server. We refuse to
 * register a tool whose schema is missing, non-object, or fails Ajv
 * compilation — the agent would not be able to send valid params anyway.
 */
export function validateRemoteInputSchema(
  schema: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (typeof schema !== "object" || schema === null) {
    return { ok: false, reason: "inputSchema not an object" };
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== "object") {
    return { ok: false, reason: "inputSchema.type must be 'object'" };
  }
  try {
    ajv.compile(s);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `invalid json schema: ${(err as Error).message}`,
    };
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "no content";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") {
      const t = (c as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join("\n") : "no content";
}

/**
 * Adapt a remote MCP `Tool` into a `LoadedSkill` registrable in
 * `SkillRegistry`.
 *
 * IMPORTANT — context propagation: the Bevox `AgentExecutionContext`
 * (`organizationId`, `contactId`, conversation key …) is NOT forwarded to the
 * remote server. The MCP boundary is opaque. Operators must segregate
 * multi-tenant data on the server side (e.g. one filesystem root per
 * account spawned as separate stdio entries). This is a deliberate V1
 * constraint — documented in `docs/architecture/mcp-client.md`.
 *
 * Returns `null` when:
 *   - the remote `inputSchema` is malformed (logged warn),
 *   - the synthesised manifest fails our own Zod schema (logged warn).
 */
export function adaptMcpToolToSkill(tool: Tool, opts: AdapterOpts): LoadedSkill | null {
  const schemaCheck = validateRemoteInputSchema(tool.inputSchema);
  if (!schemaCheck.ok) {
    logger.warn(
      { server: opts.serverId, tool: tool.name, reason: schemaCheck.reason },
      "skipping MCP tool with invalid input schema",
    );
    return null;
  }

  const skillName = `mcp:${opts.serverId}.${tool.name}`;
  const category: ToolCategory = opts.category ?? "knowledge";
  const description =
    tool.description && tool.description.length >= 10
      ? tool.description
      : `Remote MCP tool ${tool.name} from server ${opts.serverId}`;

  // Validate the synthetic manifest with our Zod schema to ensure
  // downstream consumers (permission evaluator, context builder) see a
  // shape they trust.
  const manifestParse = skillManifestSchema.safeParse({
    name: skillName,
    version: "1.0.0",
    description,
    category,
    agentType: "surface",
    parameters: tool.inputSchema as Record<string, unknown>,
    permissions: { requires: [], sideEffects: ["external_call"] },
    entry: "index",
  });

  if (!manifestParse.success) {
    logger.warn(
      {
        server: opts.serverId,
        tool: tool.name,
        issues: manifestParse.error.issues,
      },
      "skipping MCP tool: synthetic manifest failed validation",
    );
    return null;
  }

  const module: SkillModule = {
    async execute(params: unknown, _ctx: AgentExecutionContext): Promise<ToolResult> {
      try {
        const result = await pTimeout(
          opts.client.callTool({
            name: tool.name,
            arguments: (params ?? {}) as Record<string, unknown>,
          }),
          {
            milliseconds: opts.timeoutMs,
            message: `MCP timeout: ${skillName} after ${opts.timeoutMs}ms`,
          },
        );

        if (result.isError) {
          return {
            success: false,
            error: "MCP_TOOL_ERROR",
            detail: textOf(result.content),
          };
        }

        return {
          success: true,
          data: {
            text: textOf(result.content),
            raw: result.content,
          },
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.warn({ skill: skillName, err: detail }, "mcp tool call failed");
        return {
          success: false,
          error: "MCP_CALL_FAILED",
          detail,
        };
      }
    },
  };

  return {
    manifest: manifestParse.data,
    module,
    manifestPath: `mcp://${opts.serverId}/${tool.name}`,
    skillDir: `mcp://${opts.serverId}`,
  };
}
