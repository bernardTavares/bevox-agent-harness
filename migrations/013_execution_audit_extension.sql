-- Migration: 013_execution_audit_extension
--
-- PERM-03 (audit ref: runtime-gap-audit-2026-06-02): extend `permission_audit`
-- to capture not just filter-time allow/deny decisions, but ALSO sensitive
-- runtime actions that today leave no auditable trace:
--   - escalation: Model-C `request-human` / `send-message` STOP signals
--   - mutation_execution: tools with side effects (create-appointment,
--     cancel-appointment, reschedule-appointment, waitlist-add, send-message)
--
-- Design choice: extend the existing table (NOT a new `execution_audit`
-- table) for forensic ergonomics — a single SQL query by `execution_id`
-- returns the full audit trail (filter decisions + escalations + mutations)
-- in one ordered stream. Backward-compat preserved via `DEFAULT 'filter_evaluation'`
-- on `action_type`.
--
-- The `decision` and `layer` CHECK constraints are loosened to make the
-- columns optional for non-filter rows: filter rows still populate them;
-- escalation/mutation rows leave them NULL (the action_type carries the
-- semantics).
--
-- Invariant 12.12 (rastreabilidade de ações sensíveis) — pré-condição de GA.
--
-- =============================================================
-- UP
-- =============================================================

-- Loosen NOT NULL on `decision` and `layer` so escalation/mutation rows can
-- omit them. Existing rows are unaffected (all populated).
ALTER TABLE public.permission_audit
  ALTER COLUMN decision DROP NOT NULL;

ALTER TABLE public.permission_audit
  ALTER COLUMN layer DROP NOT NULL;

-- New columns. All nullable / defaulted for backward-compat with existing rows.
ALTER TABLE public.permission_audit
  ADD COLUMN IF NOT EXISTS action_type TEXT NOT NULL DEFAULT 'filter_evaluation'
    CHECK (action_type IN (
      'filter_evaluation',     -- legacy default; allow/deny from permission filter
      'escalation',            -- request-human, send-message STOP signal
      'mutation_execution'     -- side-effect tool actually invoked
    ));

ALTER TABLE public.permission_audit
  ADD COLUMN IF NOT EXISTS action_details JSONB;

ALTER TABLE public.permission_audit
  ADD COLUMN IF NOT EXISTS result TEXT
    CHECK (result IS NULL OR result IN ('success', 'failure', 'pending_approval'));

ALTER TABLE public.permission_audit
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Index for "all escalations in a given execution" and "all mutations by agent"
-- queries called out in the issue's operational queries section.
CREATE INDEX IF NOT EXISTS idx_permission_audit_action_type
  ON public.permission_audit(action_type, created_at DESC)
  WHERE action_type <> 'filter_evaluation';

-- =============================================================
-- DOWN
-- =============================================================
-- DROP INDEX IF EXISTS public.idx_permission_audit_action_type;
-- ALTER TABLE public.permission_audit DROP COLUMN IF EXISTS error_message;
-- ALTER TABLE public.permission_audit DROP COLUMN IF EXISTS result;
-- ALTER TABLE public.permission_audit DROP COLUMN IF EXISTS action_details;
-- ALTER TABLE public.permission_audit DROP COLUMN IF EXISTS action_type;
-- -- NOTE: NOT restoring NOT NULL on decision/layer; that would require
-- -- backfilling values for non-filter rows. Down is reference-only.
