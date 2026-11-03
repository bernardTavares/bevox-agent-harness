/**
 * Why this test exists
 * ====================
 *
 * `_failureCount` inside `src/security/audit.ts` is a module-level mutable
 * `number`. Every time `emitPermissionAudit()` fires the underlying
 * `pool.query()` and the promise rejects, the `.catch()` handler increments
 * this counter. The value is exposed via `getPermissionAuditFailureCount()`
 * for metrics scraping; the only writer is the catch handler itself
 * (private to the module).
 *
 * Per the upcoming "process-globals policy" ADR canon (Fase 6 of
 * `docs/superpowers/specs/2026-06-03-execution-handler-split-and-di-design.md`,
 * specifically the whitelist row at §10 "PermissionAuditLogger._failureCount"
 * and the adversarial entry E5), this counter is one of the ~9 process-globals
 * that REMAINS process-global after the DI refactor. Rationale: it is a
 * "synchronous cross-execution counter exposed to metrics" — exactly the
 * kind of OS/metrics-bound state the whitelist preserves.
 *
 * The contract this test pins:
 *
 *   1. The counter increments by ONE per emit-failure (no double-counting,
 *      no missed increments, no swallowed errors that fail to bump).
 *   2. The counter persists ACROSS what would otherwise be two separate
 *      "executions" — i.e. it is genuinely process-global, not reset between
 *      callers. This is the property the ADR whitelist explicitly preserves.
 *   3. Replacing the `PermissionAuditLogger` instance via
 *      `setPermissionAuditLogger()` does NOT reset the counter. The counter
 *      is on the MODULE, not on the logger instance — proving instance-A
 *      failures don't bleed into / get lost when instance-B takes over.
 *
 * If a future refactor moves `_failureCount` onto a `PermissionAuditLogger`
 * instance, or wraps it in a per-execution context, this test fails loudly
 * and the change must be either reverted or accompanied by an ADR update
 * removing the row from the process-globals whitelist.
 *
 * Mechanism to trigger failures
 * -----------------------------
 *
 * The `emitPermissionAudit()` path that mutates `_failureCount` is the
 * `.catch()` handler attached to `pool.query()`. We trigger it by injecting
 * a `PermissionAuditLogger` whose underlying pool's `query()` returns a
 * rejected promise. This is the same pattern used in the existing PERM-02
 * regression in `audit.test.ts` (line 163-184), reused here without the
 * `as any` for the counter field — we only ever touch the public reader.
 *
 * Sentinel guard
 * --------------
 *
 * Each assertion first checks `delta > 0` (sentinel — "did anything happen
 * at all?") before pinning the exact value. If the catch handler stops
 * firing entirely (e.g. someone wraps `inst.log()` in a try/catch that
 * swallows), the sentinel fails before the exact-value check, giving a
 * clearer error than a single `toBe(N)` would.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PermissionAuditLogger,
  setPermissionAuditLogger,
  emitPermissionAudit,
  getPermissionAuditFailureCount,
  resetPermissionAuditFailureCount,
  type PermissionAuditEntry,
} from "../../../src/security/audit.js";

const ORG_UUID = "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b";

function makeFailingLogger(error: Error = new Error("synthetic insert failure")): PermissionAuditLogger {
  const query = vi.fn().mockRejectedValue(error);
  return new PermissionAuditLogger({ query } as any);
}

function entry(toolName = "echo"): PermissionAuditEntry {
  return {
    executionId: `mcp-${ORG_UUID}`,
    organizationId: ORG_UUID,
    agentName: "mcp-external",
    toolName,
    decision: "allow",
    layer: "allow",
  };
}

/**
 * `emitPermissionAudit` is fire-and-forget — the catch handler that bumps
 * `_failureCount` runs after `pool.query()`'s rejected promise resolves.
 * Two microtask flushes is enough for the rejection + the catch handler.
 */
