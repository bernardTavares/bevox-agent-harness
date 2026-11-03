/**
 * POC seam for CTX-02 (audit `runtime-gap-audit-2026-06-02.md` § ALTO).
 *
 * Token budget enforcement in the production execution path. The 5-layer
 * `ContextBuilder` (this folder) implements compression at the layer level
 * but is NOT instantiated by `runtime/execution-handler.ts`. Instead the
 * handler assembles `systemPrompt + permittedTools` ad-hoc and ships it
 * to the LLM without any budget check.
 *
 * This module is the minimal foundation that closes the runtime gap:
 * a pure helper that estimates tokens on the assembled context and, if it
 * exceeds the budget, deterministically truncates the *compressible*
 * portion of the system prompt (anything below an explicit header) while
 * preserving the non-compressible portion (base config + doctrine).
 *
 * NOT in this POC (deliberate follow-up scope):
 * - Refactoring `runSurfaceAgentLoop` to accept a `ContextBuilder` instance.
 * - Integrating the 5 existing layers (BaseConfig / Rules / Memory / History
 *   / Calendar) into the execution path.
 * - Compressing tool definitions themselves (only the system prompt is
 *   compressed here; tools are counted toward the budget but never trimmed).
 * - Model-C / `_dispatchModelCImpl` path (separate code path; same fix
 *   applies but tracked in a follow-up).
 *
 * The seam is intentionally pure (no I/O, no logger) so it can be called
 * from any place in the handler and unit-tested in isolation. Observability
 * is the caller's job: the returned `EnforcedContext` carries enough metadata
 * to set span attributes.
 */

import { estimateTokens } from "./tokenizer.js";

/**
 * Default token budget used when neither the payload nor agentConfig
 * provides a value. Mirrors `ContextBuilder`'s `globalMaxTokens` default
 * so the two surfaces stay numerically aligned.
 */
export const DEFAULT_GLOBAL_MAX_TOKENS = 8000;

/**
 * Lower bound on the number of tokens we will leave for the system prompt
 * after subtracting the tool-definition footprint. If the tool footprint
 * alone is larger than `budget - MIN_PROMPT_TOKENS`, we warn (via the
 * `warning` field on the result) and proceed with the original prompt
 * rather than reduce it to garbage — the audit explicitly requires us
 * NOT to abort in that case (issue #40, "Handle edge cases", bullet 3).
 */
export const MIN_PROMPT_TOKENS = 200;

/**
 * Minimal subset of `ToolDefinition` needed for budget estimation.
 * Decoupled from `tools/types.ts` to keep this module zero-dependency
 * on the runtime; any object with `{name, description, parameters}`
 * (i.e. the LLM-visible portion of a tool) is accepted.
 */
