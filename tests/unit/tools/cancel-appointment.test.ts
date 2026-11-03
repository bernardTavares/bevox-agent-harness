import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; the skill wires the mutation
// via `mutationExecute`. Exercise the identical closure directly.
import { mutationExecute } from "../../../src/tools/_shared/mutation-tool.js";
import { cancelAppointmentMutation } from "../../../src/tools/calendar/cancel-appointment.mutation.js";
import * as calendarClient from "../../../src/integration/calendar-client.js";
import { setRateLimiter, type RateLimiter } from "../../../src/security/rate-limiter.js";
import { makeToolContext } from "../../helpers/tool-context.js";

vi.mock("../../../src/integration/calendar-client");

const cancelAppointment = mutationExecute(cancelAppointmentMutation);

describe("cancel-appointment mutation execute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    setRateLimiter(null);
  });

  it("returns INVALID_PARAMS when appointment_id is missing (typed code)", async () => {
    const result = await cancelAppointment({}, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("cancels appointment successfully + passes idempotency key (4th arg)", async () => {
    vi.mocked(calendarClient.cancelAppointment).mockResolvedValueOnce({ cancelled: true });
    const result = await cancelAppointment(
      { appointment_id: "a-1", reason: "customer request" },
      makeToolContext(),
    );
    expect(result.success).toBe(true);
    const callArgs = vi.mocked(calendarClient.cancelAppointment).mock.calls[0];
    expect(callArgs[0]).toBe("a-1");
    expect(callArgs[1]).toBe("customer request");
    expect(callArgs[2]).toBeUndefined(); // token positional
    expect(callArgs[3]).toMatch(/^[0-9a-f]{64}$/); // sha256 idempotency key
  });

  it("passes empty reason when omitted", async () => {
    vi.mocked(calendarClient.cancelAppointment).mockResolvedValueOnce({ cancelled: true });
    await cancelAppointment({ appointment_id: "a-1" }, makeToolContext());
    expect(vi.mocked(calendarClient.cancelAppointment).mock.calls[0][1]).toBe("");
  });

  it("wraps downstream errors as E_TOOL_BACKEND_5XX (base catch)", async () => {
    vi.mocked(calendarClient.cancelAppointment).mockRejectedValueOnce(new Error("not found"));
    const result = await cancelAppointment(
      { appointment_id: "missing" },
      makeToolContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("E_TOOL_BACKEND_5XX");
    expect(result.detail).toContain("not found");
  });

  it("returns RATE_LIMITED when limiter denies; calendar-client NOT called", async () => {
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 60_000 }),
    } as unknown as RateLimiter);
    const result = await cancelAppointment(
      { appointment_id: "a-1" },
      makeToolContext(),
    );
    expect(result.error).toBe("RATE_LIMITED");
    expect(calendarClient.cancelAppointment).not.toHaveBeenCalled();
  });

  it("manual_assisted → returns proposal, calendar-client NOT called (ADR-006)", async () => {
    const result = await cancelAppointment(
      { appointment_id: "a-1", reason: "x" },
      makeToolContext({ executionMode: "manual_assisted" }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      proposal: { action: "cancel-appointment", params: { appointment_id: "a-1", reason: "x" } },
    });
    expect(calendarClient.cancelAppointment).not.toHaveBeenCalled();
  });
});