async function flushFireAndForget(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("PermissionAuditLogger _failureCount — process-global counter (ADR whitelist)", () => {
  beforeEach(() => {
    // Reset both the module-level singleton and the counter so each test
    // starts from a known zero baseline. resetPermissionAuditFailureCount()
    // is the public reset helper the module exposes for exactly this.
    setPermissionAuditLogger(null);
    resetPermissionAuditFailureCount();
  });

  it("increments by exactly 1 per failed emit", async () => {
    setPermissionAuditLogger(makeFailingLogger());

    const initial = getPermissionAuditFailureCount();
    expect(initial).toBe(0); // baseline post-reset

    emitPermissionAudit(entry("first"));
    emitPermissionAudit(entry("second"));
    emitPermissionAudit(entry("third"));

    await flushFireAndForget();

    const after = getPermissionAuditFailureCount();
    const delta = after - initial;

    // Sentinel first: prove the catch handler ran at all.
    expect(delta).toBeGreaterThan(0);
    // Then pin exact value: 3 emits → 3 increments, no more, no less.
    expect(delta).toBe(3);
  });

  it("counter survives across simulated separate executions (process-global)", async () => {
    setPermissionAuditLogger(makeFailingLogger());

    // "Execution A"
    const c0 = getPermissionAuditFailureCount();
    emitPermissionAudit(entry("exec-a-tool"));
    await flushFireAndForget();
    const c1 = getPermissionAuditFailureCount();

    // Sentinel: failure was actually counted.
    expect(c1).toBeGreaterThan(c0);
    expect(c1 - c0).toBe(1);

    // "Execution B" — counter MUST persist; no per-execution reset.
    emitPermissionAudit(entry("exec-b-tool"));
    await flushFireAndForget();
    const c2 = getPermissionAuditFailureCount();

    expect(c2).toBeGreaterThan(c1);
    expect(c2 - c0).toBe(2);
  });

  it("counter lives on the module, not on the PermissionAuditLogger instance (instance-A failures don't bleed/reset when instance-B takes over)", async () => {
    // Instance A — fails once.
    const instanceA = makeFailingLogger(new Error("instance-A failure"));
    setPermissionAuditLogger(instanceA);
    emitPermissionAudit(entry("a-tool"));
    await flushFireAndForget();
    const afterA = getPermissionAuditFailureCount();
    expect(afterA).toBeGreaterThan(0); // sentinel
    expect(afterA).toBe(1);

    // Swap to instance B — different logger, same module-level counter.
    const instanceB = makeFailingLogger(new Error("instance-B failure"));
    setPermissionAuditLogger(instanceB);
    emitPermissionAudit(entry("b-tool"));
    await flushFireAndForget();
    const afterB = getPermissionAuditFailureCount();

    // If the counter were on the instance, swapping would reset to 0 and
    // then go to 1 (afterB === 1). It is on the MODULE, so the counter
    // accumulates across instances.
    expect(afterB).toBeGreaterThan(afterA);
    expect(afterB).toBe(2);
  });

  it("does NOT increment when there is no logger wired (no-op path)", async () => {
    setPermissionAuditLogger(null);

    const initial = getPermissionAuditFailureCount();
    emitPermissionAudit(entry("ignored"));
    await flushFireAndForget();

    // No logger → emit returns early → no failure → no increment.
    expect(getPermissionAuditFailureCount()).toBe(initial);
  });

  it("does NOT increment on successful emit", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    setPermissionAuditLogger(new PermissionAuditLogger({ query } as any));

    const initial = getPermissionAuditFailureCount();
    emitPermissionAudit(entry("ok"));
    await flushFireAndForget();

    // Success path never reaches the catch handler.
    expect(getPermissionAuditFailureCount()).toBe(initial);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("resetPermissionAuditFailureCount() zeroes the counter (test-affordance contract)", async () => {
    setPermissionAuditLogger(makeFailingLogger());

    emitPermissionAudit(entry("pre-reset-1"));
    emitPermissionAudit(entry("pre-reset-2"));
    await flushFireAndForget();
    expect(getPermissionAuditFailureCount()).toBeGreaterThan(0); // sentinel
    expect(getPermissionAuditFailureCount()).toBe(2);

    resetPermissionAuditFailureCount();
    expect(getPermissionAuditFailureCount()).toBe(0);

    // After reset, counter resumes from zero on next failure.
    emitPermissionAudit(entry("post-reset"));
    await flushFireAndForget();
    expect(getPermissionAuditFailureCount()).toBe(1);
  });
});
