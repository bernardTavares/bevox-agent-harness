import type { Pool } from "pg";

import { ContactFactsRepository } from "../memory/contact-facts.repository.js";
import { getSemanticRecall } from "../memory/registry.js";
import { ContextBuilder } from "./context-builder.js";
import { BaseConfigLayer, RulesLayer, MemoryLayer, HistoryLayer } from "./layers/index.js";
import type { MemoryLayerOptions } from "./layers/memory.layer.js";

export interface BuilderDeps {
  db: Pool;
  /**
   * Optional overrides for MemoryLayer. When omitted, factsRepo is built from
   * `db` and semanticRecall is read from the process-singleton registry
   * (getSemanticRecall) — both nullable, both fail-open inside the layer.
   */
  memory?: Partial<MemoryLayerOptions>;
}

export interface BuilderFactoryOptions {
  globalMaxTokens?: number;
  layerTimeoutMs?: number;
}

/**
 * DI factory for the runtime ContextBuilder (CTX-01 / issue #39).
 *
 * Phase 1 wires 4 layers: BaseConfig (zero-arg), Rules (Pool), Memory
 * (Pool + opts), History (Pool). CalendarLayer is deferred (B2) until a
 * `CalendarContextAdapter` over `src/integration/calendar-client.ts` exists.
 *
 * `layers/index.ts` exports CLASSES, not instances — so each is constructed
 * here with its required dependency.
 */
export function createContextBuilder(
  deps: BuilderDeps,
  options: BuilderFactoryOptions = {},
): ContextBuilder {
  const memoryOpts: MemoryLayerOptions = {
    // spread FIRST so the defaults below only fill what the caller omitted
    // (avoids clobbering caller-supplied values with undefined).
    ...deps.memory,
    factsRepo: deps.memory?.factsRepo ?? new ContactFactsRepository(deps.db),
    semanticRecall: deps.memory?.semanticRecall ?? getSemanticRecall(),
  };

  const layers = [
    new BaseConfigLayer(),
    new RulesLayer(deps.db),
    new MemoryLayer(deps.db, memoryOpts),
    new HistoryLayer(deps.db),
    // new CalendarLayer(calendarClient) — deferred (B2): needs CalendarContextAdapter
  ];

  return new ContextBuilder(layers, {
    globalMaxTokens: options.globalMaxTokens,
    layerTimeoutMs: options.layerTimeoutMs,
  });
}
