import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; the skill wires the mutation
// via `mutationExecute`. Exercise the identical closure directly.
import { mutationExecute } from "../../../src/tools/_shared/mutation-tool.js";
import { rescheduleAppointmentMutation } from "../../../src/tools/calendar/reschedule-appointment.mutation.js";
import * as calendarClient from "../../../src/integration/calendar-client.js";
import { setRateLimiter, type RateLimiter } from "../../../src/security/rate-limiter.js";
import { makeToolContext } from "../../helpers/tool-context.js";

vi.mock("../../../src/integration/calendar-client");

const rescheduleAppointment = mutationExecute(rescheduleAppointmentMutation);

const validParams = {
  appointment_id: "a-1",
  new_date: "2026-04-12",
  new_start_time: "14:30",
};

describe("reschedule-appointment mutation execute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    setRateLimiter(null);
  });

  it("returns INVALID_PARAMS when any field is missing (typed code)", async () => {
    const r1 = await rescheduleAppointment({}, makeToolContext());
    expect(r1.error).toBe("INVALID_PARAMS");
    const r2 = await rescheduleAppointment(
      { appointment_id: "a-1", new_date: "2026-04-12" },
      makeToolContext(),
    );
    expect(r2.error).toBe("INVALID_PARAMS");
  });

  it("reschedules successfully + passes idempotency key (5th arg)", async () => {
    vi.mocked(calendarClient.rescheduleAppointment).mockResolvedValueOnce({ rescheduled: true });
    const result = await rescheduleAppointment(validParams, makeToolContext());
    expect(result.success).toBe(true);
    const callArgs = vi.mocked(calendarClient.rescheduleAppointment).mock.calls[0];
    expect(callArgs[0]).toBe("a-1");
    expect(callArgs[1]).toBe("2026-04-12");
    expect(callArgs[2]).toBe("14:30");
    expect(callArgs[3]).toBeUndefined(); // token positional
    expect(callArgs[4]).toMatch(/^[0-9a-f]{64}$/); // sha256 idempotency key
  });

  it("wraps downstream errors as E_TOOL_BACKEND_5XX (base catch)", async () => {
    vi.mocked(calendarClient.rescheduleAppointment).mockRejectedValueOnce(new Error("conflict"));
    const result = await rescheduleAppointment(validParams, makeToolContext());
    expect(result.error).toBe("E_TOOL_BACKEND_5XX");
  });

  it("returns RATE_LIMITED when limiter denies; calendar-client NOT called", async () => {
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 60_000 }),
    } as unknown as RateLimiter);
    const result = await rescheduleAppointment(validParams, makeToolContext());
    expect(result.error).toBe("RATE_LIMITED");
    expect(calendarClient.rescheduleAppointment).not.toHaveBeenCalled();
  });

  it("manual_assisted → returns proposal, calendar-client NOT called (ADR-006)", async () => {
    const result = await rescheduleAppointment(
      validParams,
      makeToolContext({ executionMode: "manual_assisted" }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      proposal: { action: "reschedule-appointment", params: validParams },
    });
    expect(calendarClient.rescheduleAppointment).not.toHaveBeenCalled();
  });
});
