/**
 * Why this test exists
 * ====================
 *
 * `getCredentialPool()` in `src/integration/llm/credential-pool.ts` is the
 * SOLE entrypoint that builds and caches a process-global `CredentialPool`
 * singleton FROM ENV — without any `ExecutionContext`, DI container, or
 * caller-supplied wiring.
 *
 * Per the canon spec
 * `docs/superpowers/specs/2026-06-03-execution-handler-split-and-di-design.md`
 * (§10 process-globals whitelist + §3.2 emenda E4 reclassification), the
 * CLI fallback shape MUST be preserved:
 *
 *   - In PRODUCTION (BullMQ worker, runtime), the CredentialPool moves onto
 *     the `ExecutionContext` and is wired by the bootstrap stages — it is
 *     NOT a globally-fetched singleton anymore.
 *   - In CLI MODE (`src/rag/cli/ingest.ts`, `src/rag/cli/reembed.ts`), there
 *     is no ExecutionContext to depend on. The CLI ships its own
 *     mini-bootstrap; calling `getCredentialPool()` with zero arguments and
 *     getting back a usable pool is the ENTIRE fallback contract.
 *
 * The E4 entry in §3.2 explicitly reclassified credentialPool from a
 * "fully-DI'd dependency" to "DI in handler, module-level singleton in CLI".
 * This test is the regression guard for that classification.
 *
 * Contract pinned here (CLI-fallback specific):
 *
 *   1. `getCredentialPool()` is callable with NO arguments — no context,
 *      no DI container, no caller wiring. It returns a non-null
 *      `CredentialPool` instance.
 *   2. The returned instance exposes the documented public surface
 *      (`register`, `has`, `size`, `acquire`) — i.e. it is genuinely the
 *      same shape the CLIs consume, not a stripped/proxy variant.
 *   3. The fallback POPULATES the credential pool from env (the
 *      `requireCjs("../../config/env.js")` lazy-import path inside
 *      `getCredentialPool()` actually resolves and runs). This is the
 *      property a CLI binary relies on at cold boot.
 *   4. Subsequent `getCredentialPool()` calls within the same process
 *      return the SAME instance (singleton identity — §10 whitelist).
 *   5. NEGATIVE: when the singleton is already cached, the lazy
 *      `requireCjs` env path does NOT re-run. We assert this by mutating
 *      the cached instance and observing the mutation survives the next
 *      call — proving no rebuild happened.
 *
 * Why subprocess (not in-process)
 * --------------------------------
 *
 * The fallback path uses `createRequire(import.meta.url) +
 * requireCjs("../../config/env.js")` to dodge an ESM init cycle. That
 * `requireCjs` resolves at RUNTIME against the surrounding module graph —
 * which works under the real CLI runner (`tsx src/rag/cli/ingest.ts`) but
 * does NOT resolve under vitest's ESM transform (vitest cannot find a
 * `.js` sibling for the TypeScript source). The unit test in
 * `tests/unit/integration/llm/llm-gateway.test.ts` documents exactly this
 * limitation (lines 5-6) and stubs the singleton via `vi.mock` to avoid
 * it.
 *
 * For an INTEGRATION test we don't want to stub — we want to pin the
 * ACTUAL CLI cold-boot path. So we spawn a subprocess via `tsx` (the same
 * runner `package.json` uses for `rag:ingest` / `rag:reembed`), drive the
 * fallback contract through assertions inside the child, and surface the
 * results via stdout. This is the cleanest way to exercise the real
 * `requireCjs` resolution that vitest can't simulate.
 *
 * If a future refactor:
 *
 *   - removes `getCredentialPool()`'s zero-arg overload (forces a ctx),
 *   - introduces per-call instantiation (breaks singleton identity),
 *   - moves the singleton onto an ExecutionContext-only path,
 *   - or breaks the `requireCjs` lazy-import (e.g. by switching to a
 *     top-level `await import` that re-introduces the env-init cycle),
 *
 * this test fails loudly and the change must either be reverted or
 * accompanied by an ADR update removing the CLI-fallback row from the
 * §10 whitelist + a migration plan for `src/rag/cli/*`.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const RUN = process.env.RUN_INTEGRATION === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Drive a tsx-spawned probe that exercises the CLI fallback path and emits
 * a single JSON line on stdout describing what happened. Mirrors the real
 * CLI cold-boot environment (`pnpm rag:ingest` → `tsx src/rag/cli/ingest.ts`).
 *
 * The probe script is inlined here (not a fixture file) so the test is
 * self-contained and survives any test-fixture reorganisation.
 */
