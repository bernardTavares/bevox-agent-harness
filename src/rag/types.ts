/**
 * Sprint D.2 — RAG type contracts.
 *
 * All RAG modules consume these interfaces. The retriever is the entry point
 * for surface tools (e.g. `search-faq`); chunker/embedder/vector-store are
 * composed by the ingest CLI.
 */

export interface RagDocument {
  id?: number;
  organizationId: string;
  source: string;
  externalId?: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RagChunk {
  id?: number;
  documentId: number;
  organizationId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  /** Optional during ingest dry-run; required for retrieval to find it. */
  embedding?: number[];
  embeddingModel?: string;
  metadata?: Record<string, unknown>;
}

export interface RetrievedChunk {
  chunkId: number;
  documentId: number;
  content: string;
  /** Cosine similarity in [0, 1]; higher = more relevant. */
  score: number;
  source: string;
  title?: string;
  metadata: Record<string, unknown>;
}

export interface ChunkOutput {
  content: string;
  tokenCount: number;
}

export interface Chunker {
  chunk(content: string, opts?: { maxTokens?: number }): ChunkOutput[];
}

export interface Embedder {
  /** Returns embeddings in same order as inputs. May read/write the cache. */
  embed(texts: string[]): Promise<number[][]>;
  readonly model: string;
  readonly dim: number;
}

export interface SimilaritySearchOptions {
  queryEmbedding: number[];
  /** REQUIRED — cross-organization leakage prevention is enforced here. */
  organizationId: string;
  source?: string | string[];
  topK: number;
  minScore?: number;
  /**
   * Optional filter to constrain matches to a specific embedding model. Useful
   * during model migrations (e.g. mid-reembed where some chunks are stale).
   */
  embeddingModel?: string;
}

export interface VectorStore {
  upsertDocument(doc: RagDocument): Promise<number>;
  replaceChunks(documentId: number, chunks: RagChunk[]): Promise<void>;
  similaritySearch(opts: SimilaritySearchOptions): Promise<RetrievedChunk[]>;
}

export interface RetrieveOptions {
  query: string;
  /** REQUIRED — passed through to VectorStore for tenant isolation. */
  organizationId: string;
  source?: string | string[];
  topK?: number;
  minScore?: number;
}

export interface Retriever {
  retrieve(opts: RetrieveOptions): Promise<RetrievedChunk[]>;
}
