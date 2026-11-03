import { describe, it, expect, beforeEach, afterEach } from "vitest";
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; logic lives in the skill impl.
import { execute } from "../../../src/skills-builtin/messaging/request-human/request-human.impl.js";
import { setRateLimiter, type RateLimiter } from "../../../src/security/rate-limiter.js";
import { makeToolContext } from "../../helpers/tool-context.js";

// Post-2026-06-02 (auditoria CRÍT #4 + #6): a tool NÃO chama sendComplete
// e NÃO emite "strategy: handoff" (que é fora do enum do backend). Apenas
// sinaliza ao handler que o caso é de handoff; o handler dispara o callback
// com `strategy: "request-human"` (canon enum).

describe("request-human skill execute", () => {
  beforeEach(() => {
    // sem mock de sendComplete — a tool nunca o invoca.
  });

  afterEach(() => {
    setRateLimiter(null);
  });

  it("returns INVALID_PARAMS when reason missing", async () => {
    const result = await execute({}, makeToolContext());
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("signals handoff via data, sem chamar callback", async () => {
    const ctx = makeToolContext({ executionToken: "tok-9", executionId: "exec-77" });
    const result = await execute({ reason: "complex billing", team_id: 5 }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ handoff: true, reason: "complex billing", team_id: 5 });
  });

  it("defaults team_id to null when not provided", async () => {
    const result = await execute({ reason: "x" }, makeToolContext());
    expect(result.success).toBe(true);
    expect((result.data as { team_id: number | null }).team_id).toBeNull();
  });

  it("returns RATE_LIMITED when limiter denies", async () => {
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 3_600_000 }),
    } as unknown as RateLimiter);
    const result = await execute({ reason: "x" }, makeToolContext());
    expect(result.error).toBe("RATE_LIMITED");
  });
});
