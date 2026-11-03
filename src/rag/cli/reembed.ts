#!/usr/bin/env tsx
/**
 * Sprint D.2 — `rag:reembed` CLI.
 *
 * Re-generates embeddings for chunks whose `embedding_model` differs from
 * `RAG_EMBEDDING_MODEL` (or is NULL). Useful after upgrading the embedding
 * model. Batches of 100 per provider call.
 *
 * Usage:
 *   npm run rag:reembed -- --dry-run                       # count only
 *   npm run rag:reembed -- --account <organization-uuid>   # one tenant
 *   npm run rag:reembed -- --source faq                    # one source tag
 *   npm run rag:reembed -- --batch 100 --limit 1000
 */

import { Pool } from "pg";
import { z } from "zod";

import { createLogger } from "../../config/logger.js";
import { getEnv } from "../../config/env.js";
import { getCredentialPool } from "../../integration/llm/credential-pool.js";
import { createLLMEmbedder } from "../../integration/llm/embedder.js";
import { CachingEmbedder } from "../embedder.js";
import { toVectorLiteral } from "../vector-store.js";

const logger = createLogger({ name: "rag-reembed" });

const argsSchema = z.object({
  account: z.string().uuid().optional(),
  source: z.string().optional(),
  batch: z.coerce.number().int().positive().default(100),
  limit: z.coerce.number().int().positive().optional(),
  dryRun: z.coerce.boolean().default(false),
});

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

interface ChunkRow {
  id: number;
  content: string;
}

async function main(): Promise<void> {
  const raw = parseArgs(process.argv);
  if (raw["dry-run"] !== undefined && raw["dryRun"] === undefined) {
    raw["dryRun"] = raw["dry-run"]!;
  }
  const parsed = argsSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, "invalid arguments");
    process.exit(2);
  }
  const args = parsed.data;

  const env = getEnv();
  const targetModel = env.RAG_EMBEDDING_MODEL;
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  // Count first.
  const countRow = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM rag_chunks c
       LEFT JOIN rag_documents d ON d.id = c.document_id
      WHERE (c.embedding IS NULL OR c.embedding_model IS DISTINCT FROM $1)
        AND ($2::uuid IS NULL OR c.organization_id = $2)
        AND ($3::text IS NULL OR d.source = $3)`,
    [targetModel, args.account ?? null, args.source ?? null],
  );
  const total = Number(countRow.rows[0]?.count ?? "0");
  logger.info({ total, targetModel, dryRun: args.dryRun }, "candidates for reembed");
  if (args.dryRun || total === 0) {
    await pool.end();
    return;
  }

  // Init credentials.
  const credPool = getCredentialPool();
  if (env.OPENAI_API_KEY && !credPool.has("openai")) {
    credPool.register("openai", [env.OPENAI_API_KEY]);
  }
  if (env.GEMINI_API_KEY && !credPool.has("gemini")) {
    credPool.register("gemini", [env.GEMINI_API_KEY]);
  }
  const llmEmbedder = createLLMEmbedder({ model: targetModel });
  const embedder = new CachingEmbedder(llmEmbedder, pool, {
    model: targetModel,
    dim: env.RAG_EMBEDDING_DIM,
  });

  const hardLimit = args.limit ?? total;
  let processed = 0;
  while (processed < hardLimit) {
    const take = Math.min(args.batch, hardLimit - processed);
    const batch = await pool.query<ChunkRow>(
      `SELECT c.id, c.content
         FROM rag_chunks c
         LEFT JOIN rag_documents d ON d.id = c.document_id
        WHERE (c.embedding IS NULL OR c.embedding_model IS DISTINCT FROM $1)
          AND ($2::uuid IS NULL OR c.organization_id = $2)
          AND ($3::text IS NULL OR d.source = $3)
        ORDER BY c.id
        LIMIT $4`,
      [targetModel, args.account ?? null, args.source ?? null, take],
    );
    if (batch.rows.length === 0) break;

    const texts = batch.rows.map((r) => r.content);
    const vectors = await embedder.embed(texts);

    // Bulk UPDATE via UNNEST.
    const idArr = batch.rows.map((r) => r.id);
    const vecArr = vectors.map((v) => toVectorLiteral(v));
    await pool.query(
      `UPDATE rag_chunks AS c
          SET embedding = t.v::vector,
              embedding_model = $1
         FROM UNNEST($2::bigint[], $3::text[]) AS t(id, v)
        WHERE c.id = t.id`,
      [targetModel, idArr, vecArr],
    );

    processed += batch.rows.length;
    logger.info({ processed, total: hardLimit }, "reembed progress");
    if (batch.rows.length < take) break;
  }

  logger.info({ processed }, "reembed complete");
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, "reembed failed");
  process.exit(1);
});
