import { describe, it, expect } from "vitest";
import {
  classifyLLMError,
  isRetryable,
  type LLMErrorCategory } from
"../../../src/observability/error-classifier.js";

describe("classifyLLMError", () => {
  const cases: Array<[string, unknown, LLMErrorCategory]> = [
  ["HTTP 429", { status: 429, message: "Rate limit exceeded" }, "rate_limit"],
  ["statusCode 429", { statusCode: 429, message: "x" }, "rate_limit"],
  ["text rate limit", new Error("you hit the rate limit"), "rate_limit"],
  ["quota exceeded", new Error("Quota exhausted"), "rate_limit"],
  ["HTTP 401", { status: 401, message: "Invalid API key" }, "auth"],
  ["HTTP 403", { status: 403, message: "Forbidden" }, "auth"],
  ["unauthorized text", new Error("Unauthorized"), "auth"],
  ["api key text", new Error("missing api key"), "auth"],
  ["context length", new Error("context length 8192 exceeded"), "context_overflow"],
  ["token limit", new Error("token limit reached"), "context_overflow"],
  ["max context", new Error("Maximum context window"), "context_overflow"],
  ["ECONNREFUSED message", new Error("ECONNREFUSED 127.0.0.1"), "network"],
  ["ECONNREFUSED code", { code: "ECONNREFUSED", message: "" }, "network"],
  ["fetch failed", new Error("fetch failed"), "network"],
  ["server 503", { status: 503, message: "Service unavailable" }, "server_error"],
  ["server 500", { statusCode: 500, message: "boom" }, "server_error"],
  ["invalid json", new Error("invalid json response"), "invalid_response"],
  ["unexpected token", new Error("Unexpected token < in JSON"), "invalid_response"],
  ["unknown", new Error("???"), "unknown"],
  ["null", null, "unknown"],
  ["undefined", undefined, "unknown"],
  ["empty obj", {}, "unknown"]];


  for (const [label, err, expected] of cases) {
    it(`classifies "${label}" as ${expected}`, () => {
      expect(classifyLLMError(err)).toBe(expected);
    });
  }

  it("prefers statusCode over status when both present", () => {
    expect(classifyLLMError({ statusCode: 429, status: 500, message: "" })).toBe(
      "rate_limit"
    );
  });
});

describe("isRetryable", () => {
  it("retryable: rate_limit", () => expect(isRetryable("rate_limit")).toBe(true));
  it("retryable: network", () => expect(isRetryable("network")).toBe(true));
  it("retryable: server_error", () => expect(isRetryable("server_error")).toBe(true));
  it("not retryable: auth", () => expect(isRetryable("auth")).toBe(false));
  it("not retryable: context_overflow", () =>
  expect(isRetryable("context_overflow")).toBe(false));
  it("not retryable: invalid_response", () =>
  expect(isRetryable("invalid_response")).toBe(false));
  it("not retryable: unknown", () => expect(isRetryable("unknown")).toBe(false));
});