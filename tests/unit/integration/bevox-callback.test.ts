import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as cb from "../../../src/integration/bevox-callback.js";

describe("bevox-callback", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function okResponse() {
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({}),
    } as unknown as Response;
  }

  function badResponse(status: number, text = "err") {
    return {
      ok: false,
      status,
      text: async () => text,
    } as unknown as Response;
  }

  describe("sendTrace", () => {
    it("POSTs trace wrapped in traces array with token header", async () => {
      const spy = vi.fn().mockResolvedValue(okResponse());
      global.fetch = spy as unknown as typeof fetch;

      const trace: cb.TraceEntry = {
        step: 1,
        type: "thought",
        content: "thinking",
        timestamp: "2026-05-14T10:00:00Z",
      };
      await cb.sendTrace("exec-1", "tok-1", trace);

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/v1/executions/exec-1/traces");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Execution-Token"]).toBe("tok-1");
      const body = JSON.parse(init.body as string) as { traces: cb.TraceEntry[] };
      expect(body.traces).toHaveLength(1);
      expect(body.traces[0].step).toBe(1);
    });

    it("throws when server returns non-OK", async () => {
      global.fetch = vi.fn().mockResolvedValue(badResponse(500, "boom")) as unknown as typeof fetch;
      await expect(
        cb.sendTrace("e", "t", {
          step: 0,
          type: "action",
          content: "",
          timestamp: "",
        }),
      ).rejects.toThrow(/500/);
    });
  });

  describe("sendStream", () => {
    it("POSTs chunk and index", async () => {
      const spy = vi.fn().mockResolvedValue(okResponse());
      global.fetch = spy as unknown as typeof fetch;
      await cb.sendStream("exec-9", "tok", "chunk-text", 5);
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/v1/executions/exec-9/stream");
      const body = JSON.parse(init.body as string) as {
        chunk: string;
        index: number;
      };
      expect(body).toEqual({ chunk: "chunk-text", index: 5 });
    });
  });

  describe("updateStatus", () => {
    it("POSTs status to status endpoint", async () => {
      const spy = vi.fn().mockResolvedValue(okResponse());
      global.fetch = spy as unknown as typeof fetch;
      await cb.updateStatus("e1", "tok", "running");
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/v1/executions/e1/status");
      const body = JSON.parse(init.body as string) as { status: string };
      expect(body.status).toBe("running");
    });

    it("throws on failure with text in error", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(badResponse(503, "unavailable")) as unknown as typeof fetch;
      await expect(cb.updateStatus("e1", "t", "running")).rejects.toThrow(/503/);
    });
  });

  describe("sendComplete", () => {
    it("POSTs full payload to complete endpoint (new contract: response_text + obrigatórios)", async () => {
      const spy = vi.fn().mockResolvedValue(okResponse());
      global.fetch = spy as unknown as typeof fetch;
      const payload: cb.CompletePayload = {
        response_text: "done",
        sentiment: "positive",
        strategy: "react",
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      };
      await cb.sendComplete("e1", "tok", payload);
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/v1/executions/e1/complete");
      const body = JSON.parse(init.body as string) as cb.CompletePayload;
      expect(body.response_text).toBe("done");
      expect(body.usage.prompt_tokens).toBe(100);
    });

    it("uses Content-Type application/json header", async () => {
      const spy = vi.fn().mockResolvedValue(okResponse());
      global.fetch = spy as unknown as typeof fetch;
      await cb.sendComplete("e1", "tok", cb.buildCompletePayload({ responseText: "x" }));
      const init = spy.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("throws when response.text rejects gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => {
          throw new Error("body read err");
        },
      } as unknown as Response) as unknown as typeof fetch;
      await expect(
        cb.sendComplete("e1", "tok", cb.buildCompletePayload({ responseText: "x" })),
      ).rejects.toThrow(/502/);
    });
  });

  describe("buildCompletePayload (helper canônico que preenche os 4 obrigatórios)", () => {
    it("preenche defaults seguros (sentiment=neutral, strategy=direct, usage=0/0)", () => {
      const p = cb.buildCompletePayload({ responseText: "hello" });
      expect(p).toEqual({
        response_text: "hello",
        sentiment: "neutral",
        strategy: "direct",
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    });

    it("respeita overrides parciais", () => {
      const p = cb.buildCompletePayload({
        responseText: "x",
        strategy: "workflow",
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      });
      expect(p.strategy).toBe("workflow");
      expect(p.sentiment).toBe("neutral"); // default mantido
      expect(p.usage).toEqual({ prompt_tokens: 42, completion_tokens: 7 });
    });

    it("inclui proposals só quando array não-vazio", () => {
      expect(cb.buildCompletePayload({ responseText: "x" }).proposals).toBeUndefined();
      expect(
        cb.buildCompletePayload({ responseText: "x", proposals: [] }).proposals,
      ).toBeUndefined();
      const withProps = cb.buildCompletePayload({
        responseText: "x",
        proposals: [{ action: "send-message" }],
      });
      expect(withProps.proposals).toHaveLength(1);
    });
  });
});
