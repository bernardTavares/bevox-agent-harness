import { describe, it, expect, vi } from "vitest";

import {
  adaptMcpToolToSkill,
  validateRemoteInputSchema,
} from "../../../src/mcp/mcp-tool-adapter.js";
import type { AgentExecutionContext } from "../../../src/agents/execution-context.js";

type FakeClient = {
  callTool: ReturnType<typeof vi.fn>;
};

function makeClient(impl?: (args: unknown) => unknown): FakeClient {
  return {
    callTool: vi.fn(async (args: unknown) =>
      impl
        ? impl(args)
        : { isError: false, content: [{ type: "text", text: "ok" }] },
    ),
  };
}

const fakeCtx = {} as AgentExecutionContext;

const baseSchema = { type: "object", properties: { text: { type: "string" } } };

describe("validateRemoteInputSchema", () => {
  it("accepts a minimal object schema", () => {
    expect(validateRemoteInputSchema({ type: "object" })).toEqual({ ok: true });
  });

  it("rejects null", () => {
    expect(validateRemoteInputSchema(null).ok).toBe(false);
  });

  it("rejects non-object type", () => {
    expect(validateRemoteInputSchema({ type: "array" }).ok).toBe(false);
  });

  it("rejects malformed json schema", () => {
    expect(
      validateRemoteInputSchema({ type: "object", properties: "not-an-object" }).ok,
    ).toBe(false);
  });
});

describe("adaptMcpToolToSkill", () => {
  it("adapts a valid tool and prefixes the skill name", () => {
    const skill = adaptMcpToolToSkill(
      {
        name: "read_file",
        description: "Read a file from disk",
        inputSchema: baseSchema,
      },
      {
        serverId: "filesystem",
        client: makeClient() as never,
        timeoutMs: 5000,
      },
    );
    expect(skill).not.toBeNull();
    expect(skill!.manifest.name).toBe("mcp:filesystem.read_file");
    expect(skill!.manifest.category).toBe("knowledge");
    expect(skill!.manifest.agentType).toBe("surface");
  });

  it("accepts PascalCase / camelCase tool names from real servers", () => {
    const skill = adaptMcpToolToSkill(
      { name: "writeFile", description: "Write a file via remote", inputSchema: baseSchema },
      {
        serverId: "fs",
        client: makeClient() as never,
        timeoutMs: 1000,
      },
    );
    expect(skill).not.toBeNull();
    expect(skill!.manifest.name).toBe("mcp:fs.writeFile");
  });

  it("returns null when remote inputSchema is invalid", () => {
    const skill = adaptMcpToolToSkill(
      // missing inputSchema
      { name: "broken", description: "Bad schema tool", inputSchema: undefined as never },
      { serverId: "x", client: makeClient() as never, timeoutMs: 1000 },
    );
    expect(skill).toBeNull();
  });

  it("returns MCP_TOOL_ERROR when remote returns isError", async () => {
    const client = makeClient(() => ({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    }));
    const skill = adaptMcpToolToSkill(
      { name: "echo", description: "Echo a string back", inputSchema: baseSchema },
      { serverId: "fake", client: client as never, timeoutMs: 1000 },
    );
    const r = await skill!.module.execute({ text: "hi" }, fakeCtx);
    expect(r.success).toBe(false);
    expect(r.error).toBe("MCP_TOOL_ERROR");
    expect(r.detail).toContain("boom");
  });

  it("flattens content into data.text and data.raw", async () => {
    const content = [{ type: "text", text: "hello" }];
    const client = makeClient(() => ({ isError: false, content }));
    const skill = adaptMcpToolToSkill(
      { name: "echo", description: "Echo a string back", inputSchema: baseSchema },
      { serverId: "fake", client: client as never, timeoutMs: 1000 },
    );
    const r = await skill!.module.execute({ text: "hi" }, fakeCtx);
    expect(r.success).toBe(true);
    expect((r.data as { text: string }).text).toBe("hello");
    expect((r.data as { raw: unknown }).raw).toEqual(content);
  });

  it("times out long-running calls and returns MCP_CALL_FAILED", async () => {
    const client = { callTool: () => new Promise(() => {}) };
    const skill = adaptMcpToolToSkill(
      { name: "hang", description: "Never resolves on remote", inputSchema: baseSchema },
      { serverId: "slow", client: client as never, timeoutMs: 30 },
    );
    const r = await skill!.module.execute({}, fakeCtx);
    expect(r.success).toBe(false);
    expect(r.error).toBe("MCP_CALL_FAILED");
    expect(r.detail).toMatch(/timeout/i);
  });
});
