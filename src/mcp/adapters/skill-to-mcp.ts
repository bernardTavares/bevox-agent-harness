import type { LoadedSkill } from "../../skills/skill-runtime.js";
import type { ToolResult } from "../../tools/types.js";

export interface McpToolDescriptor {
  /** Fully-qualified id `${category}.${name}` — used as MCP tool name. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Build the canonical MCP tool id for a loaded skill.
 * Convention: `${category}.${name}` (e.g. `calendar.read-calendar`).
 *
 * The dotted id is what MCP clients see and what permission filters/glob
 * patterns match against. Keep this single source of truth — never use the
 * bare manifest `name` for MCP exposure.
 */
export function mcpToolId(skill: LoadedSkill): string {
  return `${skill.manifest.category}.${skill.manifest.name}`;
}

/**
 * Convert a LoadedSkill into the MCP tool descriptor shape.
 *
 * `manifest.parameters` is already JSON Schema (validated by Zod in F8),
 * so the mapping is 1:1. We force `$schema` to draft-07 for compatibility
 * with current MCP SDK versions.
 */
export function skillToMcpTool(skill: LoadedSkill): McpToolDescriptor {
  return {
    name: mcpToolId(skill),
    description: skill.manifest.description,
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      ...skill.manifest.parameters,
    },
  };
}

export interface McpContentResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Adapt a `ToolResult` from a skill into the MCP `CallToolResult` shape.
 *
 * MCP always returns a `content` array. We serialise structured data as
 * JSON text so the caller (an LLM-driven MCP client) can reason about
 * it. On failure we set `isError: true` and surface only the controlled
 * `error`/`errorCode`/`detail` fields — never raw exceptions or stack
 * traces.
 */
export function toolResultToMcpContent(result: ToolResult): McpContentResult {
  if (!result.success) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: result.error,
              errorCode: result.errorCode,
              detail: result.detail,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result.data ?? {}, null, 2) }],
  };
}
