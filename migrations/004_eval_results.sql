-- Sprint A.2 (evals): persist scorer outputs for production sampling +
-- offline golden-set runs. account_id is INTEGER without FK to accounts(id)
-- following the convention from 003_execution_usage.sql (the accounts table
-- lives in the Bevox DB, not the harness DB).
--
-- `score` is nullable on purpose: FaithfulnessScorer returns NULL when no
-- grounding context is provided, instead of inflating dashboard averages
-- with a "1.0 N/A". Dashboards must filter `score IS NOT NULL`.

-- UP
CREATE TABLE IF NOT EXISTS eval_results (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL,
  account_id INTEGER NOT NULL,
  scorer_name TEXT NOT NULL,
  scorer_kind TEXT NOT NULL CHECK (scorer_kind IN ('llm-judge', 'rule', 'statistical')),
  score NUMERIC(4, 3) CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  reasoning TEXT NOT NULL,
  model_used TEXT,
  sampling_reason TEXT NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_results_execution
  ON eval_results(execution_id);

CREATE INDEX IF NOT EXISTS idx_eval_results_scorer_day
  ON eval_results(scorer_name, created_at);

CREATE INDEX IF NOT EXISTS idx_eval_results_account_score
  ON eval_results(account_id, score);

-- DOWN
-- DROP TABLE IF EXISTS eval_results;
