import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; the skill wires the mutation
// via `mutationExecute`. Exercise the identical closure directly. Metadata
// (name/category) is manifest-owned and covered by unified-registry tests.
import { mutationExecute } from "../../../src/tools/_shared/mutation-tool.js";
import { createAppointmentMutation } from "../../../src/tools/calendar/create-appointment.mutation.js";
import * as calendarClient from "../../../src/integration/calendar-client.js";
import { setRateLimiter, type RateLimiter } from "../../../src/security/rate-limiter.js";
import { makeToolContext } from "../../helpers/tool-context.js";

vi.mock("../../../src/integration/calendar-client");

const createAppointment = mutationExecute(createAppointmentMutation);

const validParams = {
  calendar_id: "cal-1",
  service_id: "svc-1",
  customer_name: "Alice",
  date: "2026-04-10",
  start_time: "09:00",
};

describe("create-appointment mutation execute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    setRateLimiter(null);
  });

  it("returns INVALID_PARAMS when required field is missing (typed code now preserved)", async () => {
    // Post §4.2.b: executeOrPropose honra MutationPreconditionError.code,
    // então INVALID_PARAMS chega ao result.error em vez de colapsar para 5xx.
    const result = await createAppointment({ calendar_id: "cal-1" }, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(result.detail).toContain("required");
  });

  it("creates appointment successfully (returns CreateAppointmentResult shape)", async () => {
    // EM-03: a MutationTool retorna `{appointment_id, raw}` em vez do
    // raw da calendar-API. Shape canônico que sobrevive ao bridge.
    const fake = { id: "appt-1", status: "scheduled" };
    vi.mocked(calendarClient.createAppointment).mockResolvedValueOnce(fake);
    const result = await createAppointment(validParams, makeToolContext());
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ appointment_id: "appt-1", raw: fake });
    const callArgs = vi.mocked(calendarClient.createAppointment).mock.calls[0];
    expect(callArgs[0]).toBe("cal-1");
    expect(callArgs[1]).toMatchObject({
      service_id: "svc-1",
      customer_name: "Alice",
      date: "2026-04-10",
      start_time: "09:00",
    });
  });

  it("manual_assisted execution_mode → returns proposal (EM-03)", async () => {
    // SKILLS-05 Phase 3: a skill roteia via `mutationExecute`, então
    // `executionMode: manual_assisted` no AgentExecutionContext faz a
    // tool emitir `data.proposal` sem chamar o calendar-client.
    const ctx = makeToolContext({ executionMode: "manual_assisted" });
    const result = await createAppointment(validParams, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      proposal: {
        action: "create-appointment",
        params: validParams,
      },
    });
    expect(calendarClient.createAppointment).not.toHaveBeenCalled();
  });

  it("wraps downstream errors as E_TOOL_BACKEND_5XX (post-EM-03 bridge)", async () => {
    // SKILLS-05 Phase 3: a skill roteia via `mutationExecute` →
    // `MutationTool.executeOrPropose`. O catch genérico do base class
    // unifica erros de downstream em E_TOOL_BACKEND_5XX. O detail
    // preserva a mensagem original para diagnóstico.
    vi.mocked(calendarClient.createAppointment).mockRejectedValueOnce(new Error("502"));
    const result = await createAppointment(validParams, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("E_TOOL_BACKEND_5XX");
    expect(result.detail).toContain("502");
  });

  it("returns RATE_LIMITED when limiter denies (typed code now preserved)", async () => {
    // Post §4.2.b: o RATE_LIMITED do MutationPreconditionError sobrevive ao
    // catch de executeOrPropose. O calendar-client NÃO é chamado.
    setRateLimiter({
      check: async () => ({ allowed: false, remaining: 0, resetIn: 60_000 }),
    } as unknown as RateLimiter);
    const result = await createAppointment(validParams, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("RATE_LIMITED");
    expect(result.detail).toContain("Rate limit exceeded");
    expect(calendarClient.createAppointment).not.toHaveBeenCalled();
  });

  it("passes member_id and customer_phone through", async () => {
    vi.mocked(calendarClient.createAppointment).mockResolvedValueOnce({ id: "x" });
    await createAppointment(
      { ...validParams, member_id: "mem-1", customer_phone: "+5511999" },
      makeToolContext(),
    );
    const body = vi.mocked(calendarClient.createAppointment).mock.calls[0][1] as Record<
      string,
      unknown
    >;

    expect(body.member_id).toBe("mem-1");
    expect(body.customer_phone).toBe("+5511999");
  });
});
