export interface ContextInput {
  executionId: string;
  organizationId: string;
  /**
   * M7: optional at runtime — the ReAct/Model-C handler resolves it as
   * `bigint | undefined`. When absent, MemoryLayer returns an empty block
   * (its contact_profiles/contact_facts queries require a contact_id).
   */
  contactId?: bigint;
  conversationKey: string;
  agentConfig: {
    systemPrompt: string;
    maxContextTokens?: number; // overrides global default if set
  };
  // Raw dispatch payload fields passed through by ExecutionHandler
  dispatchPayload: Record<string, unknown>;
  /**
   * Sprint D.3 — Latest user message (verbatim). Required for semantic recall
   * to embed and search against historical messages. Optional for backward
   * compatibility; when absent, MemoryLayer skips the semantic recall section.
   */
  userMessage?: string;
  /**
   * Optional token budget hint propagated from the orchestrator. When set,
   * MemoryLayer will cap added D.3 sections to leave headroom.
   */
  tokenBudget?: number;
}

export interface ContextBlock {
  section: string; // e.g. "## Configuracao base"
  content: string; // formatted markdown text
  tokenEstimate: number; // estimated token count for this block
  priority: number; // lower = higher priority (never truncated first)
  compressible: boolean; // false = never truncated (BaseConfig, Rules)
}

export interface BuiltContext {
  systemPrompt: string;
  totalTokens: number;
  layersUsed: string[]; // = blocks.map(b => b.section) (section headings — m1)
  compressed: boolean;
  /** NOVO: ordered blocks (by priority) so callers can split head/tail. */
  blocks: ContextBlock[];
  /** NOVO: names of layers that failed/timed out (fail-open). */
  layersFailed: string[];
  /** Subset of layersFailed whose error was NOT a known timeout/DB error (alarm-worthy). */
  layersFailedUnexpected: string[];
}

export interface ContextLayer {
  name: string;
  priority: number; // 10=BaseConfig, 20=Rules, 30=Calendar, 40=Memory, 50=History
  compressible: boolean;
  build(input: ContextInput): Promise<ContextBlock>;
}
