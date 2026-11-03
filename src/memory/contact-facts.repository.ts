import type { Pool, PoolClient } from "pg";

import type { ContactFact, NewContactFact } from "./types.js";

export class ContactFactsRepository {
  constructor(private readonly db: Pool) {}

  async listActive(organizationId: string, contactId: bigint): Promise<ContactFact[]> {
    const result = await this.db.query(
      `SELECT * FROM contact_facts
       WHERE organization_id = $1 AND contact_id = $2 AND superseded_by IS NULL
       ORDER BY extracted_at DESC`,
      [organizationId, contactId],
    );
    return result.rows.map(this.mapRow);
  }

  async insert(fact: NewContactFact, client?: PoolClient): Promise<ContactFact> {
    const executor = client ?? this.db;
    const result = await executor.query(
      `INSERT INTO contact_facts
         (organization_id, contact_id, fact_key, fact_value, category,
          confidence, source_conversation_key, source_execution_id,
          source_agent, confirmed, extracted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       RETURNING *`,
      [
        fact.organizationId,
        fact.contactId,
        fact.factKey,
        fact.factValue,
        fact.category ?? null,
        fact.confidence,
        fact.sourceConversationKey ?? null,
        fact.sourceExecutionId ?? null,
        fact.sourceAgent ?? null,
        fact.confidence >= 0.8, // confirmed if high confidence
      ],
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Sprint D.3 — returns active summary facts (category='summary') for the
   * MemoryLayer "Resumo de interações passadas" section. Newest first;
   * caps at 5 to bound prompt size.
   */
  async findSummaries(
    organizationId: string,
    contactId: bigint,
    limit = 5,
  ): Promise<ContactFact[]> {
    const result = await this.db.query(
      `SELECT * FROM contact_facts
       WHERE organization_id = $1 AND contact_id = $2
         AND category = 'summary' AND superseded_by IS NULL
       ORDER BY extracted_at DESC
       LIMIT $3`,
      [organizationId, contactId, limit],
    );
    return result.rows.map(this.mapRow);
  }

  async supersede(oldFactId: bigint, newFactId: bigint, client?: PoolClient): Promise<void> {
    const executor = client ?? this.db;
    await executor.query(
      `UPDATE contact_facts
       SET superseded_by = $2, updated_at = now()
       WHERE id = $1`,
      [oldFactId, newFactId],
    );
  }

  async upsertFact(fact: NewContactFact, client: PoolClient): Promise<ContactFact> {
    // Find current active fact for this key
    const existing = await client.query(
      `SELECT id FROM contact_facts
       WHERE organization_id = $1 AND contact_id = $2 AND fact_key = $3 AND superseded_by IS NULL
       ORDER BY extracted_at DESC
       LIMIT 1`,
      [fact.organizationId, fact.contactId, fact.factKey],
    );

    const newFact = await this.insert(fact, client);

    if (existing.rows.length > 0) {
      await this.supersede(BigInt(existing.rows[0].id), newFact.id, client);
    }

    return newFact;
  }

  private mapRow(row: Record<string, unknown>): ContactFact {
    return {
      id: BigInt(row.id as string),
      organizationId: row.organization_id as string,
      contactId: BigInt(row.contact_id as string),
      factKey: row.fact_key as string,
      factValue: row.fact_value as string,
      category: row.category as string | null,
      confidence: parseFloat(row.confidence as string),
      sourceConversationKey: row.source_conversation_key as string | null,
      sourceExecutionId: row.source_execution_id as string | null,
      sourceAgent: (row.source_agent as string | null | undefined) ?? null,
      extractedAt: new Date(row.extracted_at as string),
      confirmed: row.confirmed as boolean,
      supersededBy: row.superseded_by != null ? BigInt(row.superseded_by as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
