import { describe, it, expect } from "vitest";

import {
  sanitizeEntry,
  sanitizeString,
} from "../../../../src/integration/llm/cassette-sanitizer.js";

describe("cassette-sanitizer", () => {
  describe("sanitizeString", () => {
    it("redacts an OpenAI API key", () => {
      expect(sanitizeString("Use sk-abc123def456ghi789jkl012 to auth")).toContain("sk-REDACTED");
    });

    it("redacts an OpenAI project key", () => {
      expect(sanitizeString("sk-proj-AbCdEf1234567890XyZqRsTuVwXyZ")).toContain("sk-REDACTED");
    });

    it("redacts a Bearer token", () => {
      expect(sanitizeString("Bearer abc.def.ghi")).toContain("Bearer REDACTED");
    });

    it("redacts a Google AI Studio key", () => {
      expect(sanitizeString("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456")).toContain("AIza-REDACTED");
    });

    it("redacts a JWT", () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig123";
      expect(sanitizeString(jwt)).toContain("JWT-REDACTED");
    });

    it("redacts an Anthropic key", () => {
      expect(sanitizeString("sk-ant-api03-AbCdEf1234567890XyZqRsTuVw")).toContain(
        "sk-ant-REDACTED",
      );
    });

    it("passes benign strings through unchanged", () => {
      expect(sanitizeString("Hello, world!")).toBe("Hello, world!");
      expect(sanitizeString("agenda for next week")).toBe("agenda for next week");
    });
  });

  describe("sanitizeEntry", () => {
    it("redacts API key in response content", () => {
      const e = { response: { content: "Use sk-abc123def456ghi789jkl012 to auth" } };
      const out = sanitizeEntry(e);
      expect(out.response.content).toContain("sk-REDACTED");
    });

    it("redacts JWT in tool_calls arguments", () => {
      const e = {
        response: {
          tool_calls: [
            { id: "1", name: "x", arguments: { token: "eyJhbG.eyJzdWI.sig" } },
          ],
        },
      };
      const out = sanitizeEntry(e);
      expect((out.response.tool_calls[0].arguments as { token: string }).token).toBe(
        "JWT-REDACTED",
      );
    });

    it("preserves non-string values (numbers, booleans, null)", () => {
      const e = {
        response: {
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
          content: null,
          flag: true,
        },
      };
      const out = sanitizeEntry(e);
      expect(out.response.usage.input_tokens).toBe(12);
      expect(out.response.content).toBeNull();
      expect(out.response.flag).toBe(true);
    });
  });
});
