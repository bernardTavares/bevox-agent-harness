import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";

// Mock the calendar client BEFORE importing the mutations under test.
vi.mock("../../../src/integration/calendar-client.js", () => ({
  createAppointment: vi.fn(async () => ({ id: "apt-1" })),
  cancelAppointment: vi.fn(async () => ({ id: "apt-1", status: "cancelled" })),
  rescheduleAppointment: vi.fn(async () => ({ id: "apt-1", status: "scheduled" })),
  addToWaitlist: vi.fn(async () => ({ id: "wl-1" })),
}));
// Rate limiter never denies in this suite.
vi.mock("../../../src/tools/_shared/rate-limit.js", () => ({
  checkRateLimit: vi.fn(async () => undefined),
}));

import * as calendarClient from "../../../src/integration/calendar-client.js";
import { MutationTool, mutationExecute } from "../../../src/tools/_shared/mutation-tool.js";
import { createAppointmentMutation } from "../../../src/tools/calendar/create-appointment.mutation.js";
import { cancelAppointmentMutation } from "../../../src/tools/calendar/cancel-appointment.mutation.js";
import { rescheduleAppointmentMutation } from "../../../src/tools/calendar/reschedule-appointment.mutation.js";
import { waitlistAddMutation } from "../../../src/tools/calendar/waitlist-add.mutation.js";
import { sendMessageMutation } from "../../../src/tools/messaging/send-message.mutation.js";

function ctx(mode: AgentExecutionContext["executionMode"]): AgentExecutionContext {
  return {
    executionId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    organizationId: "018f0000-0000-7000-8000-000000000000",
    executionMode: mode,
  } as unknown as AgentExecutionContext;
}

const cases = [
  {
    name: "create-appointment",
    mutation: createAppointmentMutation,
    params: {
      calendar_id: "cal-1",
      service_id: "svc-1",
      customer_name: "Ada",
      date: "2026-06-10",
      start_time: "09:00",
    },
    backendFn: () => calendarClient.createAppointment as ReturnType<typeof vi.fn>,
  },
  {
    name: "cancel-appointment",
    mutation: cancelAppointmentMutation,
    params: { appointment_id: "apt-1", reason: "client request" },
    backendFn: () => calendarClient.cancelAppointment as ReturnType<typeof vi.fn>,
  },
  {
    name: "reschedule-appointment",
    mutation: rescheduleAppointmentMutation,
    params: { appointment_id: "apt-1", new_date: "2026-06-11", new_start_time: "10:00" },
    backendFn: () => calendarClient.rescheduleAppointment as ReturnType<typeof vi.fn>,
  },
  {
    name: "waitlist-add",
    mutation: waitlistAddMutation,
    params: { calendar_id: "cal-1", customer_name: "Ada" },
    backendFn: () => calendarClient.addToWaitlist as ReturnType<typeof vi.fn>,
  },
] as const;

describe("mutation tools — ADR-006 executeOrPropose invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const c of cases) {
    describe(c.name, () => {
      it("autonomous_supervised → real effect (backend called)", async () => {
        const exec = mutationExecute(c.mutation);
        const res = await exec(c.params, ctx("autonomous_supervised"));
        expect(res.success).toBe(true);
        expect((res.data as { proposal?: unknown }).proposal).toBeUndefined();
        expect(c.backendFn()).toHaveBeenCalledTimes(1);
      });

      it("manual_assisted → proposal, NO backend call", async () => {
        const exec = mutationExecute(c.mutation);
        const res = await exec(c.params, ctx("manual_assisted"));
        expect(res.success).toBe(true);
        const proposal = (res.data as { proposal?: { action: string; params: unknown } }).proposal;
        expect(proposal).toBeDefined();
        expect(proposal!.action).toBe(c.mutation.action);
        expect(c.backendFn()).not.toHaveBeenCalled();
      });

      it("copilot → proposal, NO backend call", async () => {
        const exec = mutationExecute(c.mutation);
        const res = await exec(c.params, ctx("copilot"));
        expect(res.success).toBe(true);
        expect((res.data as { proposal?: unknown }).proposal).toBeDefined();
        expect(c.backendFn()).not.toHaveBeenCalled();
      });
    });
  }

  describe("send-message", () => {
    it("autonomous_supervised → real effect (sent)", async () => {
      const exec = mutationExecute(sendMessageMutation);
      const res = await exec({ message: "hi" }, ctx("autonomous_supervised"));
      expect(res.success).toBe(true);
      expect((res.data as { proposal?: unknown }).proposal).toBeUndefined();
    });

    it("manual_assisted → proposal, no send", async () => {
      const exec = mutationExecute(sendMessageMutation);
      const res = await exec({ message: "hi" }, ctx("manual_assisted"));
      const proposal = (res.data as { proposal?: { action: string } }).proposal;
      expect(proposal).toBeDefined();
      expect(proposal!.action).toBe(sendMessageMutation.action);
    });
  });

  it("idempotency-key follows the canonical ADR-015 formula (deterministic sha256)", () => {
    // Landed hardened formula (mutation-tool.ts:169) is content-derived sha256:
    //   sha256(`${execution_id}:${step}:${operationName}:${canonicalize(params)}`)
    // → 64-char hex, trajectory-independent. Plan's NOTE (line 260) directs us to
    // assert the landed formula + determinism instead of the legacy literal string.
    const context = { execution_id: "exec-9", organization_id: "org", step_index: 3 };
    const params = { appointment_id: "apt-1", reason: "client request" };
    const key1 = MutationTool.deriveIdempotencyKey(context, "create-appointment", params);
    const key2 = MutationTool.deriveIdempotencyKey(context, "create-appointment", params);
    // Deterministic: same execution_id + step + name + params → same key.
    expect(key1).toBe(key2);
    // Opaque 64-char hex (passes the backend's idempotency-key regex).
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
    // NOT a random UUID, and NOT the bare execution_id.
    expect(key1).not.toBe("exec-9");
    // Distinct params → distinct key (content is the discriminator).
    const keyOther = MutationTool.deriveIdempotencyKey(context, "create-appointment", {
      appointment_id: "apt-2",
      reason: "client request",
    });
    expect(keyOther).not.toBe(key1);
  });
});
