/**
 * Sprint D.3 — process-singleton accessors for D.3 memory services.
 *
 * Bootstrap wires concrete instances (when MEMORY_* feature flags are on);
 * callers (MemoryLayer construction sites, execution-handler hook) read via
 * the getters and degrade gracefully to `undefined` when disabled.
 *
 * Mirrors `src/rag/registry.ts` pattern from D.2.
 */

import type { Queue } from "bullmq";

import type { MessageEmbeddingIndexer } from "./message-embedding-indexer.js";
import type { SemanticRecall } from "./semantic-recall.js";
import type { CondenseJobData } from "../integration/condense-queue.js";

let _indexer: MessageEmbeddingIndexer | undefined;
let _semanticRecall: SemanticRecall | undefined;
let _condenseQueue: Queue<CondenseJobData> | undefined;

export function setMessageIndexer(idx: MessageEmbeddingIndexer | undefined): void {
  _indexer = idx;
}
export function getMessageIndexer(): MessageEmbeddingIndexer | undefined {
  return _indexer;
}

export function setSemanticRecall(s: SemanticRecall | undefined): void {
  _semanticRecall = s;
}
export function getSemanticRecall(): SemanticRecall | undefined {
  return _semanticRecall;
}

export function setCondenseQueue(q: Queue<CondenseJobData> | undefined): void {
  _condenseQueue = q;
}
export function getCondenseQueue(): Queue<CondenseJobData> | undefined {
  return _condenseQueue;
}

/** Test helper — clears all registrations between tests. */
export function resetMemoryRegistryForTests(): void {
  _indexer = undefined;
  _semanticRecall = undefined;
  _condenseQueue = undefined;
}
