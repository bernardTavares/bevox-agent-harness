/**
 * Sprint D.2 — Recursive chunker.
 *
 * Splits content along progressively finer separators (paragraph → line →
 * sentence → word → char) until each chunk fits under `maxTokens`. Mirrors
 * LangChain's `RecursiveCharacterTextSplitter` semantics with project-native
 * token estimation (`estimateTokens` heuristic: words * 1.3 — documented in
 * docs/architecture/rag.md as NOT billing-grade).
 *
 * Overlap (LangChain-style) carries the trailing ~OVERLAP_TOKENS words of
 * chunk N onto the head of chunk N+1, ensuring queries that land on a
 * boundary still surface adjacent context. Overlap is bounded by maxTokens
 * — never expands a chunk past the budget.
 */

import { estimateTokens } from "../context/tokenizer.js";

import type { Chunker, ChunkOutput } from "./types.js";

const SEPARATORS = ["\n\n", "\n", ". ", " "];
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 50;

export interface RecursiveChunkerOptions {
  /** Default 512. */
  maxTokens?: number;
  /** Default 50. Set to 0 to disable. */
  overlapTokens?: number;
}

export class RecursiveChunker implements Chunker {
  private readonly defaultMaxTokens: number;
  private readonly overlapTokens: number;

  constructor(opts: RecursiveChunkerOptions = {}) {
    this.defaultMaxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  }

  chunk(content: string, opts: { maxTokens?: number } = {}): ChunkOutput[] {
    const maxTokens = opts.maxTokens ?? this.defaultMaxTokens;
    if (!content || content.trim().length === 0) return [];

    const raw: ChunkOutput[] = [];
    this.split(content, maxTokens, 0, raw);
    return this.applyOverlap(raw, maxTokens);
  }

  private split(text: string, maxTokens: number, sepIndex: number, out: ChunkOutput[]): void {
    const tokens = estimateTokens(text);
    if (tokens <= maxTokens) {
      const trimmed = text.trim();
      if (trimmed) out.push({ content: trimmed, tokenCount: estimateTokens(trimmed) });
      return;
    }

    const sep = SEPARATORS[sepIndex];
    if (!sep) {
      // Last resort: char-level split proportional to the token overage.
      const ratio = maxTokens / Math.max(tokens, 1);
      const cut = Math.max(1, Math.floor(text.length * ratio));
      const head = text.slice(0, cut).trim();
      const tail = text.slice(cut);
      if (head) out.push({ content: head, tokenCount: estimateTokens(head) });
      if (tail.trim()) this.split(tail, maxTokens, 0, out);
      return;
    }

    const parts = text.split(sep);
    let buffer = "";
    for (const part of parts) {
      const candidate = buffer ? buffer + sep + part : part;
      if (estimateTokens(candidate) > maxTokens) {
        if (buffer) {
          this.split(buffer, maxTokens, sepIndex + 1, out);
          buffer = part;
        } else {
          // Single part already exceeds budget — descend to finer separator.
          this.split(part, maxTokens, sepIndex + 1, out);
          buffer = "";
        }
      } else {
        buffer = candidate;
      }
    }
    if (buffer.trim()) this.split(buffer, maxTokens, sepIndex + 1, out);
  }

  /**
   * Carry the trailing ~overlapTokens worth of words from chunk N onto the
   * head of chunk N+1. Total resulting chunk is capped at `maxTokens` to
   * preserve the budget contract (overlap may be truncated).
   */
  private applyOverlap(chunks: ChunkOutput[], maxTokens: number): ChunkOutput[] {
    if (this.overlapTokens <= 0 || chunks.length <= 1) return chunks;

    const result: ChunkOutput[] = [chunks[0]!];
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const curr = chunks[i]!;
      const tail = this.takeTrailingWords(prev.content, this.overlapTokens);
      if (!tail) {
        result.push(curr);
        continue;
      }
      let merged = `${tail} ${curr.content}`;
      let tokens = estimateTokens(merged);
      if (tokens > maxTokens) {
        // Trim from the head of the overlap until we fit. This preserves the
        // semantic "current chunk" content and only sacrifices overlap.
        const overflow = tokens - maxTokens;
        const tailWords = tail.split(/\s+/);
        // Conservative: drop overflow * (1 / 1.3) words (inverse of estimate ratio).
        const dropWords = Math.min(tailWords.length, Math.ceil(overflow / 1.3));
        const trimmedTail = tailWords.slice(dropWords).join(" ");
        merged = trimmedTail ? `${trimmedTail} ${curr.content}` : curr.content;
        tokens = estimateTokens(merged);
      }
      result.push({ content: merged, tokenCount: tokens });
    }
    return result;
  }

  private takeTrailingWords(text: string, targetTokens: number): string {
    if (targetTokens <= 0) return "";
    const words = text.split(/\s+/).filter(Boolean);
    // Inverse of estimateTokens (words * 1.3): wordsNeeded ≈ tokens / 1.3.
    const wordsNeeded = Math.max(1, Math.ceil(targetTokens / 1.3));
    return words.slice(-wordsNeeded).join(" ");
  }
}
