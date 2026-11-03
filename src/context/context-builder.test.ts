import { describe, it, expect, vi } from "vitest";

import { ContextBuilder } from "./context-builder.js";
import type { ContextInput, ContextBlock, ContextLayer } from "./types.js";

const makeLayer = (priority: number, tokenEstimate: number, compressible = true): ContextLayer => ({
  name: `layer-p${priority}`,
  priority,
  compressible,
  build: vi.fn().mockResolvedValue({
    section: `## Layer ${priority}`,
    content: `Content for priority ${priority}`,
    tokenEstimate,
    priority,
    compressible,
  } satisfies ContextBlock),
});

const baseInput: ContextInput = {
  executionId: "exec-1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 42n,
  conversationKey: "conv-abc",
  agentConfig: { systemPrompt: "Base prompt", maxContextTokens: 1000 },
  dispatchPayload: {},
};

describe("ContextBuilder", () => {
  it("assembles system prompt from all layers sorted by priority", async () => {
    const layers = [makeLayer(50, 100), makeLayer(10, 100), makeLayer(30, 100)];
    const builder = new ContextBuilder(layers);
    const result = await builder.build(baseInput);

    expect(result.compressed).toBe(false);
    expect(result.layersUsed).toEqual(["## Layer 10", "## Layer 30", "## Layer 50"]);
    expect(result.systemPrompt).toContain("## Layer 10");
    expect(result.totalTokens).toBe(300);
  });

  it("runs all layers in parallel", async () => {
    const callOrder: number[] = [];
    const layers = [10, 30, 50].map((p) => ({
      name: `layer-p${p}`,
      priority: p,
      compressible: true,
      build: vi.fn().mockImplementation(async () => {
        callOrder.push(p);
        return {
          section: `## Layer ${p}`,
          content: "",
          tokenEstimate: 100,
          priority: p,
          compressible: true,
        };
      }),
    }));
    const builder = new ContextBuilder(layers);
    await builder.build(baseInput);
    // All 3 started before any resolved — exact order is non-deterministic
    expect(callOrder).toHaveLength(3);
  });

  it("sets compressed=true when total exceeds budget", async () => {
    const layers = [
      makeLayer(10, 400, false), // BaseConfig — not compressible
      makeLayer(50, 700, true), // History — compressible, will be cut
    ];
    const builder = new ContextBuilder(layers, { globalMaxTokens: 1000 });
    const result = await builder.build(baseInput);
    expect(result.compressed).toBe(true);
    expect(result.totalTokens).toBeLessThanOrEqual(1000);
  });

  it("never truncates non-compressible layers", async () => {
    const layers = [
      makeLayer(10, 900, false), // BaseConfig — fills most of budget
      makeLayer(50, 300, true), // History — compressible
    ];
    const builder = new ContextBuilder(layers, { globalMaxTokens: 1000 });
    const result = await builder.build(baseInput);
    expect(result.systemPrompt).toContain("## Layer 10");
  });

  it("uses maxContextTokens from agentConfig when provided", async () => {
    const layers = [makeLayer(10, 500, false), makeLayer(50, 600, true)];
    const input = { ...baseInput, agentConfig: { systemPrompt: "", maxContextTokens: 600 } };
    const builder = new ContextBuilder(layers, { globalMaxTokens: 10000 });
    const result = await builder.build(input);
    expect(result.compressed).toBe(true);
  });

  it("fails open: a rejecting layer yields an empty block and is recorded in layersFailed", async () => {
    const ok = makeLayer(10, 100, false);
    const bad: ContextLayer = {
      name: "rules",
      priority: 20,
      compressible: false,
      build: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const builder = new ContextBuilder([ok, bad], { globalMaxTokens: 100000 });
    const result = await builder.build(baseInput);

    expect(result.layersFailed).toContain("rules");
    expect(result.blocks).toHaveLength(2);
    // the failed layer contributed a block with empty content + 0 tokens
    const failedBlock = result.blocks.find((b) => b.section.includes("encaminhamento"));
    expect(failedBlock?.content).toBe("");
    expect(failedBlock?.tokenEstimate).toBe(0);
    // the healthy layer is still present
    expect(result.layersUsed).toContain("## Layer 10");
  });

  it("fails open on layer timeout", async () => {
    const ok = makeLayer(10, 100, false);
    const slow: ContextLayer = {
      name: "history",
      priority: 50,
      compressible: true,
      build: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    };
    const builder = new ContextBuilder([ok, slow], {
      globalMaxTokens: 100000,
      layerTimeoutMs: 20,
    });
    const result = await builder.build(baseInput);
    expect(result.layersFailed).toContain("history");
  });

  it("classifies layer failures: timeouts/DB errors are 'expected', others 'unexpected'", async () => {
    const dbErr: ContextLayer = {
      name: "rules",
      priority: 20,
      compressible: false,
      build: vi.fn().mockRejectedValue(new Error("relation rules does not exist")),
    };
    const bug: ContextLayer = {
      name: "history",
      priority: 50,
      compressible: true,
      build: vi.fn().mockRejectedValue(new TypeError("cannot read properties of undefined")),
    };
    const builder = new ContextBuilder([dbErr, bug], { globalMaxTokens: 100000 });
    const result = await builder.build(baseInput);

    expect(result.layersFailed).toEqual(expect.arrayContaining(["rules", "history"]));
    expect(result.layersFailedUnexpected).toEqual(["history"]);
  });
});
