/**
 * EM-03 POC (issue #44) — `buildCompletePayload` emite `proposals[]`.
 *
 * O field `proposals` é opcional no schema do bevox-backend
 * (`CompleteCallbackSchema`). Quando vazio, é OMITIDO no payload (zero
 * diff vs. autonomous_supervised path do V0). Quando populado, vira
 * `[ { action, params }, ... ]` e o backend roteia para o seam
 * `executeProposals()` que persiste cada proposal como AISuggestion
 * pendente de aprovação (ADR-007).
 *
 * Tests garantem:
 *   - Payload sem `proposals` é byte-idêntico ao V0 (não-regressão).
 *   - Payload com proposals serializa corretamente.
 *   - `proposals = []` é tratado como vazio (omitido).
 */

import { describe, it, expect } from "vitest";

import { buildCompletePayload } from "../../../src/integration/bevox-callback.js";

describe("buildCompletePayload — proposals (EM-03)", () => {
  it("omite proposals quando array está vazio (não-regressão para autonomous path)", () => {
    const payload = buildCompletePayload({
      responseText: "Hello",
      sentiment: "positive",
      strategy: "react",
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      proposals: [],
    });

    expect(payload).toEqual({
      response_text: "Hello",
      sentiment: "positive",
      strategy: "react",
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect("proposals" in payload).toBe(false);
  });

  it("omite proposals quando undefined (autonomous_supervised default path)", () => {
    const payload = buildCompletePayload({
      responseText: "ok",
    });

    expect("proposals" in payload).toBe(false);
  });

  it("emite proposals[] quando há propostas (draft modes)", () => {
    const proposal = {
      action: "create-appointment",
      params: {
        calendar_id: "cal-1",
        service_id: "svc-1",
        customer_name: "Maria",
        date: "2026-06-10",
        start_time: "10:00",
      },
    };
    const payload = buildCompletePayload({
      responseText: "Proponho criar o agendamento.",
      sentiment: "neutral",
      strategy: "react",
      proposals: [proposal],
    });

    expect(payload.proposals).toBeDefined();
    expect(payload.proposals).toHaveLength(1);
    expect(payload.proposals?.[0]).toEqual(proposal);
  });

  it("preserva ordem e múltiplas proposals", () => {
    const p1 = { action: "create-appointment", params: { date: "2026-06-10" } };
    const p2 = { action: "send-message", params: { message: "ok" } };
    const payload = buildCompletePayload({
      responseText: "",
      proposals: [p1, p2],
    });

    expect(payload.proposals).toEqual([p1, p2]);
  });
});
