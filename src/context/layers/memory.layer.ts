import type { Pool } from "pg";

import type { ContactFactsRepository } from "../../memory/contact-facts.repository.js";
import type { SemanticRecall } from "../../memory/semantic-recall.js";
import { estimateTokens } from "../tokenizer.js";
import type { ContextInput, ContextBlock, ContextLayer } from "../types.js";

interface ProfileRow {
  full_name: string | null;
  preferred_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  preferred_language: string | null;
  last_interaction_at: Date | null;
  total_interactions: number;
}

interface FactRow {
  fact_key: string;
  fact_value: string;
  category: string | null;
  confidence: string;
  confirmed: boolean;
}

/**
 * Sprint D.3 — knobs for the two new memory sections.
 *
 * Disabled defaults preserve pre-D.3 behaviour (zero regression). The
 * bootstrap wires concrete instances only when MEMORY_*_ENABLED is true.
 */
export interface MemoryLayerOptions {
  semanticRecall?: SemanticRecall;
  factsRepo?: ContactFactsRepository;
  semanticRecallTopK?: number;
  semanticRecallMinScore?: number;
  semanticRecallExcludeRecent?: number;
  /**
   * Maximum truncation length for a single recalled message body. Default 200.
   */
  recallContentTruncate?: number;
}

export class MemoryLayer implements ContextLayer {
  readonly name = "memory";
  readonly priority = 40;
  readonly compressible = true;

  private readonly opts: MemoryLayerOptions;

  constructor(
    private readonly db: Pool,
    opts: MemoryLayerOptions = {},
  ) {
    this.opts = opts;
  }

  async build(input: ContextInput): Promise<ContextBlock> {
    // M7: contactId is optional at runtime. The contact_profiles/contact_facts
    // queries below require a contact_id; without one, skip all I/O and return
    // an empty block (fail-open, no regression).
    if (input.contactId == null) {
      return {
        section: "## Informacoes do contato",
        content: "",
        tokenEstimate: 0,
        priority: this.priority,
        compressible: this.compressible,
      };
    }

    const [profileResult, factsResult] = await Promise.all([
      this.db.query<ProfileRow>(
        `SELECT full_name, preferred_name, phone, email, address, city, state,
                  preferred_language, last_interaction_at, total_interactions
           FROM contact_profiles
           WHERE organization_id = $1 AND contact_id = $2
           LIMIT 1`,
        [input.organizationId, input.contactId],
      ),
      this.db.query<FactRow>(
        `SELECT fact_key, fact_value, category, confidence, confirmed
           FROM contact_facts
           WHERE organization_id = $1 AND contact_id = $2 AND superseded_by IS NULL
             AND (category IS NULL OR category <> 'summary')
           ORDER BY confidence DESC, extracted_at DESC`,
        [input.organizationId, input.contactId],
      ),
    ]);

    const profile = profileResult.rows[0];
    const facts = factsResult.rows;
    const lines: string[] = [];

    if (profile) {
      if (profile.full_name) {
        const nameStr = profile.preferred_name
          ? `${profile.full_name} (prefere: ${profile.preferred_name})`
          : profile.full_name;
        lines.push(`- Nome: ${nameStr}`);
      }
      if (profile.phone) lines.push(`- Telefone: ${profile.phone}`);
      if (profile.email) lines.push(`- Email: ${profile.email}`);
      if (profile.city || profile.state) {
        lines.push(`- Localizacao: ${[profile.city, profile.state].filter(Boolean).join(", ")}`);
      }
      if (profile.last_interaction_at) {
        lines.push(
          `- Ultima interacao: ${profile.last_interaction_at.toISOString().split("T")[0]}`,
        );
      }

      if (facts.length > 0) {
        lines.push("");
        lines.push("### Fatos conhecidos");
        for (const fact of facts) {
          const cat = fact.category ? `[${fact.category}] ` : "";
          lines.push(`- ${cat}${fact.fact_key}: ${fact.fact_value}`);
        }
      }
    }

    // ---- Sprint D.3: Section "Resumo de interações passadas" -------------
    if (this.opts.factsRepo) {
      try {
        const summaries = await this.opts.factsRepo.findSummaries(
          input.organizationId,
          input.contactId,
        );
        if (summaries.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push("### Resumo de interacoes passadas");
          for (const s of summaries) {
            const when = s.extractedAt.toISOString().slice(0, 10);
            lines.push(`- [${when}] ${s.factValue}`);
          }
        }
      } catch {
        // Non-fatal: missing source_agent column on old DB shouldn't break
        // context build.
      }
    }

    // ---- Sprint D.3: Section "Memorias semanticamente relevantes" --------
    // Skip when budget is tight or no user message available.
    const budgetOk =
      !input.tokenBudget || estimateTokens(lines.join("\n")) < input.tokenBudget - 200;
    if (this.opts.semanticRecall && input.userMessage && budgetOk) {
      try {
        const recalled = await this.opts.semanticRecall.recall({
          query: input.userMessage,
          organizationId: input.organizationId,
          contactId: input.contactId,
          topK: this.opts.semanticRecallTopK,
          minScore: this.opts.semanticRecallMinScore,
          excludeRecent: this.opts.semanticRecallExcludeRecent,
        });
        if (recalled.length > 0) {
          const truncateTo = this.opts.recallContentTruncate ?? 200;
          if (lines.length > 0) lines.push("");
          lines.push("### Memorias semanticamente relevantes");
          for (const m of recalled) {
            const when = m.messageAt.toISOString().slice(0, 10);
            const truncated =
              m.content.length > truncateTo ? `${m.content.slice(0, truncateTo)}...` : m.content;
            lines.push(`- [${when}] (${m.role}, score ${m.score.toFixed(2)}): ${truncated}`);
          }
        }
      } catch {
        // Non-fatal: recall failures must NEVER block execution.
      }
    }

    if (!profile && lines.length === 0) {
      return {
        section: "## Informacoes do contato",
        content: "",
        tokenEstimate: 0,
        priority: this.priority,
        compressible: this.compressible,
      };
    }

    const content = lines.join("\n");
    return {
      section: "## Informacoes do contato",
      content,
      tokenEstimate: estimateTokens("## Informacoes do contato\n" + content),
      priority: this.priority,
      compressible: this.compressible,
    };
  }
}
