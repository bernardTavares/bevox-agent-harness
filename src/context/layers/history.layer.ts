import type { Pool } from "pg";

import { estimateTokens } from "../tokenizer.js";
import type { ContextInput, ContextBlock, ContextLayer } from "../types.js";

interface MessageRow {
  role: string;
  content: string;
  created_at: Date;
}

interface HistoryLayerOptions {
  windowDays?: number; // how many days of recent history to fetch (default: 5)
  recencyLimitDays?: number; // maximum look-back window (default: 15)
}

export class HistoryLayer implements ContextLayer {
  readonly name = "history";
  readonly priority = 50;
  readonly compressible = true;

  private readonly windowDays: number;
  private readonly recencyLimitDays: number;

  constructor(
    private readonly db: Pool,
    options: HistoryLayerOptions = {},
  ) {
    this.windowDays = options.windowDays ?? parseInt(process.env["HISTORY_WINDOW_DAYS"] ?? "5", 10);
    this.recencyLimitDays =
      options.recencyLimitDays ?? parseInt(process.env["HISTORY_RECENCY_LIMIT_DAYS"] ?? "15", 10);
  }

  async build(input: ContextInput): Promise<ContextBlock> {
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - this.windowDays);

    const recencyStart = new Date();
    recencyStart.setDate(recencyStart.getDate() - this.recencyLimitDays);

    const { rows } = await this.db.query<MessageRow>(
      `SELECT
         CASE
           WHEN m.message_type = 0 THEN 'Cliente'
           WHEN m.message_type = 1 AND m.content_type = 'ai' THEN 'Atendimento Inteligente'
           ELSE 'Atendimento Humano'
         END AS role,
         m.content,
         m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.display_id::text = $1
         AND m.created_at >= $2
         AND m.created_at >= $3
         AND m.content IS NOT NULL
         AND trim(m.content) != ''
       ORDER BY m.created_at ASC`,
      [input.conversationKey, windowStart, recencyStart],
    );

    if (rows.length === 0) {
      return {
        section: "## Historico da conversa",
        content: "",
        tokenEstimate: 0,
        priority: this.priority,
        compressible: this.compressible,
      };
    }

    const content = rows.map((r) => `${r.role}: ${r.content.trim()}`).join("\n");

    return {
      section: "## Historico da conversa",
      content,
      tokenEstimate: estimateTokens("## Historico da conversa\n" + content),
      priority: this.priority,
      compressible: this.compressible,
    };
  }
}
