import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as client from "../../../src/integration/calendar-client.js";

describe("calendar-client", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockResponse(body: unknown, init: {ok?: boolean;status?: number;} = {}) {
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as unknown as Response;
  }

  describe("checkHealth", () => {
    it("passes when health endpoint returns valid object", async () => {
      global.fetch = vi.
      fn().
      mockResolvedValue(mockResponse({ status: "ok" })) as unknown as typeof fetch;
      await expect(client.checkHealth()).resolves.toBeUndefined();
    });

    it("throws when health endpoint returns non-OK", async () => {
      global.fetch = vi.
      fn().
      mockResolvedValue(mockResponse({}, { ok: false, status: 500 })) as unknown as typeof fetch;
      await expect(client.checkHealth()).rejects.toThrow(/unreachable/);
    });

    it("throws when fetch rejects", async () => {
      global.fetch = vi.
      fn().
      mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
      await expect(client.checkHealth()).rejects.toThrow(/unreachable/);
    });
  });

  describe("getAvailability", () => {
    it("calls GET with date query param", async () => {
      const spy = vi.fn().mockResolvedValue(mockResponse({ slots: [] }));
      global.fetch = spy as unknown as typeof fetch;
      await client.getAvailability("cal-1", "2026-05-14");
      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain("/api/v1/calendars/cal-1/availability");
      expect(url).toContain("date=2026-05-14");
    });

    it("includes serviceId when provided", async () => {
      const spy = vi.fn().mockResolvedValue(mockResponse({ slots: [] }));
      global.fetch = spy as unknown as typeof fetch;
      await client.getAvailability("cal-1", "2026-05-14", "svc-9");
      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain("serviceId=svc-9");
    });

    it("throws on non-OK status", async () => {
      global.fetch = vi.
      fn().
      mockResolvedValue(mockResponse({}, { ok: false, status: 404 })) as unknown as typeof fetch;
      await expect(client.getAvailability("c", "d")).rejects.toThrow(/404/);
    });

    it("throws when response fails Zod validation (non-object)", async () => {
      global.fetch = vi.
      fn().
      mockResolvedValue(mockResponse("not-an-object")) as unknown as typeof fetch;
      await expect(client.getAvailability("c", "d")).rejects.toThrow(/validation/);
    });
  });

  describe("createAppointment", () => {
    it("POSTs with body and bearer token", async () => {
      const spy = vi.fn().mockResolvedValue(mockResponse({ id: "a1" }));
      global.fetch = spy as unknown as typeof fetch;
      await client.createAppointment("cal-1", { foo: "bar" }, "tok-123");
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/v1/calendars/cal-1/appointments");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer tok-123");
      expect(init.body).toBe(JSON.stringify({ foo: "bar" }));
    });

    it("omits Authorization when token absent", async () => {
      const spy = vi.fn().mockResolvedValue(mockResponse({}));
      global.fetch = spy as unknown as typeof fetch;
      await client.createAppointment("cal-1", { foo: "bar" });
      const init = spy.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("throws on POST failure with body text", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => "bad request"
      } as unknown as Response) as unknown as typeof fetch;
      await expect(client.createAppointment("c", {})).rejects.toThrow(/400/);
    });
  });

  describe("cancelAppointment", () => {
    it("POSTs with reason", async () => {
      const spy = vi.fn().mockResolvedValue(mockResponse({}));
      global.fetch = spy as unknown as typeof fetch;
      await client.cancelAppointment("apt-1", "no-show");
      const init = spy.mock.calls[0][1] as RequestInit;
      expect(init.body).toBe(JSON.stringify({ reason: "no-show" }));
    });
  });

  describe("listAppointments", () => {
    it("validates array response", async () => {
      global.fetch = vi.
      fn().
      mockResolvedValue(mockResponse([{ id: "a1" }, { id: "a2" }])) as unknown as typeof fetch;
      const result = (await client.listAppointments("c1")) as unknown[];
      expect(result).toHaveLength(2);
    });

    it("validates object-wrapped array", async () => {
      global.fetch = vi.
      fn().
      mockResolvedValue(
        mockResponse({ appointments: [{ id: "a1" }] })
      ) as unknown as typeof fetch;
      const result = (await client.listAppointments("c1")) as {
        appointments: unknown[];
      };
      expect(result.appointments).toHaveLength(1);
    });

    it("appends dateFrom and dateTo to query", async () => {
      const spy = vi.fn().mockResolvedValue(mockResponse([]));
      global.fetch = spy as unknown as typeof fetch;
      await client.listAppointments("c1", "2026-05-01", "2026-05-31");
      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain("dateFrom=2026-05-01");
      expect(url).toContain("dateTo=2026-05-31");
    });

    it("omits query params when neither date provided", async () => {
      const spy = vi.fn().mockResolvedValue(mockResponse([]));
      global.fetch = spy as unknown as typeof fetch;
      await client.listAppointments("c1");
      const url = spy.mock.calls[0][0] as string;
      expect(url).not.toContain("?");
    });
  });

  describe("rescheduleAppointment", () => {
    it("PATCHes with newDate/newStartTime", async () => {
      const spy = vi.fn().mockResolvedValue(mockResponse({}));
      global.fetch = spy as unknown as typeof fetch;
      await client.rescheduleAppointment("apt-1", "2026-05-20", "10:00", "tok");
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/v1/appointments/apt-1");
      expect(init.method).toBe("PATCH");
      expect(init.body).toBe(
        JSON.stringify({ newDate: "2026-05-20", newStartTime: "10:00" })
      );
    });

    it("throws on PATCH failure", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({}),
        text: async () => "conflict"
      } as unknown as Response) as unknown as typeof fetch;
      await expect(
        client.rescheduleAppointment("apt-1", "d", "t")
      ).rejects.toThrow(/409/);
    });
  });

  describe("addToWaitlist", () => {
    it("POSTs to waitlist endpoint", async () => {
      const spy = vi.fn().mockResolvedValue(mockResponse({}));
      global.fetch = spy as unknown as typeof fetch;
      await client.addToWaitlist("cal-1", { contactId: 9 });
      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain("/api/v1/calendars/cal-1/waitlist");
    });
  });
});