export interface ToolForBudget {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface EnforceBudgetInput {
  /** The assembled system prompt (post-doctrine, post-SDR-composition). */
  systemPrompt: string;
  /**
   * The list of permitted tools that will be sent to the LLM. Tool
   * footprint is counted toward the budget (it usually dominates) but
   * tools are never trimmed by this helper.
   */
  tools: readonly ToolForBudget[];
  /**
   * Effective budget. When `undefined`, falls back to
   * `DEFAULT_GLOBAL_MAX_TOKENS`. The caller is expected to resolve
   * `payload.agent_config.max_context_tokens` -> agentConfig hint ->
   * default, in that order, before calling.
   */
  maxContextTokens?: number;
}

export interface EnforcedContext {
  /**
   * The system prompt to actually ship to the LLM. Equal to the input
   * `systemPrompt` when no compression was needed; otherwise a truncated
   * version that keeps the leading non-compressible portion intact.
   */
  systemPrompt: string;
  /** Original (pre-compression) prompt+tools token estimate. */
  originalTokens: number;
  /** Final (post-compression) prompt+tools token estimate. */
  finalTokens: number;
  /** Budget that was enforced (`DEFAULT_GLOBAL_MAX_TOKENS` if not set). */
  budgetTokens: number;
  /** True when the helper trimmed the system prompt. */
  wasCompressed: boolean;
  /**
   * CTX-05: true when `finalTokens <= budgetTokens`. It is `false` in TWO
   * floor cases where the minimum content already overflows:
   *   (a) marker present and `head` alone >= budget -> returns head;
   *   (b) marker absent and the 3-line floor already exceeds the budget;
   * and in the warning-not-abort path (the full prompt ships above budget).
   * In all those cases the gate did its best and the caller should observe
   * `withinBudget === false` rather than treat it as a regression.
   */
  withinBudget: boolean;
  /**
   * Non-fatal warning emitted when the budget cannot be respected
   * (e.g. tools alone exceed it). Caller should log this and proceed —
   * the handler MUST NOT abort the execution (PRD invariant).
   */
  warning?: string;
}

/**
 * Estimate the token footprint of a single tool. We approximate the
 * LLM-visible form as `name + description + JSON(parameters)` which is
 * what most providers serialize when sending function-calling specs.
 *
 * `JSON.stringify` on a `Record<string, unknown>` is safe here because
 * tool parameter schemas in this codebase are plain JSON Schemas
 * (no cycles, no functions); a runtime failure to stringify would
 * indicate a bug in the tool definition itself.
 */
export function estimateToolTokens(tool: ToolForBudget): number {
  let serialisedParams: string;
  try {
    serialisedParams = JSON.stringify(tool.parameters);
  } catch {
    // Defensive: treat unserialisable schemas as zero-cost rather than
    // crash the executor. This will never happen in practice because
    // tool params must already be JSON-serialisable for the LLM.
    serialisedParams = "";
  }
  return estimateTokens(`${tool.name}\n${tool.description}\n${serialisedParams}`);
}

/**
 * Marker used by callers to split a system prompt into a non-compressible
 * head (always kept) and a compressible tail (may be truncated). When the
 * marker is absent, the whole prompt is treated as compressible — the
 * helper falls back to a proportional line-truncation that mirrors the
 * existing `ContextBuilder.compress()` strategy.
 *
 * Format: `\n\n<!-- BEVOX_CTX_COMPRESSIBLE -->\n` on its own line.
 *
 * NOT YET emitted by `composeSystemPrompt`. Once a follow-up PR teaches
 * the composer to insert the marker between doctrine (head) and history
 * (tail), compression will be deterministic and head-preserving; until
 * then the proportional fallback applies.
 */
/**
 * Hard cap on re-measure iterations in `truncatePromptToBudget`. The `keep`
 * line count decreases strictly each pass (`floor(keep * r)` with `r < 1` and
 * integer `keep` => strictly smaller), so the loop terminates even without a
 * bound; this is an additional guard and a ceiling on BPE re-encode cost
 * (<=6 re-encodes of the tail/prompt per compression).
 */
const MAX_TRUNCATE_ITERATIONS = 6;

export const COMPRESSIBLE_MARKER = "\n\n<!-- BEVOX_CTX_COMPRESSIBLE -->\n";

/**
 * Enforce the token budget on an assembled (systemPrompt + tools) pair.
 * Pure and synchronous; safe to call inline before `runSurfaceAgentLoop`.
 *
 * Algorithm:
 *  1. Estimate tokens for `systemPrompt` + each tool. Sum = `originalTokens`.
 *  2. If `originalTokens <= budget` → return `wasCompressed: false`.
 *  3. Compute `availablePromptBudget = budget - toolTokens`. If this is
 *     smaller than `MIN_PROMPT_TOKENS`, refuse to compress (would produce
 *     garbage) and emit a warning instead.
 *  4. Split the prompt on `COMPRESSIBLE_MARKER`. The head is always kept.
 *     The tail is truncated line-by-line until the prompt fits.
 *  5. When the marker is absent, perform a proportional line-truncation
 *     on the whole prompt (preserving at least 3 leading lines) — same
 *     strategy as `ContextBuilder.compress()` so behaviour is consistent.
 */
export function enforceBudget(input: EnforceBudgetInput): EnforcedContext {
  const budgetTokens = input.maxContextTokens ?? DEFAULT_GLOBAL_MAX_TOKENS;

  const promptTokens = estimateTokens(input.systemPrompt);
  const toolTokens = input.tools.reduce((sum, t) => sum + estimateToolTokens(t), 0);
  const originalTokens = promptTokens + toolTokens;

  if (originalTokens <= budgetTokens) {
    return {
      systemPrompt: input.systemPrompt,
      originalTokens,
      finalTokens: originalTokens,
      budgetTokens,
      wasCompressed: false,
      withinBudget: true, // originalTokens <= budgetTokens by the guard above
    };
  }

  const availablePromptBudget = budgetTokens - toolTokens;
  if (availablePromptBudget < MIN_PROMPT_TOKENS) {
    return {
      systemPrompt: input.systemPrompt,
      originalTokens,
      finalTokens: originalTokens,
      budgetTokens,
      wasCompressed: false,
      // Warning-not-abort ships the full prompt above budget on purpose.
      withinBudget: false,
      warning: `tool definitions alone (${toolTokens} tokens) leave <${MIN_PROMPT_TOKENS} for system prompt under budget ${budgetTokens}; proceeding with full prompt`,
    };
  }

  // Truncate the (compressible portion of the) prompt to fit.
  const truncated = truncatePromptToBudget(input.systemPrompt, availablePromptBudget);
  const finalPromptTokens = estimateTokens(truncated);
  const finalTokens = finalPromptTokens + toolTokens;

  return {
    systemPrompt: truncated,
    originalTokens,
    finalTokens,
    budgetTokens,
    wasCompressed: true,
    withinBudget: finalTokens <= budgetTokens, // CTX-05 observable invariant
  };
}

/**
 * Line-based truncation that respects the optional `COMPRESSIBLE_MARKER`,
 * converging to `estimateTokens(result) <= budget` (CTX-05).
 *
 * Each branch cuts lines, RE-MEASURES, and repeats — shrinking `keep` by a
 * multiplicative fixed-point factor `keep * (budget / tokens)` — until the
 * content fits OR only the floor remains. `keep` decreases strictly each pass
 * so the loop terminates; `MAX_TRUNCATE_ITERATIONS` is a hard ceiling.
 *
 * Invariants preserved: with a marker the head is ALWAYS kept intact; the
 * terminal case is a FLOOR — head-only (marker, head >= budget) or 3 lines
 * (no marker). Post-condition: `estimateTokens(result) <= budget` EXCEPT when
 * the floor itself overflows (head alone, or the 3 floor lines), in which case
 * the floor is returned and the caller observes `withinBudget === false`.
 */
function truncatePromptToBudget(prompt: string, budget: number): string {
  const markerIdx = prompt.indexOf(COMPRESSIBLE_MARKER);

  // --- Marker absent: convergent cut over the whole prompt, floor 3 lines.
  if (markerIdx === -1) {
    const lines = prompt.split("\n");
    const promptTokens = estimateTokens(prompt);
    if (promptTokens <= budget) return prompt;
    let keep = Math.max(3, Math.floor(lines.length * (budget / promptTokens)));
    for (let i = 0; i < MAX_TRUNCATE_ITERATIONS; i++) {
      const candidate = lines.slice(0, keep).join("\n");
      const tokens = estimateTokens(candidate);
      if (tokens <= budget || keep <= 3) return candidate; // fits OR floor
      keep = Math.max(3, Math.floor(keep * (budget / tokens)));
    }
    return lines.slice(0, Math.max(3, keep)).join("\n"); // bound terminal
  }

  // --- Marker present: head kept intact, tail converges.
  const head = prompt.slice(0, markerIdx);
  const tail = prompt.slice(markerIdx + COMPRESSIBLE_MARKER.length);
  const headTokens = estimateTokens(head);
  if (headTokens >= budget) return head; // head-only floor

  const tailBudget = budget - headTokens;
  const tailLines = tail.split("\n");
  if (estimateTokens(tail) <= tailBudget) return prompt;

  let keep = Math.max(1, Math.floor(tailLines.length * (tailBudget / estimateTokens(tail))));
  let truncatedTail = tailLines.slice(0, keep).join("\n");
  for (let i = 0; i < MAX_TRUNCATE_ITERATIONS; i++) {
    const tailTokens = estimateTokens(truncatedTail);
    if (tailTokens <= tailBudget || keep <= 1) break; // fits OR 1-line floor
    keep = Math.max(1, Math.floor(keep * (tailBudget / tailTokens)));
    truncatedTail = tailLines.slice(0, keep).join("\n");
  }
  return `${head}${COMPRESSIBLE_MARKER}${truncatedTail}`;
}
