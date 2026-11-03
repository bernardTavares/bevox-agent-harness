import { describe, it, expect } from "vitest";

import type { ContextInput } from "../types.js";

import { BaseConfigLayer } from "./base-config.layer.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 10n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "You are a helpful scheduling assistant." },
  dispatchPayload: {},
};

describe("BaseConfigLayer", () => {
  it("returns system prompt as content", async () => {
    const layer = new BaseConfigLayer();
    const block = await layer.build(input);
    expect(block.content).toBe("You are a helpful scheduling assistant.");
    expect(block.compressible).toBe(false);
    expect(block.priority).toBe(10);
  });

  it("returns empty content when systemPrompt is missing", async () => {
    const layer = new BaseConfigLayer();
    const block = await layer.build({ ...input, agentConfig: { systemPrompt: "" } });
    expect(block.content).toBe("");
    expect(block.tokenEstimate).toBeGreaterThanOrEqual(0);
  });
});
