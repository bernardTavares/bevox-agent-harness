import { describe, it, expect, afterEach } from "vitest";

import { SendMessageMutation } from "../../../../src/tools/messaging/send-message.mutation.js";
import type { ToolContext } from "../../../../src/tools/_shared/mutation-tool.js";
import { setRateLimiter, type RateLimiter } from "../../../../src/security/rate-limiter.js";

const ctx: ToolContext = { execution_id: "exec-sm-1", organization_id: "org-sm-1" };

describe("SendMessageMutation (C9)", () => {
  afterEach(() => {
    setRateLimiter(null);
  });

  it("autonomous_supervised → executes + returns {ok:true, result:{sent,message}}", async () => {
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "hi" }, ctx, "autonomous_supervised");
    expect(outcome.ok).toBe(true);
    if (outcome.ok && "result" in outcome) {
      expect(outcome.result).toEqual({ sent: true, message: "hi" });
    } else {
      throw new Error("expected ToolResult");
    }
  });

  it("manual_assisted → {ok:true, proposal} without touching execute()", async () => {
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "hi" }, ctx, "manual_assisted");
    expect(outcome.ok).toBe(true);
    if (outcome.ok && "proposal" in outcome) {
      expect(outcome.proposal.action).toBe("send-message");
      expect(outcome.proposal.params).toEqual({ message: "hi" });
    } else {
      throw new Error("expected ToolProposal");
    }
  });

  it("copilot → same as manual_assisted (proposal)", async () => {
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "hi" }, ctx, "copilot");
    expect(outcome.ok).toBe(true);
    expect("proposal" in outcome).toBe(true);
  });

  it("autonomous + empty message → {ok:false, error:{code:'INVALID_PARAMS'}}", async () => {
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "" }, ctx, "autonomous_supervised");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INVALID_PARAMS");
  });

  it("autonomous + rate-limited → {ok:false, error:{code:'RATE_LIMITED'}}", async () => {
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 60_000 }),
    } as unknown as RateLimiter);
    const m = new SendMessageMutation();
    const outcome = await m.executeOrPropose({ message: "hi" }, ctx, "autonomous_supervised");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("RATE_LIMITED");
  });
});
