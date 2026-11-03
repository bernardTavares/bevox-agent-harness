import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { getEnv } from "../config/env.js";
import { SkillLoader } from "../skills/skill-loader.js";
import { UnifiedToolRegistry } from "../tools/unified-registry.js";

const { Pool } = pg;

/**
 * Minimal bootstrap for the MCP server process.
 *
 * Differs from the worker bootstrap (`src/bootstrap/stages.ts`) — we do NOT
 * start BullMQ, do NOT register pipeline/surface agents, and do NOT mount
 * callbacks. The only state we materialise is:
 *
 *   1. Skills loaded from `src/skills-builtin/**` into `SkillRegistry`.
 *   2. A PG `Pool` for skills that read/write database state (e.g. memory.*).
 *
 * The caller (typically `src/bin/bevox-mcp.ts`) is responsible for closing
 * the returned pool on shutdown.
 */
export interface McpBootstrapResult {
  db: pg.Pool;
}

export async function bootstrapMcp(): Promise<McpBootstrapResult> {
  const env = getEnv();

  // 1) Load built-in skills. The skills-builtin tree ships next to the
  //    compiled mcp/ output, so resolve relative to this module's url.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const builtinRoot = path.resolve(__dirname, "..", "skills-builtin");
  const disabled = new Set(
    env.SKILLS_DISABLED.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const loader = new SkillLoader({ disabled });
  const skills = await loader.loadFromPath(builtinRoot);
  const registry = UnifiedToolRegistry.getInstance();
  for (const skill of skills) {
    if (!registry.has(skill.manifest.name)) {
      registry.register(skill);
    }
  }

  // 2) PG pool — small (MCP traffic is interactive, not batch).
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 4 });

  return { db };
}

/**
 * Trivial in-process LlmClient stub. Skills that do not need the LLM
 * (calendar.*, knowledge.search-faq, memory.read-*) ignore this. Skills
 * that DO touch `ctx.llmClient` will receive a clear error rather than
 * a misleading silent failure — by design we exclude those from MCP
 * exposure (see permission-filter denied defaults).
 */
export class StubLlmClient {
  complete(): Promise<never> {
    return Promise.reject(
      new Error(
        "LLM is not available in the MCP server process — this skill must not be exposed via MCP",
      ),
    );
  }
}
