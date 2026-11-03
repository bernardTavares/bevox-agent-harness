#!/usr/bin/env tsx
/**
 * Sprint D.2 — `rag:ingest` CLI.
 *
 * Sub-bootstrap (G correção): we deliberately do NOT call the full bootstrap
 * (no BullMQ consumer, no Calendar health check, no tool registry). The CLI
 * only needs:
 *   1. Env validation (getEnv)
 *   2. Postgres pool
 *   3. LLM embedder (with credential pool)
 *
 * Usage:
 *   npm run rag:ingest -- --source ./fixtures/faq.md --account <organization-uuid>
 *   npm run rag:ingest -- --source ./docs/kb --account <organization-uuid> --tag kb-product --dry-run
 *
 * Behavior:
 *   - `--source` may be a single file or a directory (recursed shallowly).
 *   - Each file becomes one rag_documents row (externalId = basename).
 *   - Chunked by RecursiveChunker (512 tokens, 50 overlap).
 *   - Embeddings batched via CachingEmbedder (skips identical content).
 *   - `--dry-run` skips both upsert and embed; reports counts only.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";
import { z } from "zod";

import { createLogger } from "../../config/logger.js";
import { getEnv } from "../../config/env.js";
import { getCredentialPool } from "../../integration/llm/credential-pool.js";
import { createLLMEmbedder } from "../../integration/llm/embedder.js";
import { RecursiveChunker } from "../chunker.js";
import { CachingEmbedder } from "../embedder.js";
import { PgVectorStore } from "../vector-store.js";

const logger = createLogger({ name: "rag-ingest" });

const argsSchema = z.object({
  source: z.string().min(1),
  account: z.string().uuid(),
  tag: z.string().default("faq"),
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

async function listFiles(target: string): Promise<string[]> {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const entries = await fs.readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (e.isFile() && /\.(md|txt|json)$/i.test(e.name)) {
      files.push(path.join(target, e.name));
    }
  }
  return files;
}

function extractTitle(content: string, fallback: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const md = firstLine.replace(/^#+\s*/, "");
  return md.length > 0 && md.length <= 200 ? md : fallback;
}

async function main(): Promise<void> {
  const raw = parseArgs(process.argv);
  // Map kebab → camel for --dry-run
  if (raw["dry-run"] !== undefined && raw["dryRun"] === undefined) {
    raw["dryRun"] = raw["dry-run"]!;
  }
  const parsed = argsSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, "invalid arguments");
    console.error(
      "Usage: rag:ingest --source <path> --account <organization-uuid> [--tag <source-tag>] [--dry-run]",
    );
    process.exit(2);
  }
  const args = parsed.data;

  const env = getEnv();
  // Sub-bootstrap: just DB + credentials + embedder.
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    logger.error({ err }, "DB connection failed");
    process.exit(1);
  }

  // CredentialPool must have at least one key for the embedder provider.
  // Initialise from env if not already initialised by another path.
  const credPool = getCredentialPool();
  if (env.OPENAI_API_KEY && !credPool.has("openai")) {
    credPool.register("openai", [env.OPENAI_API_KEY]);
  }
  if (env.OPENAI_API_KEYS && !credPool.has("openai")) {
    credPool.register(
      "openai",
      env.OPENAI_API_KEYS.split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    );
  }
  if (env.GEMINI_API_KEY && !credPool.has("gemini")) {
    credPool.register("gemini", [env.GEMINI_API_KEY]);
  }
  if (env.GEMINI_API_KEYS && !credPool.has("gemini")) {
    credPool.register(
      "gemini",
      env.GEMINI_API_KEYS.split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    );
  }

  const llmEmbedder = args.dryRun
    ? undefined
    : createLLMEmbedder({ model: env.RAG_EMBEDDING_MODEL });

  const embedder = llmEmbedder
    ? new CachingEmbedder(llmEmbedder, pool, {
        model: env.RAG_EMBEDDING_MODEL,
        dim: env.RAG_EMBEDDING_DIM,
      })
    : undefined;

  const store = new PgVectorStore(pool);
  const chunker = new RecursiveChunker();

  const files = await listFiles(args.source);
  if (files.length === 0) {
    logger.warn({ source: args.source }, "no files matched");
    await pool.end();
    return;
  }

  let totalChunks = 0;
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    const externalId = path.basename(file);
    const title = extractTitle(content, externalId);

    if (args.dryRun) {
      const chunks = chunker.chunk(content);
      totalChunks += chunks.length;
      logger.info(
        { file, chunks: chunks.length, account: args.account, tag: args.tag },
        "[dry-run] would ingest",
      );
      continue;
    }

    const docId = await store.upsertDocument({
      organizationId: args.account,
      source: args.tag,
      externalId,
      title,
      content,
    });
    const chunks = chunker.chunk(content);
    const embeddings = await embedder!.embed(chunks.map((c) => c.content));
    await store.replaceChunks(
      docId,
      chunks.map((c, i) => ({
        documentId: docId,
        organizationId: args.account,
        chunkIndex: i,
        content: c.content,
        tokenCount: c.tokenCount,
        embedding: embeddings[i],
        embeddingModel: env.RAG_EMBEDDING_MODEL,
      })),
    );
    totalChunks += chunks.length;
    logger.info({ file, docId, chunks: chunks.length }, "ingested");
  }

  logger.info({ files: files.length, totalChunks, dryRun: args.dryRun }, "ingest complete");
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, "ingest failed");
  process.exit(1);
});
