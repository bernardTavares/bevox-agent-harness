export interface ContactProfile {
  id: number;
  organizationId: string;
  contactId: bigint;

  // Personal data
  fullName: string | null;
  preferredName: string | null;
  birthDate: Date | null;
  gender: string | null;
  documentNumber: string | null;

  // Contact
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;

  // Preferences
  preferredLanguage: string;
  preferredContactChannel: string | null;
  preferredTimeFrom: string | null; // TIME stored as HH:MM:SS string
  preferredTimeTo: string | null;

  // Metadata
  firstSeenAt: Date;
  lastInteractionAt: Date | null;
  totalInteractions: number;

  createdAt: Date;
  updatedAt: Date;
}

export type ContactProfileFields = Partial<
  Omit<
    ContactProfile,
    "id" | "organizationId" | "contactId" | "firstSeenAt" | "createdAt" | "updatedAt"
  >
>;

export interface ContactFact {
  id: bigint;
  organizationId: string;
  contactId: bigint;

  factKey: string;
  factValue: string;
  category: string | null;

  confidence: number;
  sourceConversationKey: string | null;
  sourceExecutionId: string | null;
  /** Sprint D.3 — agent that emitted this fact (e.g. "memory-condenser"). */
  sourceAgent: string | null;
  extractedAt: Date;

  confirmed: boolean;
  supersededBy: bigint | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface NewContactFact {
  organizationId: string;
  contactId: bigint;
  factKey: string;
  factValue: string;
  category?: string;
  confidence: number;
  sourceConversationKey?: string;
  sourceExecutionId?: string;
  /** Sprint D.3 — populated by memory-condenser; null/undefined elsewhere. */
  sourceAgent?: string;
}
