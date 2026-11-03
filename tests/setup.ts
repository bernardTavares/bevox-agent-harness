import { afterEach, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

process.env.NODE_ENV = "test";
process.env.HARNESS_LOG_LEVEL = "error";
// Provide minimum envs so getEnv() (Zod-validated) does not crash in tests that
// transitively import config modules. Tests that need real values override these.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.BEVOX_CALLBACK_BASE_URL =
  process.env.BEVOX_CALLBACK_BASE_URL ?? "http://localhost:3000";
process.env.CALENDAR_SERVICE_URL = process.env.CALENDAR_SERVICE_URL ?? "http://localhost:3009/api";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-key";
process.env.DEFAULT_LLM_PROVIDER = process.env.DEFAULT_LLM_PROVIDER ?? "openai";
process.env.DEFAULT_LLM_MODEL = process.env.DEFAULT_LLM_MODEL ?? "gpt-4o-mini";
// Zod schema exige >= 32 chars; valor de teste fixo evita process.exit(1)
// em qualquer suite que transitivamente importe config modules.
process.env.MCP_SERVER_TOKEN =
  process.env.MCP_SERVER_TOKEN ?? "test-mcp-server-token-32chars-minimum-aaa";
