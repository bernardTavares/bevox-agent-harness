import { describe, it, expect, beforeEach, afterEach } from "vitest";
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; the skill wires the mutation
// via `mutationExecute`. Exercise the identical closure directly. Metadata
// (name/category/agentType) is manifest-owned and covered by unified-registry
// tests.
import { mutationExecute } from "../../../src/tools/_shared/mutation-tool.js";
import { sendMessageMutation } from "../../../src/tools/messaging/send-message.mutation.js";
import { setRateLimiter, type RateLimiter } from "../../../src/security/rate-limiter.js";
import { makeToolContext } from "../../helpers/tool-context.js";

// Post-2026-06-02 (auditoria CRÍT #6): a tool NÃO chama sendComplete mais.
// Apenas sinaliza ao reasoning loop. O handler é o único dispatcher do
// `/complete`. Vide src/tools/messaging/send-message.mutation.ts.

const sendMessage = mutationExecute(sendMessageMutation);

describe("send-message mutation execute", () => {
  beforeEach(() => {
    // sem mock de sendComplete — a tool nunca o invoca.
  });

  afterEach(() => {
    setRateLimiter(null);
  });

  it("returns INVALID_PARAMS when message missing", async () => {
    const result = await sendMessage({}, makeToolContext());
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("signals success and surfaces the message via data.message", async () => {
    const ctx = makeToolContext({ executionToken: "tok-1", executionId: "exec-9" });
    const result = await sendMessage({ message: "hello" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ sent: true, message: "hello" });
  });

  it("returns RATE_LIMITED when limiter denies (sem touchar callback)", async () => {
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 60_000 }),
    } as unknown as RateLimiter);
    const result = await sendMessage({ message: "hello" }, makeToolContext());
    expect(result.error).toBe("RATE_LIMITED");
  });
});
