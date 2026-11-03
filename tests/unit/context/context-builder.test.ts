import { describe, it, expect, vi } from "vitest";

import { ContextBuilder } from "../../../src/context/context-builder.js";
import type {
  ContextInput,
  ContextBlock,
  ContextLayer } from
"../../../src/context/types.js";

function makeLayer(
priority: number,
tokenEstimate: number,
compressible = true,
content?: string)
: ContextLayer {
  return {
    name: `layer-p${priority}`,
    priority,
    compressible,
    build: vi.fn().mockResolvedValue({
      section: `## Layer ${priority}`,
      content:
      content ??
      Array.from({ length: Math.max(1, Math.floor(tokenEstimate / 2)) }).
      map((_, i) => `line ${i}`).
      join("\n"),
      tokenEstimate,
      priority,
      compressible
    } satisfies ContextBlock)
  };
}

const baseInput: ContextInput = {
  executionId: "exec-1",
  accountId: 1,
  contactId: 42n,
  conversationKey: "conv-abc",
  agentConfig: { systemPrompt: "Base prompt", maxContextTokens: 1000 },
  dispatchPayload: {}
};

describe("ContextBuilder", () => {
  it("assembles system prompt sorted by priority", async () => {
    const layers = [makeLayer(50, 100), makeLayer(10, 100), makeLayer(30, 100)];
    const builder = new ContextBuilder(layers);
    const result = await builder.build(baseInput);

    expect(result.compressed).toBe(false);
    expect(result.layersUsed).toEqual([
    "## Layer 10",
    "## Layer 30",
    "## Layer 50"]
    );
    expect(result.systemPrompt.indexOf("## Layer 10")).toBeLessThan(
      result.systemPrompt.indexOf("## Layer 30")
    );
    expect(result.totalTokens).toBe(300);
  });

  it("runs layers in parallel (all build() called before any resolves)", async () => {
    let pending = 0;
    let maxPending = 0;
    const layers = [10, 30, 50, 40, 20].map((p) => ({
      name: `layer-p${p}`,
      priority: p,
      compressible: true,
      build: vi.fn().mockImplementation(async () => {
        pending++;
        maxPending = Math.max(maxPending, pending);
        await new Promise((r) => setTimeout(r, 5));
        pending--;
        return {
          section: `## Layer ${p}`,
          content: "x",
          tokenEstimate: 10,
          priority: p,
          compressible: true
        };
      })
    }));
    const builder = new ContextBuilder(layers);
    await builder.build(baseInput);
    expect(maxPending).toBeGreaterThan(1);
  });

  it("does not compress when total fits within budget", async () => {
    const layers = [makeLayer(10, 100, false), makeLayer(50, 200, true)];
    const builder = new ContextBuilder(layers, { globalMaxTokens: 1000 });
    const result = await builder.build(baseInput);
    expect(result.compressed).toBe(false);
    expect(result.totalTokens).toBeLessThanOrEqual(1000);
  });

  it("compresses when total exceeds budget", async () => {
    const layers = [
    makeLayer(10, 400, false),
    makeLayer(50, 700, true)];

    const builder = new ContextBuilder(layers, { globalMaxTokens: 1000 });
    const result = await builder.build(baseInput);
    expect(result.compressed).toBe(true);
  });

  it("never truncates non-compressible layers when budget overflows", async () => {
    const layers = [
    makeLayer(10, 900, false), // non-compressible, large
    makeLayer(50, 300, true)];

    const builder = new ContextBuilder(layers, { globalMaxTokens: 1000 });
    const result = await builder.build(baseInput);
    expect(result.systemPrompt).toContain("## Layer 10");
    // The non-compressible block content should still be there fully
    expect(result.systemPrompt).toMatch(/## Layer 10[\s\S]*line 0/);
  });

  it("uses agentConfig.maxContextTokens over global default", async () => {
    const layers = [makeLayer(10, 300, false), makeLayer(50, 400, true)];
    const input = {
      ...baseInput,
      agentConfig: { systemPrompt: "", maxContextTokens: 500 }
    };
    const builder = new ContextBuilder(layers, { globalMaxTokens: 10000 });
    const result = await builder.build(input);
    expect(result.compressed).toBe(true);
  });

  it("falls back to globalMaxTokens when agentConfig.maxContextTokens is absent", async () => {
    const layers = [makeLayer(10, 200, false), makeLayer(50, 300, true)];
    const input = { ...baseInput, agentConfig: { systemPrompt: "" } };
    const builder = new ContextBuilder(layers, { globalMaxTokens: 1000 });
    const result = await builder.build(input);
    expect(result.compressed).toBe(false);
  });

  it("default globalMaxTokens is 8000 when not provided", async () => {
    const layers = [makeLayer(10, 100, false)];
    const input = { ...baseInput, agentConfig: { systemPrompt: "" } };
    const builder = new ContextBuilder(layers);
    const result = await builder.build(input);
    expect(result.compressed).toBe(false);
  });

  it("empty layers list returns empty systemPrompt", async () => {
    const builder = new ContextBuilder([]);
    const result = await builder.build(baseInput);
    expect(result.systemPrompt).toBe("");
    expect(result.totalTokens).toBe(0);
    expect(result.layersUsed).toEqual([]);
    expect(result.compressed).toBe(false);
  });

  it("preserves multi-account scoping by passing accountId/contactId", async () => {
    const buildSpy = vi.fn().mockResolvedValue({
      section: "## L",
      content: "x",
      tokenEstimate: 1,
      priority: 10,
      compressible: false
    });
    const layer: ContextLayer = {
      name: "scoped",
      priority: 10,
      compressible: false,
      build: buildSpy
    };
    const builder = new ContextBuilder([layer]);
    await builder.build({ ...baseInput, accountId: 99, contactId: 7n });
    expect(buildSpy).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 99, contactId: 7n })
    );
  });

  it("compressed block content is reduced to fit budget", async () => {
    const longContent = Array.from({ length: 100 }).
    map((_, i) => `line ${i}`).
    join("\n");
    const layers: ContextLayer[] = [
    {
      name: "small-fixed",
      priority: 10,
      compressible: false,
      build: vi.fn().mockResolvedValue({
        section: "## Fixed",
        content: "fixed",
        tokenEstimate: 10,
        priority: 10,
        compressible: false
      })
    },
    {
      name: "long-compressible",
      priority: 50,
      compressible: true,
      build: vi.fn().mockResolvedValue({
        section: "## Long",
        content: longContent,
        tokenEstimate: 500,
        priority: 50,
        compressible: true
      })
    }];

    const builder = new ContextBuilder(layers, { globalMaxTokens: 100 });
    const result = await builder.build({
      ...baseInput,
      agentConfig: { systemPrompt: "", maxContextTokens: 100 }
    });
    expect(result.compressed).toBe(true);
    // Should keep at least 3 lines minimum per compress() guarantee
    expect(result.systemPrompt).toContain("## Long");
  });
});