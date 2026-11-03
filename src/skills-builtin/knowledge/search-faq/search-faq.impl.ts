import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import { getRetriever } from "../../../rag/registry.js";
import type { ToolResult } from "../../../tools/types.js";

interface SearchFaqParams {
  query: string;
  limit?: number;
  minScore?: number;
}

export const SEARCH_FAQ_SCHEMA_VERSION = 2 as const;

export async function execute(
  params: unknown,
  context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as SearchFaqParams;
  if (!p.query) {
    return { success: false, error: "INVALID_PARAMS", detail: "query is required" };
  }
  const limit = Math.min(Math.max(p.limit ?? 5, 1), 20);
  const minScore = p.minScore ?? 0.5;

  const retriever = getRetriever();
  if (!retriever) {
    return {
      success: true,
      data: { schema_version: SEARCH_FAQ_SCHEMA_VERSION, degraded: true, results: [] },
    };
  }

  try {
    const chunks = await retriever.retrieve({
      query: p.query,
      organizationId: context.organizationId,
      source: "faq",
      topK: limit,
      minScore,
    });
    const results = chunks.map((c) => ({
      id: c.chunkId,
      chunkId: c.chunkId,
      documentId: c.documentId,
      content: c.content,
      title: c.title,
      score: c.score,
    }));
    return {
      success: true,
      data: { schema_version: SEARCH_FAQ_SCHEMA_VERSION, degraded: false, results },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes("does not exist") ||
      errMsg.includes('relation "rag_chunks"') ||
      errMsg.includes('type "vector"')
    ) {
      context.logger.warn(
        { err: errMsg },
        "search-faq: RAG schema not applied — returning degraded",
      );
      return {
        success: true,
        data: { schema_version: SEARCH_FAQ_SCHEMA_VERSION, degraded: true, results: [] },
      };
    }
    return { success: false, error: "RAG_FAILURE", detail: errMsg };
  }
}
