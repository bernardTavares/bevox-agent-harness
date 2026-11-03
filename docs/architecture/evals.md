# Evals / Scorers

> Sprint A.2. Continuous quality framework for agent responses. Inspired by
> [Mastra Scorers](https://mastra.ai/docs/scorers).

## Two execution modes

### Production: sampling → queue → worker → DB

```
execution-handler.ts
   sendComplete()           ← Bevox callback (hot path ends here)
   ↓
runPostExecutionHooks([
   createEvalSamplingHook()
])
   ↓
shouldSample(policy, { execution_id, tags })
   ↓ if sample
EvalQueue.enqueue → BullMQ "execution.evals"
   ↓
EvalWorker (separate BullMQ Worker; can run in same process or
isolated via EVALS_WORKER_ENABLED=true on its own deployment)
   ↓
EvalRunner.run() → N scorers in parallel
   ↓
EvalResultsRepository → INSERT INTO eval_results
```

Key invariants:
- Hook runs **after** `sendComplete()`. A hook failure NEVER propagates
  back to Bevox.
- `execution.evals` is a **dedicated** queue — it does not compete with
  `bevox.execution.dispatch`.
- Sampling policy is validated at boot via Zod (`samplingPolicySchema`).
  Invalid JSON in `EVALS_SAMPLING_POLICY` fails fast — does NOT silently
  skip sampling.
- `score NUMERIC(4,3)` is **nullable**. `FaithfulnessScorer` returns
  `score: null` when no grounding context is available, so dashboards must
  filter `score IS NOT NULL` when computing averages.

### Offline: CLI against a golden JSONL

```
npm run eval:golden -- --dataset tests/fixtures/golden-sets/example.jsonl
```

JSONL format:
```json
{"id": "case-001", "input": "user message", "output": "agent response", "context": {"facts": [...], "knowledge": [...]}}
```

CLI flags (Node built-in `parseArgs`):
- `--dataset <path>` (required) — JSONL file path
- `--scorers <list>` — comma-separated scorer names (default
  `no-pii,answer-length` — rule/statistical only, no LLM cost)
- `--out <path>` — output JSON report (default `./eval-report.json`)
- `--model <name>` — judge model (default `gpt-4o-mini`)

Output report has `summary.per_scorer` with average score, run count,
failure count, and `below_0_5` regression counter.

## Built-in scorers

| Name | Kind | Higher = | Notes |
|---|---|---|---|
| `relevancy` | llm-judge | better | Does response address the question? |
| `toxicity` | llm-judge | safer | Convention inverted: 1.0 = clean, 0.0 = toxic. |
| `faithfulness` | llm-judge | grounded | Returns `null` when no facts/knowledge in context. |
| `no-pii` | rule | cleaner | Formatted CPF / email / BR phone. Bare-11-digit regex removed (false positives on IDs/timestamps). |
| `answer-length` | statistical | in-range | Configurable min/max chars (default 20–1500). |
| `custom:<name>` | llm-judge | better | Configurable via `evals.custom_judges[]` (rubric, scoringGuide, useContext). |

## Configuration

### Env vars

```bash
EVALS_ENABLED=true                                # turn ON sampling hook
EVALS_WORKER_ENABLED=true                         # turn ON in-process worker
EVALS_QUEUE_NAME=execution.evals
EVALS_WORKER_CONCURRENCY=2
EVALS_JUDGE_MODEL=gpt-4o-mini
EVALS_SAMPLING_POLICY='{"type":"ratio","rate":0.1}'  # validated at boot
EVALS_SCORERS=relevancy,no-pii,answer-length
```

### Sampling policies

| Type | Shape | Description |
|---|---|---|
| `always` | `{"type":"always"}` | sample every execution |
| `never` | `{"type":"never"}` | default; zero-overhead |
| `ratio` | `{"type":"ratio","rate":0.1}` | sample 10% (rate in [0,1]) |
| `tagged` | `{"type":"tagged","tag":"high-risk"}` | sample if `payload.tags` contains the tag |

### Adding a custom judge

In `harness-config.ts`:
```typescript
evals: {
  custom_judges: [
    {
      name: "calendar-clarity",
      rubric: "Evaluate whether responses about appointments include date, time, and confirmation step.",
      scoringGuide: "1.0 = all three; 0.5 = two of three; 0.0 = missing date or time.",
      useContext: false,
    },
  ],
}
```
Then register the scorer manually at boot or extend `scorer-factory.ts`.

## Cost estimate (LLM-as-judge)

| Knob | Example |
|---|---|
| executions/day | 10,000 |
| sampling rate | 10% (1,000 sampled) |
| LLM judges per execution | 3 (relevancy, toxicity, faithfulness) |
| Avg tokens/judge (in + out) | 800 |
| Model | `gpt-4o-mini` ($0.15/1M input, $0.60/1M output) |
| Daily cost (rough) | ~$0.50 — within order of magnitude of a single conversation |

Future hardening (backlog): per-day budget cap via
`EVALS_DAILY_BUDGET_USD_CENTS`.

## Schema

`migrations/004_eval_results.sql`:
```sql
CREATE TABLE eval_results (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL,
  account_id INTEGER NOT NULL,             -- no FK; accounts lives in Bevox DB
  scorer_name TEXT NOT NULL,
  scorer_kind TEXT NOT NULL CHECK (scorer_kind IN ('llm-judge','rule','statistical')),
  score NUMERIC(4,3) CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  reasoning TEXT NOT NULL,
  model_used TEXT,
  sampling_reason TEXT NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Query examples

Average score per scorer over last 7 days (excluding N/A):
```sql
SELECT scorer_name,
       AVG(score)::numeric(4,3) AS avg_score,
       COUNT(*) FILTER (WHERE score IS NOT NULL) AS scored,
       COUNT(*) FILTER (WHERE score IS NULL) AS not_applicable
FROM eval_results
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY scorer_name
ORDER BY avg_score DESC;
```

Worst executions for relevancy:
```sql
SELECT execution_id, score, reasoning, sampled_at
FROM eval_results
WHERE scorer_name = 'relevancy' AND score < 0.5
ORDER BY sampled_at DESC
LIMIT 50;
```

## Failure model

- Hook enqueue failure → logged warn, swallowed, handler succeeds.
- Worker job retry policy: 2 attempts, exponential backoff. No DLQ —
  evals are not incidents. (Escopo: APENAS o eval worker. O dispatch worker
  tem caminho de erro distinto — ver `fluxo-de-execucao.md`: retenção local
  no `failed` set + `status='dead_letter'` authoritativo no backend.)
- Individual scorer failure inside `EvalRunner.run` → logged warn,
  surfaced as `{ error: string }` in `RunnerResult`, NOT persisted.
- DB insert failure → logged warn (fire-and-forget, mirrors usage-tracker).
