/**
 * SDR Certification Gates — Fixture-Replay Integration Test
 * Fase A §4.3 / §4.4
 *
 * Proves the SDR cognitive faculty end-to-end:
 *  - With sdr_profile.enabled=true: the real engine produces output that
 *    passes all three certification gates (sdr-audit-gate, sdr-message-ready,
 *    sdr-prospect-ready).
 *  - Without sdr_profile (baseline): the resolved system prompt equals
 *    EXACTLY the input agent_config.system_prompt (zero-cost gate §4.4).
 *
 * Gated by RUN_INTEGRATION=1 (requires real Postgres pgvector + Redis via
 * testcontainers). Uses FakeLLMGateway for deterministic scripted responses.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import IORedis from "ioredis";
import { Pool } from "pg";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setupInfra, applyMigrations } from "../../helpers/integration-setup.js";

const RUN = process.env.RUN_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any imports of these modules
// ---------------------------------------------------------------------------

const callbackMock = vi.hoisted(() => ({
  updateStatus: vi.fn().mockResolvedValue(undefined),
  sendComplete: vi.fn().mockResolvedValue(undefined),
  sendTrace: vi.fn().mockResolvedValue(undefined),
  sendStream: vi.fn().mockResolvedValue(undefined),
  // Real impl pass-through (helper é pure, post-2026-06-02 C2/C3 fix).
  buildCompletePayload: (opts: {
    responseText: string;
    sentiment?: string;
    strategy?: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
    proposals?: unknown[];
  }) => ({
    response_text: opts.responseText,
    sentiment: opts.sentiment ?? "neutral",
    strategy: opts.strategy ?? "direct",
    usage: opts.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
    ...(opts.proposals && opts.proposals.length > 0 ? { proposals: opts.proposals } : {}),
  }),
}));

const gatewayMock = vi.hoisted(() => ({
  createLLMGateway: vi.fn(),
}));

vi.mock("../../../src/integration/bevox-callback", () => callbackMock);
vi.mock("../../../src/integration/llm-gateway", async () => {
  const actual = await vi.importActual<typeof import("../../../src/integration/llm-gateway")>(
    "../../../src/integration/llm-gateway",
  );
  return { ...actual, createLLMGateway: gatewayMock.createLLMGateway };
});

// ---------------------------------------------------------------------------
// Test imports (after mocks)
// ---------------------------------------------------------------------------

import { replaySdrScenario, buildJudgeGateway } from "../../helpers/sdr-replay.js";
import type { SdrScenario } from "../../helpers/sdr-replay.js";
import { buildScorers } from "../../../src/evals/scorer-factory.js";
import { EvalRunner } from "../../../src/evals/runner.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCENARIOS_DIR = join(__dirname, "..", "..", "fixtures", "sdr", "scenarios");

function loadScenario(filename: string): SdrScenario {
  const raw = readFileSync(join(SCENARIOS_DIR, filename), "utf-8");
  return JSON.parse(raw) as SdrScenario;
}

// UUID helpers — deterministic per scenario to avoid dedup collisions across
// test runs (each scenario needs a fresh UUID).
function scenarioUuid(index: number): string {
  const hex = index.toString(16).padStart(4, "0");
  return `8${hex}0000-0000-4000-b000-000000000${hex.padStart(3, "0")}0`;
}

// ---------------------------------------------------------------------------
// Integration suite
// ---------------------------------------------------------------------------

describe.skipIf(!RUN)("SDR certification gates (integration)", () => {
  let teardown: () => Promise<void>;
  let pool: Pool;
  let redis: IORedis;

  beforeAll(async () => {
    // Integration infra — real Postgres (pgvector) + Redis via testcontainers
    const emptyDir = mkdtempSync(join(tmpdir(), "harness-sdr-cert-"));
    const infra = await setupInfra({ migrationsDir: emptyDir });
    teardown = infra.teardown;
    pool = new Pool({ connectionString: infra.databaseUrl });
    redis = new IORedis(infra.redisUrl, { maxRetriesPerRequest: null });

    // Minimal table for organization_id=1 (required by session store)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT);
      INSERT INTO accounts (id, name) VALUES (1, 'sdr-test') ON CONFLICT DO NOTHING;
    `);

    // Apply real migrations (needed for session / eval tables)
    await applyMigrations(infra.databaseUrl, join(__dirname, "..", "..", "..", "migrations"));
  }, 120_000);

  afterAll(async () => {
    await redis?.quit();
    await pool?.end();
    if (teardown) await teardown();
  }, 60_000);

  // ─── §4.3 — SDR-enabled certification gates ────────────────────────────

  it("sdr-enabled-outreach: all 3 certification gates pass", async () => {
    const scenario = loadScenario("sdr-enabled-outreach.json");

    const result = await replaySdrScenario(
      scenario,
      pool,
      redis,
      gatewayMock,
      callbackMock.sendComplete,
      // Unique UUID for this scenario (must not collide with dedup test UUIDs)
      "a0000001-0001-4001-b001-000000000010",
    );

    expect(result.output, "output should be non-empty").toBeTruthy();

    // Build scorers — use separate judge gateway for prospect-ready
    const judgeGateway = buildJudgeGateway(scenario);
    const scorers = buildScorers(["sdr-audit-gate", "sdr-message-ready", "sdr-prospect-ready"], {
      gateway: judgeGateway,
      judgeModel: "fake-judge",
    });
    expect(scorers).toHaveLength(3);

    const runner = new EvalRunner(scorers);
    const runnerResults = await runner.run({
      input: result.input,
      output: result.output,
      context: { system_prompt: result.resolvedSystemPrompt },
      meta: {
        execution_id: "a0000001-0001-4001-b001-000000000010",
        organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        agent_name: "scheduler",
        reasoning_engine: "react",
      },
    });

    // All scorers must return a result (no errors)
    for (const r of runnerResults) {
      expect(r.result, `scorer ${r.scorer} should not error`).not.toHaveProperty("error");
    }

    const auditGate = runnerResults.find((r) => r.scorer === "sdr-audit-gate");
    const messageReady = runnerResults.find((r) => r.scorer === "sdr-message-ready");
    const prospectReady = runnerResults.find((r) => r.scorer === "sdr-prospect-ready");

    expect(auditGate, "sdr-audit-gate result missing").toBeDefined();
    expect(messageReady, "sdr-message-ready result missing").toBeDefined();
    expect(prospectReady, "sdr-prospect-ready result missing").toBeDefined();

    // §4.3 certification thresholds
    expect(
      (auditGate!.result as { score: number }).score,
      "sdr-audit-gate must score 1 (no unsubstantiated qualification claim)",
    ).toBe(1);

    expect(
      (messageReady!.result as { score: number }).score,
      "sdr-message-ready must score 1 (no forbidden phrase, exactly one CTA)",
    ).toBe(1);

    expect(
      (prospectReady!.result as { score: number }).score,
      "sdr-prospect-ready must score >= 0.7",
    ).toBeGreaterThanOrEqual(0.7);

    // §4.3 — resolvedSystemPrompt must include SDR doctrine
    expect(
      result.resolvedSystemPrompt,
      "resolved system prompt must contain SDR doctrine when sdr_profile.enabled=true",
    ).toContain("DOUTRINA SDR");
  }, 60_000);

  it("sdr-enabled-referral: all 3 certification gates pass", async () => {
    const scenario = loadScenario("sdr-enabled-referral.json");

    const result = await replaySdrScenario(
      scenario,
      pool,
      redis,
      gatewayMock,
      callbackMock.sendComplete,
      "a0000002-0002-4002-b002-000000000020",
    );

    expect(result.output, "output should be non-empty").toBeTruthy();

    const judgeGateway = buildJudgeGateway(scenario);
    const scorers = buildScorers(["sdr-audit-gate", "sdr-message-ready", "sdr-prospect-ready"], {
      gateway: judgeGateway,
      judgeModel: "fake-judge",
    });

    const runner = new EvalRunner(scorers);
    const runnerResults = await runner.run({
      input: result.input,
      output: result.output,
      context: { system_prompt: result.resolvedSystemPrompt },
      meta: {
        execution_id: "a0000002-0002-4002-b002-000000000020",
        organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
        agent_name: "scheduler",
        reasoning_engine: "react",
      },
    });

    for (const r of runnerResults) {
      expect(r.result, `scorer ${r.scorer} should not error`).not.toHaveProperty("error");
    }

    const auditGate = runnerResults.find((r) => r.scorer === "sdr-audit-gate");
    const messageReady = runnerResults.find((r) => r.scorer === "sdr-message-ready");
    const prospectReady = runnerResults.find((r) => r.scorer === "sdr-prospect-ready");

    expect((auditGate!.result as { score: number }).score, "sdr-audit-gate must score 1").toBe(1);

    expect(
      (messageReady!.result as { score: number }).score,
      "sdr-message-ready must score 1",
    ).toBe(1);

    expect(
      (prospectReady!.result as { score: number }).score,
      "sdr-prospect-ready must score >= 0.7",
    ).toBeGreaterThanOrEqual(0.7);

    expect(
      result.resolvedSystemPrompt,
      "resolved system prompt must contain SDR doctrine when sdr_profile.enabled=true",
    ).toContain("DOUTRINA SDR");
  }, 60_000);

  // ─── §4.4 — Zero-cost gate: no-sdr_profile behavior unchanged ─────────

  it("sdr-disabled-baseline: resolved system prompt equals EXACTLY agent_config.system_prompt (zero-cost gate §4.4)", async () => {
    const scenario = loadScenario("sdr-disabled-baseline.json");

    const result = await replaySdrScenario(
      scenario,
      pool,
      redis,
      gatewayMock,
      callbackMock.sendComplete,
      "a0000003-0003-4003-b003-000000000030",
    );

    // §4.4 invariant: composeSystemPrompt(base, undefined) === base
    // The resolved system prompt delivered to the gateway must be byte-identical
    // to the input agent_config.system_prompt.
    const expectedSystemPrompt = scenario.agent_config["system_prompt"] as string;
    expect(
      result.resolvedSystemPrompt,
      "zero-cost gate: resolved system prompt must equal EXACTLY the base system_prompt when no sdr_profile is set",
    ).toBe(expectedSystemPrompt);

    // SDR doctrine must NOT appear
    expect(
      result.resolvedSystemPrompt,
      "SDR doctrine must NOT be injected when sdr_profile is absent",
    ).not.toContain("DOUTRINA SDR");
  }, 60_000);
});
