/**
 * Sprint D.3 — Pure condense decision logic.
 *
 * Given the set of messages not yet covered by a summary, decide whether to
 * run the memory-condenser agent now. Pure function — no IO — to make
 * exhaustive testing cheap.
 *
 * Three signals (any one triggers):
 *   1. messages_threshold: >= thresholdMessages new messages
 *   2. tokens_threshold:   >= thresholdTokens new tokens
 *   3. time_threshold:     lastCondenseAt is older than thresholdDays AND at
 *                          least 5 new messages exist (avoids condensing trivia)
 */

export type CondenseReason = "messages_threshold" | "tokens_threshold" | "time_threshold";

export interface CondenseSignal {
  shouldCondense: boolean;
  reason?: CondenseReason;
  messageIdsToCondense: string[];
}

export interface CondenseCandidateMessage {
  messageId: string;
  tokenCount: number;
  messageAt: Date;
}

export interface CondenseHeuristicConfig {
  thresholdMessages: number;
  thresholdTokens: number;
  thresholdDays?: number;
  /** Minimum messages required for a time-trigger to fire. Default 5. */
  timeMinMessages?: number;
  /** Override Date.now() for tests. */
  now?: () => number;
}

export interface CondenseHeuristicInput {
  organizationId: string;
  contactId: bigint;
  newMessagesSinceLastCondense: CondenseCandidateMessage[];
  lastCondenseAt?: Date | null;
  config: CondenseHeuristicConfig;
}

export function evaluateCondenseSignal(input: CondenseHeuristicInput): CondenseSignal {
  const msgs = input.newMessagesSinceLastCondense;
  const { config } = input;

  if (msgs.length >= config.thresholdMessages) {
    return {
      shouldCondense: true,
      reason: "messages_threshold",
      messageIdsToCondense: msgs.map((m) => m.messageId),
    };
  }

  const totalTokens = msgs.reduce((acc, m) => acc + (m.tokenCount ?? 0), 0);
  if (totalTokens >= config.thresholdTokens) {
    return {
      shouldCondense: true,
      reason: "tokens_threshold",
      messageIdsToCondense: msgs.map((m) => m.messageId),
    };
  }

  if (config.thresholdDays && input.lastCondenseAt) {
    const nowMs = (config.now ?? Date.now)();
    const daysAgo = (nowMs - input.lastCondenseAt.getTime()) / (1000 * 60 * 60 * 24);
    const minMsgs = config.timeMinMessages ?? 5;
    if (daysAgo >= config.thresholdDays && msgs.length >= minMsgs) {
      return {
        shouldCondense: true,
        reason: "time_threshold",
        messageIdsToCondense: msgs.map((m) => m.messageId),
      };
    }
  }

  return { shouldCondense: false, messageIdsToCondense: [] };
}
