/**
 * Sprint D.2 — Module-level Retriever registry.
 *
 * Bootstrap wires a `RagRetriever`; tools (`search-faq`) read it via
 * `getRetriever()`. Same pattern as `PermissionAuditLogger` / `RateLimiter`
 * to avoid threading a new field through `AgentExecutionContext` (which is
 * a public-ish surface consumed by every tool definition).
 *
 * If `setRetriever` is never called, `getRetriever()` returns undefined and
 * consumers MUST degrade gracefully (search-faq returns `{ results: [],
 * degraded: true }`).
 */

import type { Retriever } from "./types.js";

let _retriever: Retriever | undefined;

export function setRetriever(r: Retriever | undefined): void {
  _retriever = r;
}

export function getRetriever(): Retriever | undefined {
  return _retriever;
}

/** Test helper — clears the singleton between tests. */
export function resetRetrieverForTests(): void {
  _retriever = undefined;
}
