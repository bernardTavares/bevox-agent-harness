import type { Pool, PoolClient } from "pg";

import type { ContactProfile, ContactProfileFields } from "./types.js";

export class ContactProfileRepository {
  constructor(private readonly db: Pool) {}

  async findByContact(organizationId: string, contactId: bigint): Promise<ContactProfile | null> {
    const result = await this.db.query(
      `SELECT * FROM contact_profiles WHERE organization_id = $1 AND contact_id = $2`,
      [organizationId, contactId],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findOrCreate(organizationId: string, contactId: bigint): Promise<ContactProfile> {
    const result = await this.db.query(
      `INSERT INTO contact_profiles (organization_id, contact_id, first_seen_at, last_interaction_at, total_interactions)
       VALUES ($1, $2, now(), now(), 1)
       ON CONFLICT (organization_id, contact_id) DO UPDATE
         SET last_interaction_at = now(),
             total_interactions = contact_profiles.total_interactions + 1,
             updated_at = now()
       RETURNING *`,
      [organizationId, contactId],
    );
    return this.mapRow(result.rows[0]);
  }

  async update(
    organizationId: string,
    contactId: bigint,
    fields: ContactProfileFields,
    client?: PoolClient,
  ): Promise<void> {
    // Whitelist of allowed columns. Any key not in this map is rejected to
    // prevent silent malformed SQL (e.g. `undefined = $N`) when callers pass
    // unexpected fields. Values are always parameterized.
    const columnMap: Record<string, string> = ContactProfileRepository.columnMap;

    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    for (const [key] of entries) {
      if (!Object.prototype.hasOwnProperty.call(columnMap, key)) {
        throw new Error(`ContactProfile.update: unknown column "${key}"`);
      }
    }
    if (entries.length === 0) return;

    const setClauses = entries.map(([key], i) => `${columnMap[key]} = $${i + 3}`);
    setClauses.push("updated_at = now()");

    const values = entries.map(([, v]) => v);
    const sql = `UPDATE contact_profiles SET ${setClauses.join(", ")}
                 WHERE organization_id = $1 AND contact_id = $2`;

    const executor = client ?? this.db;
    await executor.query(sql, [organizationId, contactId, ...values]);
  }

  private static readonly columnMap: Record<string, string> = {
    fullName: "full_name",
    preferredName: "preferred_name",
    birthDate: "birth_date",
    gender: "gender",
    documentNumber: "document_number",
    phone: "phone",
    email: "email",
    address: "address",
    city: "city",
    state: "state",
    preferredLanguage: "preferred_language",
    preferredContactChannel: "preferred_contact_channel",
    preferredTimeFrom: "preferred_time_from",
    preferredTimeTo: "preferred_time_to",
    lastInteractionAt: "last_interaction_at",
    totalInteractions: "total_interactions",
  };

  private mapRow(row: Record<string, unknown>): ContactProfile {
    return {
      id: row.id as number,
      organizationId: row.organization_id as string,
      contactId: BigInt(row.contact_id as string),
      fullName: row.full_name as string | null,
      preferredName: row.preferred_name as string | null,
      birthDate: row.birth_date ? new Date(row.birth_date as string) : null,
      gender: row.gender as string | null,
      documentNumber: row.document_number as string | null,
      phone: row.phone as string | null,
      email: row.email as string | null,
      address: row.address as string | null,
      city: row.city as string | null,
      state: row.state as string | null,
      preferredLanguage: (row.preferred_language as string) ?? "pt-BR",
      preferredContactChannel: row.preferred_contact_channel as string | null,
      preferredTimeFrom: row.preferred_time_from as string | null,
      preferredTimeTo: row.preferred_time_to as string | null,
      firstSeenAt: new Date(row.first_seen_at as string),
      lastInteractionAt: row.last_interaction_at
        ? new Date(row.last_interaction_at as string)
        : null,
      totalInteractions: row.total_interactions as number,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
