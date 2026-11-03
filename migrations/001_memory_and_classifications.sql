-- Migration: 001_memory_and_classifications
-- Creates contact_profiles, contact_facts, and message_classifications tables.
-- Run against the Bevox shared database (BEVOX_DB_URL).

-- =============================================================
-- UP
-- =============================================================

CREATE TABLE public.contact_profiles (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  contact_id BIGINT NOT NULL,

  -- Personal data
  full_name TEXT,
  preferred_name TEXT,
  birth_date DATE,
  gender TEXT,
  document_number TEXT,

  -- Contact
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  state TEXT,

  -- Preferences
  preferred_language TEXT DEFAULT 'pt-BR',
  preferred_contact_channel TEXT,
  preferred_time_from TIME,
  preferred_time_to TIME,

  -- Metadata
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_interaction_at TIMESTAMPTZ,
  total_interactions INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(account_id, contact_id)
);

CREATE INDEX idx_contact_profiles_account ON contact_profiles(account_id);
CREATE INDEX idx_contact_profiles_contact ON contact_profiles(contact_id);

-- -------------------------------------------------------

CREATE TABLE public.contact_facts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  contact_id BIGINT NOT NULL,

  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  category TEXT,

  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_conversation_key TEXT,
  source_execution_id UUID,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  confirmed BOOLEAN NOT NULL DEFAULT false,
  superseded_by BIGINT REFERENCES contact_facts(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_facts_lookup ON contact_facts(account_id, contact_id, fact_key);
CREATE INDEX idx_contact_facts_category ON contact_facts(account_id, contact_id, category);
CREATE INDEX idx_contact_facts_active ON contact_facts(account_id, contact_id)
  WHERE superseded_by IS NULL;

-- -------------------------------------------------------

CREATE TABLE public.message_classifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  conversation_key TEXT NOT NULL,
  message_id BIGINT,
  execution_id UUID,

  sentiment TEXT NOT NULL CHECK (sentiment IN (
    'positive', 'neutral', 'negative', 'frustrated', 'angry', 'confused'
  )),
  sentiment_confidence NUMERIC(4,3) NOT NULL CHECK (sentiment_confidence >= 0 AND sentiment_confidence <= 1),

  intent TEXT,
  intent_confidence NUMERIC(4,3) CHECK (intent_confidence >= 0 AND intent_confidence <= 1),

  topics TEXT[],

  urgency TEXT CHECK (urgency IN ('low', 'medium', 'high', 'critical')),

  model_used TEXT,
  processing_ms INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_msg_class_account_conv ON message_classifications(account_id, conversation_key);
CREATE INDEX idx_msg_class_sentiment ON message_classifications(account_id, sentiment);
CREATE INDEX idx_msg_class_intent ON message_classifications(account_id, intent);
CREATE INDEX idx_msg_class_created ON message_classifications(account_id, created_at DESC);

-- =============================================================
-- DOWN
-- =============================================================

-- DROP TABLE IF EXISTS public.message_classifications;
-- DROP TABLE IF EXISTS public.contact_facts;
-- DROP TABLE IF EXISTS public.contact_profiles;
