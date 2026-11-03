import type { Pool } from "pg";

import { estimateTokens } from "../tokenizer.js";
import type { ContextInput, ContextBlock, ContextLayer } from "../types.js";

interface RuleRow {
  id: number;
  description: string;
}

export class RulesLayer implements ContextLayer {
  readonly name = "rules";
  readonly priority = 20;
  readonly compressible = false;

  constructor(private readonly db: Pool) {}

  async build(input: ContextInput): Promise<ContextBlock> {
    const { rows } = await this.db.query<RuleRow>(
      `SELECT id, description
       FROM rules
       WHERE organization_id = $1
         AND active = true
         AND destination = 'human'
       ORDER BY id ASC`,
      [input.organizationId],
    );

    const content =
      rows.length === 0 ? "" : rows.map((r, i) => `${i + 1}. ${r.description}`).join("\n");

    return {
      section: "## Regras de encaminhamento",
      content,
      tokenEstimate: estimateTokens("## Regras de encaminhamento\n" + content),
      priority: this.priority,
      compressible: this.compressible,
    };
  }
}
