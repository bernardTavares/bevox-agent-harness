import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { adaptMcpToolToSkill } from "../../src/mcp/mcp-tool-adapter.js";
import { McpClientRegistry } from "../../src/mcp/client-registry.js";
import { UnifiedToolRegistry } from "../../src/tools/unified-registry.js";
import type { AgentExecutionContext } from "../../src/agents/execution-context.js";

async function spinUpFakeServer(opts: {
  toolName: string;
  toolDescription: string;
  handler: (args: { text: string }) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer({ name: "fake", version: "0.0.1" });
  server.registerTool(
    opts.toolName,
    {
      description: opts.toolDescription,
      inputSchema: { text: z.string() },
    },
    async ({ text }: { text: string }) => opts.handler({ text }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("mcp client integration", () => {
  beforeEach(() => {
    UnifiedToolRegistry.resetForTests();
    McpClientRegistry.resetForTests();
  });

  afterEach(() => {
    UnifiedToolRegistry.resetForTests();
    McpClientRegistry.resetForTests();
  });

  it("connects to fake server and adapts tool as mcp:-prefixed skill", async () => {
    const { client, close } = await spinUpFakeServer({
      toolName: "echo",
      toolDescription: "Echo back the provided text",
      handler: async ({ text }) => ({ content: [{ type: "text", text: `got:${text}` }] }),
    });

    try {
      const tools = await client.listTools();
      expect(tools.tools.length).toBe(1);

      const skill = adaptMcpToolToSkill(tools.tools[0], {
        serverId: "fake",
        client,
        timeoutMs: 5_000,
      });
      expect(skill).not.toBeNull();
      expect(skill!.manifest.name).toBe("mcp:fake.echo");

      // Register and round-trip an execute() through the UnifiedToolRegistry
      const reg = UnifiedToolRegistry.getInstance();
      reg.register(skill!);
      expect(reg.get("mcp:fake.echo")).toBeTruthy();

      const result = await skill!.module.execute({ text: "hello" }, {} as AgentExecutionContext);
      expect(result.success).toBe(true);
      expect((result.data as { text: string }).text).toBe("got:hello");
    } finally {
      await close();
    }
  });

  it("returns MCP_CALL_FAILED when server tool hangs (timeout)", async () => {
    const { client, close } = await spinUpFakeServer({
      toolName: "hang",
      toolDescription: "A tool that never resolves",
      handler: () => new Promise(() => {}) as never,
    });

    try {
      const tools = await client.listTools();
      const skill = adaptMcpToolToSkill(tools.tools[0], {
        serverId: "slow",
        client,
        timeoutMs: 50,
      });
      const r = await skill!.module.execute({ text: "x" }, {} as AgentExecutionContext);
      expect(r.success).toBe(false);
      expect(r.error).toBe("MCP_CALL_FAILED");
      expect(r.detail).toMatch(/timeout/i);
    } finally {
      await close();
    }
  });
});
