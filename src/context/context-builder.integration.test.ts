import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ContextBuilder } from "./context-builder.js";
import { BaseConfigLayer } from "./layers/base-config.layer.js";
import { CalendarLayer } from "./layers/calendar.layer.js";
import { HistoryLayer } from "./layers/history.layer.js";
import { MemoryLayer } from "./layers/memory.layer.js";
import { RulesLayer } from "./layers/rules.layer.js";
import type { ContextInput } from "./types.js";

const input: ContextInput = {
  executionId: "exec-integration",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 42n,
  conversationKey: "conv-xyz",
  agentConfig: { systemPrompt: "Voce e um assistente de agendamento.", maxContextTokens: 4000 },
  dispatchPayload: {},
};

describe("ContextBuilder integration", () => {
  it("assembles a system prompt from all 5 layers in priority order", async () => {
    const mockDb = {
      query: vi
        .fn()
        // RulesLayer
        .mockResolvedValueOnce({
          rows: [{ id: 1, description: "Encaminhar para humano se solicitado." }],
        })
        // MemoryLayer — profile query
        .mockResolvedValueOnce({
          rows: [
            {
              full_name: "Maria Silva",
              preferred_name: "Maria",
              phone: "11999991234",
              email: null,
              address: null,
              city: "SP",
              state: "SP",
              preferred_language: "pt-BR",
              last_interaction_at: new Date("2026-04-01"),
              total_interactions: 3,
            },
          ],
        })
        // MemoryLayer — facts query
        .mockResolvedValueOnce({
          rows: [
            {
              fact_key: "preferencia",
              fact_value: "Tarde",
              category: "preferencia",
              confidence: "0.900",
              confirmed: true,
            },
          ],
        })
        // HistoryLayer
        .mockResolvedValueOnce({
          rows: [{ role: "Cliente", content: "Ola!", created_at: new Date() }],
        }),
    };
    const mockCalendar = {
      getCalendarContext: vi.fn().mockResolvedValue({
        services: [{ id: "s1", name: "Consulta", duration_minutes: 30, active: true }],
        members: [{ id: "m1", name: "Dr. Joao", active: true }],
        availabilityToday: [
          { member_id: "m1", member_name: "Dr. Joao", available_slots: ["10:00", "11:00"] },
        ],
      }),
    };

    const builder = new ContextBuilder([
      new BaseConfigLayer(),
      new RulesLayer(mockDb as never),
      new CalendarLayer(mockCalendar),
      new MemoryLayer(mockDb as never),
      new HistoryLayer(mockDb as never),
    ]);

    const result = await builder.build(input);

    expect(result.layersUsed).toHaveLength(5);
    expect(result.systemPrompt).toContain("Voce e um assistente de agendamento.");
    expect(result.systemPrompt).toContain("Encaminhar para humano se solicitado.");
    expect(result.systemPrompt).toContain("Consulta");
    expect(result.systemPrompt).toContain("Maria Silva");
    expect(result.systemPrompt).toContain("Ola!");
    // Sections appear in priority order
    const baseIdx = result.systemPrompt.indexOf("Configuracao base");
    const rulesIdx = result.systemPrompt.indexOf("Regras de encaminhamento");
    const calendarIdx = result.systemPrompt.indexOf("Agenda");
    const memoryIdx = result.systemPrompt.indexOf("Informacoes do contato");
    const historyIdx = result.systemPrompt.indexOf("Historico da conversa");
    expect(baseIdx).toBeLessThan(rulesIdx);
    expect(rulesIdx).toBeLessThan(calendarIdx);
    expect(calendarIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(historyIdx);
  });
});

import { MemoryLayer as MemoryLayerForGuard } from "./layers/memory.layer.js";

describe("MemoryLayer contactId guard (M7)", () => {
  it("returns an empty block when contactId is undefined (no db query)", async () => {
    const query = vi.fn();
    const layer = new MemoryLayerForGuard({ query } as never);
    const block = await layer.build({
      executionId: "e1",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: undefined,
      conversationKey: "c1",
      agentConfig: { systemPrompt: "" },
      dispatchPayload: {},
    });
    expect(block.section).toBe("## Informacoes do contato");
    expect(block.content).toBe("");
    expect(block.tokenEstimate).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

import { createContextBuilder } from "./builder-factory.js";
import { foldContext } from "../runtime/context-wiring.js";
import { resetMemoryRegistryForTests } from "../memory/registry.js";

describe("ContextBuilder runtime (4 layers via factory)", () => {
  beforeEach(() => resetMemoryRegistryForTests());
  afterEach(() => resetMemoryRegistryForTests());

  it("assembles base+rules+memory+history (Calendar deferred) with real headings", async () => {
    const mockDb = {
      query: vi
        .fn()
        // RulesLayer
        .mockResolvedValueOnce({ rows: [{ id: 1, description: "Encaminhar se solicitado." }] })
        // MemoryLayer — profile
        .mockResolvedValueOnce({
          rows: [
            {
              full_name: "Maria Silva",
              preferred_name: null,
              phone: null,
              email: null,
              address: null,
              city: null,
              state: null,
              preferred_language: null,
              last_interaction_at: null,
              total_interactions: 1,
            },
          ],
        })
        // MemoryLayer — facts
        .mockResolvedValueOnce({ rows: [] })
        // HistoryLayer
        .mockResolvedValueOnce({ rows: [{ role: "Cliente", content: "Ola!", created_at: new Date() }] }),
    };

    const builder = createContextBuilder({ db: mockDb as never }, { layerTimeoutMs: 5000 });
    const built = await builder.build({
      executionId: "exec-rt",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 42n,
      conversationKey: "conv-rt",
      agentConfig: { systemPrompt: "Voce e um assistente." },
      dispatchPayload: {},
    });

    expect(built.layersUsed).toEqual([
      "## Configuracao base",
      "## Regras de encaminhamento",
      "## Informacoes do contato",
      "## Historico da conversa",
    ]);
    expect(built.layersFailed).toEqual([]);

    const folded = foldContext(built, "DOCTRINE_TAIL");
    // base appears exactly once (B5)
    expect((folded.match(/## Configuracao base/g) ?? [])).toHaveLength(1);
    // user base content present once
    expect((folded.match(/Voce e um assistente\./g) ?? [])).toHaveLength(1);
    // order: head (base, rules) before doctrine before tail (memory, history)
    expect(folded.indexOf("## Configuracao base")).toBeLessThan(
      folded.indexOf("## Regras de encaminhamento"),
    );
    expect(folded.indexOf("## Regras de encaminhamento")).toBeLessThan(folded.indexOf("DOCTRINE_TAIL"));
    expect(folded.indexOf("DOCTRINE_TAIL")).toBeLessThan(folded.indexOf("## Informacoes do contato"));
    expect(folded.indexOf("## Informacoes do contato")).toBeLessThan(
      folded.indexOf("## Historico da conversa"),
    );
  });

  it("fails open: MemoryLayer DB error completes the build and records memory in layersFailed", async () => {
    const mockDb = {
      query: vi
        .fn()
        // RulesLayer — ok
        .mockResolvedValueOnce({ rows: [{ id: 1, description: "R" }] })
        // MemoryLayer — profile query rejects
        .mockRejectedValueOnce(new Error("relation contact_profiles does not exist"))
        // MemoryLayer — facts query (Promise.all sibling) — also rejects
        .mockRejectedValueOnce(new Error("relation contact_facts does not exist"))
        // HistoryLayer — ok
        .mockResolvedValueOnce({ rows: [{ role: "Cliente", content: "Oi", created_at: new Date() }] }),
    };

    const builder = createContextBuilder({ db: mockDb as never }, { layerTimeoutMs: 5000 });
    const built = await builder.build({
      executionId: "exec-fo",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 7n,
      conversationKey: "conv-fo",
      agentConfig: { systemPrompt: "Base" },
      dispatchPayload: {},
    });

    expect(built.layersFailed).toContain("memory");
    // other layers still present
    expect(built.layersUsed).toContain("## Regras de encaminhamento");
    expect(built.layersUsed).toContain("## Historico da conversa");
    // memory block is present but empty
    const memBlock = built.blocks.find((b) => b.section === "## Informacoes do contato");
    expect(memBlock?.content).toBe("");
  });

  it("budget enforcement keeps Base/Rules intact and trims history tail", async () => {
    const { foldContext: fold } = await import("../runtime/context-wiring.js");
    const { enforceBudget } = await import("./budget-enforcer.js");

    const longHistory = Array.from({ length: 300 }, (_, i) => ({
      role: "Cliente",
      content: `mensagem numero ${i} com bastante texto para encher`,
      created_at: new Date(),
    }));
    const mockDb = {
      query: vi
        .fn()
        // Rules
        .mockResolvedValueOnce({ rows: [{ id: 1, description: "REGRA_CRITICA" }] })
        // Memory profile
        .mockResolvedValueOnce({ rows: [] })
        // Memory facts
        .mockResolvedValueOnce({ rows: [] })
        // History
        .mockResolvedValueOnce({ rows: longHistory }),
    };

    const builder = createContextBuilder({ db: mockDb as never }, { layerTimeoutMs: 5000 });
    const built = await builder.build({
      executionId: "exec-budget",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      contactId: 1n,
      conversationKey: "conv-budget",
      agentConfig: { systemPrompt: "BASE_PROMPT_CRITICO" },
      dispatchPayload: {},
    });

    const folded = fold(built, "DOUTRINA_CRITICA", { withMarker: true });
    // Budget must clear the live MIN_PROMPT_TOKENS floor (200) for enforceBudget
    // to compress rather than warn-and-passthrough; the folded prompt totals
    // ~3539 tokens (head ~15), so 300 forces tail truncation while keeping head.
    const enforced = enforceBudget({ systemPrompt: folded, tools: [], maxContextTokens: 300 });

    expect(enforced.wasCompressed).toBe(true);
    expect(enforced.systemPrompt).toContain("BASE_PROMPT_CRITICO");
    expect(enforced.systemPrompt).toContain("REGRA_CRITICA");
    expect(enforced.systemPrompt).toContain("DOUTRINA_CRITICA");
    expect(enforced.systemPrompt).not.toContain("mensagem numero 299");
  });
});
