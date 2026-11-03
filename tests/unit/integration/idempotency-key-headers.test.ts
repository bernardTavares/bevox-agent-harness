/**
 * C10 foundation — confirma que `idempotencyKey` é injetado como header
 * `Idempotency-Key` em todas as mutações HTTP (calendar-client +
 * bevox-callback). Cobre ADR-023 / PRD §13.3.
 *
 * Threading do step_index a partir dos reasoning engines até o
 * call-site é follow-up (issue #32). Esta suite garante a capability
 * de baixo nível.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as cb from "../../../src/integration/bevox-callback.js";
import * as cal from "../../../src/integration/calendar-client.js";
import { MutationTool } from "../../../src/tools/_shared/mutation-tool.js";

const ORIGINAL_FETCH = global.fetch;

function okJsonResponse(body: unknown = {}) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => body,
  } as unknown as Response;
}

describe("calendar-client — Idempotency-Key header", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it("createAppointment injeta header quando idempotencyKey fornecido", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse({ id: "appt-1" }));
    global.fetch = spy as unknown as typeof fetch;

    await cal.createAppointment("cal-1", { foo: "bar" }, "tok-1", "idem-key-abc");

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("idem-key-abc");
    expect(headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("createAppointment NÃO injeta header quando idempotencyKey omitido", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse({ id: "appt-1" }));
    global.fetch = spy as unknown as typeof fetch;

    await cal.createAppointment("cal-1", { foo: "bar" }, "tok-1");

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("cancelAppointment injeta header (POST)", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse({ ok: true }));
    global.fetch = spy as unknown as typeof fetch;

    await cal.cancelAppointment("appt-1", "user request", "tok-1", "idem-cancel");

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("idem-cancel");
    expect(init.method).toBe("POST");
  });

  it("rescheduleAppointment injeta header (PATCH)", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse({ ok: true }));
    global.fetch = spy as unknown as typeof fetch;

    await cal.rescheduleAppointment("appt-1", "2026-06-10", "09:00", "tok-1", "idem-reschedule");

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("idem-reschedule");
    expect(init.method).toBe("PATCH");
  });

  it("addToWaitlist injeta header", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse({ ok: true }));
    global.fetch = spy as unknown as typeof fetch;

    await cal.addToWaitlist("cal-1", { contact_id: "c1" }, "tok-1", "idem-waitlist");

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("idem-waitlist");
  });
});

describe("bevox-callback.sendComplete — Idempotency-Key header", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it("injeta header quando idempotencyKey fornecido", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse());
    global.fetch = spy as unknown as typeof fetch;

    await cb.sendComplete(
      "exec-1",
      "tok-1",
      cb.buildCompletePayload({ responseText: "ok" }),
      "idem-complete",
    );

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("idem-complete");
    expect(headers["X-Execution-Token"]).toBe("tok-1");
  });

  it("NÃO injeta header quando idempotencyKey omitido (backward-compat)", async () => {
    const spy = vi.fn().mockResolvedValue(okJsonResponse());
    global.fetch = spy as unknown as typeof fetch;

    await cb.sendComplete("exec-1", "tok-1", cb.buildCompletePayload({ responseText: "ok" }));

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });
});

describe("sendComplete idempotency key discriminated by terminal outcome", () => {
  const exec = "exec-term-1";
  const org = "org-term-1";
  const makeKey = (kind: string) =>
    MutationTool.deriveIdempotencyKey(
      { execution_id: exec, organization_id: org },
      `complete:${kind}`,
      {},
    );

  it("success and failed derive DISTINCT keys (no cross-outcome dedup)", () => {
    expect(makeKey("success")).not.toBe(makeKey("failed"));
  });

  it("request-human and workflow derive DISTINCT keys", () => {
    expect(makeKey("request-human")).not.toBe(makeKey("workflow"));
  });

  it("same outcome → SAME key (retry of same terminal state deduplicates)", () => {
    expect(makeKey("success")).toBe(makeKey("success"));
  });

  it("the complete key is sha256-hex (passes backend regex)", () => {
    expect(makeKey("success")).toMatch(/^[0-9a-f]{64}$/);
  });
});