function runCliProbe(
  probeScript: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveOnce, reject) => {
    const child = spawn(
      "node",
      ["--import=tsx", "--input-type=module", "-e", probeScript],
      {
        cwd: REPO_ROOT,
        env: {
          // Inherit everything (PATH, NODE_PATH, fnm shims) and overlay the
          // minimum env the Zod-validated `getEnv()` needs to succeed. These
          // values match `tests/setup.ts` so the cold-boot path resolves the
          // same way an integration test under vitest would.
          ...process.env,
          NODE_ENV: "test",
          HARNESS_LOG_LEVEL: "error",
          DATABASE_URL:
            process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test",
          REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
          BEVOX_CALLBACK_BASE_URL:
            process.env.BEVOX_CALLBACK_BASE_URL ?? "http://localhost:3000",
          CALENDAR_SERVICE_URL:
            process.env.CALENDAR_SERVICE_URL ?? "http://localhost:3009/api",
          // OPENAI_API_KEY é uma sentinela determinística para este
          // regression guard — NÃO pode herdar do host env, senão o CI
          // (que seta OPENAI_API_KEY=sk-test-stub) sobrescreve "test-key" e
          // a asserção `expect(payload.acquiredKey).toBe("test-key")` da
          // probe #1 falha. Local passa só porque a env do host geralmente
          // está vazia.
          OPENAI_API_KEY: "test-key",
          DEFAULT_LLM_PROVIDER: process.env.DEFAULT_LLM_PROVIDER ?? "openai",
          DEFAULT_LLM_MODEL: process.env.DEFAULT_LLM_MODEL ?? "gpt-4o-mini",
          MCP_SERVER_TOKEN:
            process.env.MCP_SERVER_TOKEN ??
            "test-mcp-server-token-32chars-minimum-aaa",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (status) => {
      clearTimeout(timer);
      resolveOnce({ stdout, stderr, status });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Parse the trailing JSON line emitted by a probe. Probes are written so
 * the LAST non-empty stdout line is the JSON payload; tsx and any
 * pre-amble (warnings, etc.) are tolerated above it.
 */
function parseProbePayload<T>(stdout: string): T {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`probe produced no stdout`);
  }
  const last = lines[lines.length - 1];
  try {
    return JSON.parse(last) as T;
  } catch (err) {
    throw new Error(
      `probe last line was not JSON: ${last}\n--- full stdout ---\n${stdout}`,
    );
  }
}

describe.skipIf(!RUN)(
  "CredentialPool — CLI fallback (no ExecutionContext) [spec §10 + §3.2 E4]",
  () => {
    it("getCredentialPool() resolves under tsx cold-boot with NO arguments and populates from env", async () => {
      // Probe: mimic the cold-boot path inside `src/rag/cli/ingest.ts`.
      // No ExecutionContext, no DI container — just import + call.
      const probe = `
        import { getCredentialPool, CredentialPool } from "./src/integration/llm/credential-pool.ts";
        const pool = getCredentialPool();
        const out = {
          defined: pool !== null && pool !== undefined,
          isCredentialPool: pool instanceof CredentialPool,
          hasRegister: typeof pool.register === "function",
          hasHas: typeof pool.has === "function",
          hasSize: typeof pool.size === "function",
          hasAcquire: typeof pool.acquire === "function",
          hasReportFailure: typeof pool.reportFailure === "function",
          hasReportSuccess: typeof pool.reportSuccess === "function",
          openaiHas: pool.has("openai"),
          openaiSize: pool.size("openai"),
          acquiredKey: pool.acquire("openai"),
        };
        console.log(JSON.stringify(out));
      `;

      const result = await runCliProbe(probe);

      // Sentinel: probe ran cleanly. If `requireCjs("../../config/env.js")`
      // breaks (e.g. cycle reintroduced, path moved), exit != 0 and we
      // surface stderr for diagnosis.
      expect(result.status, `stderr:\n${result.stderr}`).toBe(0);

      const payload = parseProbePayload<{
        defined: boolean;
        isCredentialPool: boolean;
        hasRegister: boolean;
        hasHas: boolean;
        hasSize: boolean;
        hasAcquire: boolean;
        hasReportFailure: boolean;
        hasReportSuccess: boolean;
        openaiHas: boolean;
        openaiSize: number;
        acquiredKey: string;
      }>(result.stdout);

      // Sentinel: the fallback actually returned something usable.
      expect(payload.defined).toBe(true);
      expect(payload.isCredentialPool).toBe(true);

      // Public API surface — the methods the CLIs (`ingest.ts`,
      // `reembed.ts`) actually call. If any of these vanish, CLI binaries
      // break.
      expect(payload.hasRegister).toBe(true);
      expect(payload.hasHas).toBe(true);
      expect(payload.hasSize).toBe(true);
      expect(payload.hasAcquire).toBe(true);
      expect(payload.hasReportFailure).toBe(true);
      expect(payload.hasReportSuccess).toBe(true);

      // The fallback actually populated openai from `OPENAI_API_KEY`
      // (tests/setup.ts wires "test-key"). Sentinel before pin.
      expect(payload.openaiHas).toBe(true);
      expect(payload.openaiSize).toBeGreaterThan(0);
      expect(payload.acquiredKey).toBe("test-key");
    }, 60_000);

    it("returns the SAME instance on subsequent calls (singleton identity)", async () => {
      // Drive THREE consecutive calls inside the same process and report
      // identity comparisons. Singleton property is preserved iff all
      // three are reference-equal.
      const probe = `
        import { getCredentialPool } from "./src/integration/llm/credential-pool.ts";
        const p1 = getCredentialPool();
        const p2 = getCredentialPool();
        const p3 = getCredentialPool();
        const out = {
          p1Defined: p1 !== null && p1 !== undefined,
          p2Defined: p2 !== null && p2 !== undefined,
          p3Defined: p3 !== null && p3 !== undefined,
          p1EqP2: p1 === p2,
          p2EqP3: p2 === p3,
          p1EqP3: p1 === p3,
        };
        console.log(JSON.stringify(out));
      `;

      const result = await runCliProbe(probe);
      expect(result.status, `stderr:\n${result.stderr}`).toBe(0);

      const payload = parseProbePayload<{
        p1Defined: boolean;
        p2Defined: boolean;
        p3Defined: boolean;
        p1EqP2: boolean;
        p2EqP3: boolean;
        p1EqP3: boolean;
      }>(result.stdout);

      // Sentinel: each call returned something.
      expect(payload.p1Defined).toBe(true);
      expect(payload.p2Defined).toBe(true);
      expect(payload.p3Defined).toBe(true);

      // Identity (===) — §10 whitelist preserves THIS instance across the
      // process so CLI register-side-effects on `p1` are visible to
      // `p2`/`p3`.
      expect(payload.p1EqP2).toBe(true);
      expect(payload.p2EqP3).toBe(true);
      expect(payload.p1EqP3).toBe(true);
    }, 60_000);

    it("does NOT rebuild from env on cached calls (negative: env path does not re-trigger)", async () => {
      // Mutate the singleton between calls. If the second call rebuilt
      // from env, the mutation would be LOST (env has no ANTHROPIC keys
      // wired). We assert the OPPOSITE: same instance, sentinel survives.
      const probe = `
        import { getCredentialPool } from "./src/integration/llm/credential-pool.ts";
        const p1 = getCredentialPool();
        p1.register("anthropic", ["cli-fallback-sentinel-key"]);
        const beforeHasAnthropic = p1.has("anthropic");
        const beforeSizeAnthropic = p1.size("anthropic");

        const p2 = getCredentialPool();
        const afterHasAnthropic = p2.has("anthropic");
        const acquiredAnthropic = p2.has("anthropic") ? p2.acquire("anthropic") : null;

        const out = {
          beforeHasAnthropic,
          beforeSizeAnthropic,
          afterHasAnthropic,
          identity: p1 === p2,
          acquiredAnthropic,
        };
        console.log(JSON.stringify(out));
      `;

      const result = await runCliProbe(probe);
      expect(result.status, `stderr:\n${result.stderr}`).toBe(0);

      const payload = parseProbePayload<{
        beforeHasAnthropic: boolean;
        beforeSizeAnthropic: number;
        afterHasAnthropic: boolean;
        identity: boolean;
        acquiredAnthropic: string | null;
      }>(result.stdout);

      // Sentinel: the mutation took effect on the first instance — proves
      // we're not chasing a no-op.
      expect(payload.beforeHasAnthropic).toBe(true);
      expect(payload.beforeSizeAnthropic).toBe(1);

      // Negative case — if the env path re-triggered, p2 would be fresh
      // and the sentinel would be gone.
      expect(payload.identity).toBe(true);
      expect(payload.afterHasAnthropic).toBe(true);
      expect(payload.acquiredAnthropic).toBe("cli-fallback-sentinel-key");
    }, 60_000);

    it("instance-swap variant: resetCredentialPoolForTests() drops the cache and the next call builds a NEW instance from env", async () => {
      // The test-only reset helper simulates a CLI process restart inside
      // a single process. After reset, the next getCredentialPool() must
      // hit the env path fresh — identity differs, mutations from the
      // pre-reset instance are gone, env-derived state is rebuilt.
      const probe = `
        import {
          getCredentialPool,
          resetCredentialPoolForTests,
          CredentialPool,
        } from "./src/integration/llm/credential-pool.ts";

        const p1 = getCredentialPool();
        p1.register("anthropic", ["pre-reset-marker"]);
        const preResetHasAnthropic = p1.has("anthropic");

        resetCredentialPoolForTests();

        const p2 = getCredentialPool();
        const out = {
          preResetHasAnthropic,
          p2Defined: p2 !== null && p2 !== undefined,
          p2IsCredentialPool: p2 instanceof CredentialPool,
          identityDiffers: p1 !== p2,
          postResetHasAnthropic: p2.has("anthropic"),
          postResetHasOpenai: p2.has("openai"),
        };
        console.log(JSON.stringify(out));
      `;

      const result = await runCliProbe(probe);
      expect(result.status, `stderr:\n${result.stderr}`).toBe(0);

      const payload = parseProbePayload<{
        preResetHasAnthropic: boolean;
        p2Defined: boolean;
        p2IsCredentialPool: boolean;
        identityDiffers: boolean;
        postResetHasAnthropic: boolean;
        postResetHasOpenai: boolean;
      }>(result.stdout);

      // Sentinel: the pre-reset mutation actually landed.
      expect(payload.preResetHasAnthropic).toBe(true);

      // Sentinel: second call still produces a working pool.
      expect(payload.p2Defined).toBe(true);
      expect(payload.p2IsCredentialPool).toBe(true);

      // Singleton is ONE process-global slot — after reset, a genuinely
      // new instance is built.
      expect(payload.identityDiffers).toBe(true);

      // Pre-reset mutation is GONE — fresh build from env only.
      // tests/setup.ts wires no ANTHROPIC_API_KEY, so anthropic is empty.
      expect(payload.postResetHasAnthropic).toBe(false);

      // But openai is re-populated from env, same as cold-boot.
      expect(payload.postResetHasOpenai).toBe(true);
    }, 60_000);
  },
);
