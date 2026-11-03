import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createContextBuilder } from "./builder-factory.js";
import { ContextBuilder } from "./context-builder.js";
import { resetMemoryRegistryForTests, setSemanticRecall } from "../memory/registry.js";

describe("createContextBuilder", () => {
  beforeEach(() => resetMemoryRegistryForTests());
  afterEach(() => resetMemoryRegistryForTests());

  it("returns a ContextBuilder instance", () => {
    const db = { query: vi.fn() } as never;
    const builder = createContextBuilder({ db });
    expect(builder).toBeInstanceOf(ContextBuilder);
  });

  it("instantiates exactly 4 layers (Calendar deferred — B2)", () => {
    const db = { query: vi.fn() } as never;
    const builder = createContextBuilder({ db });
    // access private layers for the test
    const layers = (builder as unknown as { layers: { name: string }[] }).layers;
    const names = layers.map((l) => l.name).sort();
    expect(names).toEqual(["base-config", "history", "memory", "rules"]);
  });

  it("passes layerTimeoutMs and globalMaxTokens options through", () => {
    const db = { query: vi.fn() } as never;
    const builder = createContextBuilder({ db }, { globalMaxTokens: 12345, layerTimeoutMs: 50 });
    expect((builder as unknown as { globalMaxTokens: number }).globalMaxTokens).toBe(12345);
    expect((builder as unknown as { layerTimeoutMs: number }).layerTimeoutMs).toBe(50);
  });

  it("uses the registry semanticRecall by default and caller override otherwise", () => {
    const db = { query: vi.fn() } as never;
    const registryRecall = { recall: vi.fn() } as never;
    setSemanticRecall(registryRecall);
    const builder = createContextBuilder({ db });
    const memoryLayer = (builder as unknown as { layers: { name: string; opts?: unknown }[] }).layers.find(
      (l) => l.name === "memory",
    ) as unknown as { opts: { semanticRecall: unknown; factsRepo: unknown } };
    expect(memoryLayer.opts.semanticRecall).toBe(registryRecall);
    expect(memoryLayer.opts.factsRepo).toBeDefined();
  });
});
