import { describe, it, expect, vi, beforeEach } from "vitest";
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; the skill wires the mutation
// via `mutationExecute`. Exercise the identical closure directly.
import { mutationExecute } from "../../../src/tools/_shared/mutation-tool.js";
import { waitlistAddMutation } from "../../../src/tools/calendar/waitlist-add.mutation.js";
import * as calendarClient from "../../../src/integration/calendar-client.js";
import { makeToolContext } from "../../helpers/tool-context.js";

vi.mock("../../../src/integration/calendar-client");

const waitlistAdd = mutationExecute(waitlistAddMutation);

describe("waitlist-add mutation execute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns INVALID_PARAMS when calendar_id is missing (typed code)", async () => {
    const result = await waitlistAdd({ customer_name: "Alice" }, makeToolContext());
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns INVALID_PARAMS when customer_name is missing (typed code)", async () => {
    const result = await waitlistAdd({ calendar_id: "cal-1" }, makeToolContext());
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("adds to waitlist successfully + passes idempotency key (4th arg)", async () => {
    vi.mocked(calendarClient.addToWaitlist).mockResolvedValueOnce({ waitlisted: true });
    const result = await waitlistAdd(
      {
        calendar_id: "cal-1",
        customer_name: "Alice",
        service_id: "svc-1",
        preferred_date_from: "2026-04-10",
        preferred_date_to: "2026-04-15",
      },
      makeToolContext(),
    );
    expect(result.success).toBe(true);
    const callArgs = vi.mocked(calendarClient.addToWaitlist).mock.calls[0];
    expect(callArgs[0]).toBe("cal-1");
    expect(callArgs[1]).toMatchObject({
      service_id: "svc-1",
      customer_name: "Alice",
      preferred_date_from: "2026-04-10",
      preferred_date_to: "2026-04-15",
    });
    expect(callArgs[2]).toBeUndefined(); // token positional
    expect(callArgs[3]).toMatch(/^[0-9a-f]{64}$/); // sha256 idempotency key
  });

  it("wraps downstream errors as E_TOOL_BACKEND_5XX (base catch)", async () => {
    vi.mocked(calendarClient.addToWaitlist).mockRejectedValueOnce(new Error("500"));
    const result = await waitlistAdd(
      { calendar_id: "cal-1", customer_name: "Alice" },
      makeToolContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("E_TOOL_BACKEND_5XX");
  });

  it("manual_assisted → returns proposal, calendar-client NOT called (ADR-006)", async () => {
    const result = await waitlistAdd(
      { calendar_id: "cal-1", customer_name: "Alice" },
      makeToolContext({ executionMode: "manual_assisted" }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      proposal: {
        action: "waitlist-add",
        params: { calendar_id: "cal-1", customer_name: "Alice" },
      },
    });
    expect(calendarClient.addToWaitlist).not.toHaveBeenCalled();
  });
});
