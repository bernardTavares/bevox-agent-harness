import { describe, it, expect } from "vitest";

import { BaseConfigLayer } from "../../../../src/context/layers/base-config.layer.js";
import type { ContextInput } from "../../../../src/context/types.js";

const input: ContextInput = {
  executionId: "e1",
  accountId: 1,
  contactId: 10n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "You are a helpful scheduling assistant." },
  dispatchPayload: {}
};

describe("BaseConfigLayer", () => {
  it("returns system prompt as content", async () => {
    const layer = new BaseConfigLayer();
    const block = await layer.build(input);
    expect(block.content).toBe("You are a helpful scheduling assistant.");
    expect(block.section).toBe("## Configuracao base");
    expect(block.compressible).toBe(false);
    expect(block.priority).toBe(10);
  });

  it("returns empty content when systemPrompt is empty", async () => {
    const layer = new BaseConfigLayer();
    const block = await layer.build({
      ...input,
      agentConfig: { systemPrompt: "" }
    });
    expect(block.content).toBe("");
    expect(block.tokenEstimate).toBeGreaterThanOrEqual(0);
  });

  it("falls back to empty string when systemPrompt is null/undefined", async () => {
    const layer = new BaseConfigLayer();
    const block = await layer.build({
      ...input,
      agentConfig: { systemPrompt: undefined as unknown as string }
    });
    expect(block.content).toBe("");
  });

  it("tokenEstimate includes section header", async () => {
    const layer = new BaseConfigLayer();
    const block = await layer.build(input);
    expect(block.tokenEstimate).toBeGreaterThan(0);
  });

  it("exposes correct layer metadata", () => {
    const layer = new BaseConfigLayer();
    expect(layer.name).toBe("base-config");
    expect(layer.priority).toBe(10);
    expect(layer.compressible).toBe(false);
  });
});