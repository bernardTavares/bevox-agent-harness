/**
 * C9 POC — testes do `CreateAppointmentMutation`.
 *
 * Cobre o pattern `executeOrPropose` end-to-end:
 *   - `autonomous_supervised`: chama o calendar-client + injeta
 *     Idempotency-Key.
 *   - `manual_assisted` / `copilot`: retorna `ToolProposal` SEM tocar
 *     no HTTP cliente (sem fetch).
 *
 * Wiring no execution-handler — escolher esta tool vs. o
 * `ToolDefinition` legado conforme `execution_mode` — fica na issue
 * #33. Esta suite prova que a mutation isolada respeita o contrato.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { CreateAppointmentMutation } from "../../../../src/tools/calendar/create-appointment.mutation.js";
import type { ToolContext } from "../../../../src/tools/_shared/mutation-tool.js";
import { canonicalize } from "../../../../src/tools/_shared/mutation-tool.js";
import { createHash } from "node:crypto";

const ORIGINAL_FETCH = global.fetch;

function okJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => body,
  } as unknown as Response;
}

const ctx: ToolContext = {
  execution_id: "exec-poc-1",
  organization_id: "org-poc-1",
  step_index: 2,
};

const params = {
  calendar_id: "cal-1",
  service_id: "svc-1",
  customer_name: "Maria",
  date: "2026-06-10",
  start_time: "10:00",
};

describe("CreateAppointmentMutation (C9 POC)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it("autonomous_supervised → executa de fato + injeta Idempotency-Key", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse({ id: "appt-123", status: "confirmed" }));
    global.fetch = spy as unknown as typeof fetch;

    const tool = new CreateAppointmentMutation();
    const outcome = await tool.executeOrPropose(params, ctx, "autonomous_supervised");

    expect(outcome.ok).toBe(true);
    if (outcome.ok && "result" in outcome) {
      expect(outcome.result.appointment_id).toBe("appt-123");
    } else {
      throw new Error("expected ToolResult, got proposal/failure");
    }

    // Verifica idempotency-key derivada do contexto.
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const expectedKey = createHash("sha256")
      .update(`exec-poc-1:2:create-appointment:${canonicalize(params)}`)
      .digest("hex");
    expect(headers["Idempotency-Key"]).toBe(expectedKey);
  });

  it("manual_assisted → retorna proposal SEM tocar no calendar-client", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse({}));
    global.fetch = spy as unknown as typeof fetch;

    const tool = new CreateAppointmentMutation();
    const outcome = await tool.executeOrPropose(params, ctx, "manual_assisted");

    expect(outcome.ok).toBe(true);
    if (outcome.ok && "proposal" in outcome) {
      expect(outcome.proposal.action).toBe("create-appointment");
      expect(outcome.proposal.params).toEqual(params);
    } else {
      throw new Error("expected ToolProposal");
    }

    // CRÍTICO: nenhum side-effect — fetch nunca foi chamado.
    expect(spy).not.toHaveBeenCalled();
  });

  it("copilot → idem manual_assisted (sem side-effect)", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse({}));
    global.fetch = spy as unknown as typeof fetch;

    const tool = new CreateAppointmentMutation();
    const outcome = await tool.executeOrPropose(params, ctx, "copilot");

    expect(outcome.ok).toBe(true);
    if (outcome.ok && "proposal" in outcome) {
      expect(outcome.proposal.action).toBe("create-appointment");
    } else {
      throw new Error("expected ToolProposal");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("autonomous_supervised + erro do backend → ToolFailure E_TOOL_BACKEND_5XX", async () => {
    const spy = vi.fn().mockRejectedValue(new Error("calendar 503"));
    global.fetch = spy as unknown as typeof fetch;

    const tool = new CreateAppointmentMutation();
    const outcome = await tool.executeOrPropose(params, ctx, "autonomous_supervised");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("E_TOOL_BACKEND_5XX");
      expect(outcome.error.message).toContain("calendar 503");
    }
  });

  it("step_index ausente cai para 0 (sendComplete-style call-site)", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse({ id: "appt-x" }));
    global.fetch = spy as unknown as typeof fetch;

    const ctxNoStep: ToolContext = {
      execution_id: "exec-no-step",
      organization_id: "org-x",
    };
    const tool = new CreateAppointmentMutation();
    await tool.executeOrPropose(params, ctxNoStep, "autonomous_supervised");

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const expectedKey = createHash("sha256")
      .update(`exec-no-step:0:create-appointment:${canonicalize(params)}`)
      .digest("hex");
    expect(headers["Idempotency-Key"]).toBe(expectedKey);
  });
});
