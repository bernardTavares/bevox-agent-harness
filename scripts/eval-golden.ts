#!/usr/bin/env tsx
/**
 * CLI: npm run eval:golden -- --dataset <path.jsonl> [--scorers <list>] [--out <path>] [--model <model>]
 *
 * Iterates a JSONL file of test cases and runs the configured scorers over
 * each. Pure scoring run — does NOT invoke the agent. Cases provide an
 * `output` field (historical replay) or scorers that don't need an LLM
 * (rule/statistical) run for free.
 *
 * Uses Node's built-in `node:util` parseArgs — no commander dependency.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";
import { parseArgs } from "node:util";

import { createLLMGateway } from "../src/integration/llm-gateway.js";
import { EvalRunner } from "../src/evals/runner.js";
import { buildScorers } from "../src/evals/scorer-factory.js";
import type { ScorerInput, ScorerResult } from "../src/evals/scorer.js";
import type { RunnerResult } from "../src/evals/runner.js";

interface CliOptions {
  dataset: string;
  scorers: string;
  out: string;
  model: string;
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string" },
      scorers: { type: "string", default: "no-pii,answer-length" },
      out: { type: "string", default: "./eval-report.json" },
      model: { type: "string", default: "gpt-4o-mini" },
    },
    allowPositionals: false,
  });
  if (!values.dataset) {
    console.error(
      "Usage: tsx scripts/eval-golden.ts --dataset <path.jsonl> [--scorers a,b,c] [--out path] [--model name]",
    );
    process.exit(2);
  }
  return {
    dataset: values.dataset,
    scorers: values.scorers ?? "no-pii,answer-length",
    out: values.out ?? "./eval-report.json",
    model: values.model ?? "gpt-4o-mini",
  };
}

interface GoldenCase {
  id: string;
  input: string;
  /** If absent, scored as empty string (still useful for `answer-length`). */
  output?: string;
  context?: ScorerInput["context"];
}

interface CaseReport {
  id: string;
  scores: Array<{
    scorer: string;
    kind: string;
    score: number | null;
    reasoning?: string;
    error?: string;
  }>;
}

interface Summary {
  total_cases: number;
  per_scorer: Record<
    string,
    { runs: number; failures: number; avg: number | null; below_0_5: number }
  >;
}

function aggregate(reports: CaseReport[]): Summary {
  const perScorer: Summary["per_scorer"] = {};
  for (const report of reports) {
    for (const s of report.scores) {
      const e =
        perScorer[s.scorer] ??
        (perScorer[s.scorer] = { runs: 0, failures: 0, avg: 0, below_0_5: 0 });
      e.runs++;
      if (s.error || s.score === null) {
        if (s.error) e.failures++;
        continue;
      }
      e.avg = (e.avg ?? 0) + s.score;
      if (s.score < 0.5) e.below_0_5++;
    }
  }
  for (const k of Object.keys(perScorer)) {
    const e = perScorer[k];
    const scored = e.runs - e.failures;
    e.avg = scored > 0 ? Number(((e.avg ?? 0) / scored).toFixed(3)) : null;
  }
  return { total_cases: reports.length, per_scorer: perScorer };
}

async function main(): Promise<void> {
  const opts = parseCliArgs();

  const scorerNames = opts.scorers.split(",").map((s) => s.trim()).filter(Boolean);
  const needsLlm = scorerNames.some((n) =>
    ["relevancy", "toxicity", "faithfulness"].includes(n),
  );
  const gateway = needsLlm ? createLLMGateway({ default_model: opts.model }) : undefined;
  const scorers = buildScorers(scorerNames, { gateway, judgeModel: opts.model });
  if (scorers.length === 0) {
    console.error(`No scorers resolved for: ${opts.scorers}`);
    process.exit(2);
  }
  const runner = new EvalRunner(scorers);

  const stream = readline.createInterface({
    input: fs.createReadStream(opts.dataset),
    crlfDelay: Infinity,
  });

  const reports: CaseReport[] = [];
  for await (const line of stream) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let tc: GoldenCase;
    try {
      tc = JSON.parse(trimmed) as GoldenCase;
    } catch (err) {
      console.warn(`Skipping invalid JSONL line: ${(err as Error).message}`);
      continue;
    }
    const input: ScorerInput = {
      input: tc.input,
      output: tc.output ?? "",
      context: tc.context,
      meta: {
        execution_id: tc.id,
        account_id: 0,
        agent_name: "golden",
        reasoning_engine: "n/a",
      },
    };
    const results: RunnerResult[] = await runner.run(input);
    reports.push({
      id: tc.id,
      scores: results.map((r) => {
        if ("error" in r.result) {
          return { scorer: r.scorer, kind: r.kind, score: null, error: r.result.error };
        }
        const ok = r.result as ScorerResult;
        return {
          scorer: r.scorer,
          kind: r.kind,
          score: ok.score,
          reasoning: ok.reasoning,
        };
      }),
    });
  }

  const summary = aggregate(reports);
  fs.writeFileSync(
    opts.out,
    JSON.stringify({ summary, results: reports }, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
