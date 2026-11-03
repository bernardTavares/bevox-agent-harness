import { describe, it, expect, vi } from "vitest";

import { COMPRESSIBLE_MARKER } from "../context/budget-enforcer.js";
import type { BuiltContext, ContextBlock } from "../context/types.js";
import { buildContextInput, foldContext, setContextSpanAttributes } from "./context-wiring.js";

const block = (section: string, content: string, priority: number, compressible: boolean): ContextBlock => ({
  section,
  content,
  tokenEstimate: 10,
  priority,
  compressible,
});

const built: BuiltContext = {
  systemPrompt: "ignored",
  totalTokens: 40,
  layersUsed: [],
  compressed: false,
  layersFailed: ["memory"],
  layersFailedUnexpected: [],
  blocks: [
    block("## Configuracao base", "BASE", 10, false),
    block("## Regras de encaminhamento", "RULES", 20, false),
    block("## Informacoes do contato", "MEM", 40, true),
    block("## Historico da conversa", "HIST", 50, true),
  ],
};

describe("buildContextInput", () => {
  it("maps runtime values, leaves maxContextTokens undefined, passes contactId through", () => {
    const input = buildContextInput({
      executionId: "e1",
      organizationId: "org-1",
      contactId: 42n,
      conversationKey: "conv-1",
      systemPrompt: "RAW BASE",
      dispatchPayload: { foo: 1 },
      userMessage: "hi",
      tokenBudget: 4000,
    });
    expect(input.executionId).toBe("e1");
    expect(input.organizationId).toBe("org-1");
    expect(input.contactId).toBe(42n);
    expect(input.conversationKey).toBe("conv-1");
    expect(input.agentConfig.systemPrompt).toBe("RAW BASE");
    expect(input.agentConfig.maxContextTokens).toBeUndefined();
    expect(input.userMessage).toBe("hi");
    expect(input.tokenBudget).toBe(4000);
    expect(input.dispatchPayload).toEqual({ foo: 1 });
  });
});

describe("foldContext", () => {
  it("orders head (non-compressible blocks + doctrine) then tail (compressible blocks); no marker by default", () => {
    const folded = foldContext(built, "DOCTRINE");
    const baseIdx = folded.indexOf("BASE");
    const rulesIdx = folded.indexOf("RULES");
    const doctrineIdx = folded.indexOf("DOCTRINE");
    const memIdx = folded.indexOf("MEM");
    const histIdx = folded.indexOf("HIST");
    expect(baseIdx).toBeLessThan(rulesIdx);
    expect(rulesIdx).toBeLessThan(doctrineIdx);
    expect(doctrineIdx).toBeLessThan(memIdx);
    expect(memIdx).toBeLessThan(histIdx);
    expect(folded).not.toContain(COMPRESSIBLE_MARKER);
  });

  it("omits an empty doctrine tail without leaving an orphan separator", () => {
    const folded = foldContext(built, "");
    expect(folded).toContain("RULES");
    expect(folded).toContain("MEM");
    expect(folded.endsWith("\n")).toBe(false);
    expect(folded).not.toContain("\n\n\n");
  });

  it("inserts COMPRESSIBLE_MARKER between head and tail when withMarker=true", () => {
    const folded = foldContext(built, "DOCTRINE", { withMarker: true });
    const markerIdx = folded.indexOf(COMPRESSIBLE_MARKER);
    expect(markerIdx).toBeGreaterThan(folded.indexOf("DOCTRINE"));
    expect(markerIdx).toBeLessThan(folded.indexOf("MEM"));
  });

  it("renders the base block exactly once (B5)", () => {
    const folded = foldContext(built, "DOCTRINE");
    const matches = folded.match(/## Configuracao base/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe("setContextSpanAttributes", () => {
  it("sets layers used/failed/count span attributes", () => {
    const setAttribute = vi.fn();
    setContextSpanAttributes({ setAttribute } as never, built);
    expect(setAttribute).toHaveBeenCalledWith(
      "context.layers.used",
      "## Configuracao base,## Regras de encaminhamento,## Informacoes do contato,## Historico da conversa",
    );
    expect(setAttribute).toHaveBeenCalledWith("context.layers.failed", "memory");
    expect(setAttribute).toHaveBeenCalledWith("context.layers.failed_unexpected", "");
    expect(setAttribute).toHaveBeenCalledWith("context.layers.count", 4);
    expect(setAttribute).toHaveBeenCalledWith("context.total_tokens", 40);
  });
});

import { enforceBudget } from "../context/budget-enforcer.js";

describe("foldContext + enforceBudget (Phase 3 head-preserving)", () => {
  it("never truncates the head (base/rules/doctrine) under a tight budget", () => {
    const bigTail = Array.from({ length: 400 }, (_, i) => `line ${i} of history`).join("\n");
    const builtBig: BuiltContext = {
      systemPrompt: "ignored",
      totalTokens: 0,
      layersUsed: [],
      compressed: false,
      layersFailed: [],
      layersFailedUnexpected: [],
      blocks: [
        block("## Configuracao base", "IMPORTANT_BASE_PROMPT", 10, false),
        block("## Regras de encaminhamento", "IMPORTANT_RULES", 20, false),
        block("## Historico da conversa", bigTail, 50, true),
      ],
    };
    const folded = foldContext(builtBig, "IMPORTANT_DOCTRINE", { withMarker: true });
    // Budget must exceed MIN_PROMPT_TOKENS (200, budget-enforcer.ts:48) with
    // zero tools, otherwise enforceBudget refuses to compress (returns the full
    // prompt + warning). 300 is over the floor yet far below the ~2100-token
    // folded prompt, so compression runs and the head stays intact.
    const enforced = enforceBudget({ systemPrompt: folded, tools: [], maxContextTokens: 300 });

    expect(enforced.wasCompressed).toBe(true);
    expect(enforced.systemPrompt).toContain("IMPORTANT_BASE_PROMPT");
    expect(enforced.systemPrompt).toContain("IMPORTANT_RULES");
    expect(enforced.systemPrompt).toContain("IMPORTANT_DOCTRINE");
    // tail was trimmed
    expect(enforced.systemPrompt).not.toContain("line 399 of history");
  });
});
