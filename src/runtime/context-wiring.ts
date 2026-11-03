import type { Span } from "@opentelemetry/api";

import { COMPRESSIBLE_MARKER } from "../context/budget-enforcer.js";
import type { BuiltContext, ContextBlock, ContextInput } from "../context/types.js";

export interface BuildContextInputArgs {
  executionId: string;
  organizationId: string;
  contactId?: bigint;
  conversationKey: string;
  /** Raw base system prompt (pre-doctrine). Owned by BaseConfigLayer. */
  systemPrompt: string;
  dispatchPayload: Record<string, unknown>;
  userMessage?: string;
  tokenBudget?: number;
}

/**
 * Build the ContextInput for the runtime ContextBuilder.
 *
 * IMPORTANT (Phase 1-2): `agentConfig.maxContextTokens` is left UNDEFINED so
 * the builder does NOT compress internally — the live `enforceBudget`
 * (CTX-02) stays the single budget gate. `tokenBudget` only controls the
 * MemoryLayer semantic-recall skip (memory.layer.ts).
 */
export function buildContextInput(args: BuildContextInputArgs): ContextInput {
  return {
    executionId: args.executionId,
    organizationId: args.organizationId,
    contactId: args.contactId,
    conversationKey: args.conversationKey,
    agentConfig: {
      systemPrompt: args.systemPrompt,
      maxContextTokens: undefined,
    },
    dispatchPayload: args.dispatchPayload,
    userMessage: args.userMessage,
    tokenBudget: args.tokenBudget,
  };
}

export interface FoldOptions {
  /** Phase 3: insert COMPRESSIBLE_MARKER between head and tail. */
  withMarker?: boolean;
}

function renderBlock(b: ContextBlock): string {
  return `${b.section}\n${b.content}`;
}

/**
 * Fold the builder's ordered blocks + doctrine tail into the final prompt.
 *
 * HEAD (non-compressible): BaseConfig + Rules blocks, then the doctrine/L3/FSM
 *   tail produced by composeSystemPrompt("", ...). BaseConfigLayer is the sole
 *   owner of the base (B5) — composeSystemPrompt is called with base="".
 * [MARKER] when withMarker=true (Phase 3) — splits head from tail for the
 *   head-preserving enforceBudget.
 * TAIL (compressible): Memory + History blocks (+ Calendar when enabled).
 */
export function foldContext(
  built: BuiltContext,
  doctrineTail: string,
  options: FoldOptions = {},
): string {
  const head = built.blocks.filter((b) => !b.compressible).map(renderBlock);
  const tail = built.blocks.filter((b) => b.compressible).map(renderBlock);

  const headParts = [...head];
  if (doctrineTail !== "") headParts.push(doctrineTail);
  const headStr = headParts.join("\n\n");

  const tailStr = tail.join("\n\n");

  if (tailStr === "") return headStr;

  if (options.withMarker) {
    // COMPRESSIBLE_MARKER already carries its own leading "\n\n" and trailing "\n".
    return `${headStr}${COMPRESSIBLE_MARKER}${tailStr}`;
  }
  return `${headStr}\n\n${tailStr}`;
}

/**
 * Set the `context.*` span attributes for the builder run, extending the
 * existing CTX-02 attrs (context.compressed / context.*_tokens set elsewhere).
 */
export function setContextSpanAttributes(span: Span, built: BuiltContext): void {
  // Derive the used-headings from `blocks` (the authoritative ordered set) so
  // the attribute stays correct even if `layersUsed` is out of sync. In real
  // builds these are identical: context-builder sets layersUsed = blocks.map(b
  // => b.section).
  span.setAttribute("context.layers.used", built.blocks.map((b) => b.section).join(","));
  span.setAttribute("context.layers.failed", built.layersFailed.join(","));
  span.setAttribute(
    "context.layers.failed_unexpected",
    built.layersFailedUnexpected.join(","),
  );
  span.setAttribute("context.layers.count", built.blocks.length);
  span.setAttribute("context.total_tokens", built.totalTokens);
}
