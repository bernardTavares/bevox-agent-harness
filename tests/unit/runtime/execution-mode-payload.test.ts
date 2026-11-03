/**
 * C8 (auditoria 2026-06-02) — execution_mode parsing + propagação.
 *
 * Antes deste fix, `executionPayloadSchema` usava .passthrough() e não
 * declarava `execution_mode`, então o backend mandava o campo
 * obrigatoriamente e o handler silenciosamente engolia (grep no src/ =
 * 0 leituras). Agora o campo é declarado, parseado, e propagado para
 * `AgentExecutionContext.executionMode`. ToolContext (do MutationTool)
 * carrega `execution_mode` simétrico — C9 usa esse campo para escolher
 * executar-direto vs propor; até lá o efeito é puramente observabilidade.
 *
 * Estes testes batem só no schema + tipo de propagação, sem startar
 * pipeline real (que precisaria de fakes pesadas).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { ExecutionModeSchema } from "../../../src/integration/execution-payload.schema.js";

// Reconstruct o schema (private — espelhamos para teste). Idêntico ao
// `executionPayloadSchema` em src/runtime/execution-handler.ts.
const messageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string().max(8000),
  })
  .passthrough();

const testSchema = z
  .object({
    execution_id: z.string().uuid(),
    execution_token: z.string().min(20).max(512),
    organization_id: z.string().uuid(),
    messages: z.array(messageSchema).optional().default([]),
    execution_mode: ExecutionModeSchema.optional().default("autonomous_supervised"),
  })
  .passthrough();

describe("execution_mode parsing (C8)", () => {
  const validBase = {
    execution_id: "11111111-1111-4111-8111-111111111111",
    execution_token: "x".repeat(40),
    organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  };

  it("aceita os 3 modos canônicos do ADR-006", () => {
    for (const mode of ["manual_assisted", "copilot", "autonomous_supervised"] as const) {
      const r = testSchema.safeParse({ ...validBase, execution_mode: mode });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.execution_mode).toBe(mode);
    }
  });

  it("default = 'autonomous_supervised' para retrocompat quando campo ausente", () => {
    const r = testSchema.safeParse(validBase);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.execution_mode).toBe("autonomous_supervised");
  });

  it("rejeita modo desconhecido (não-canon)", () => {
    const r = testSchema.safeParse({ ...validBase, execution_mode: "rogue_yolo" });
    expect(r.success).toBe(false);
  });

  it("rejeita tipo errado (number, null)", () => {
    expect(testSchema.safeParse({ ...validBase, execution_mode: 1 }).success).toBe(false);
    expect(testSchema.safeParse({ ...validBase, execution_mode: null }).success).toBe(false);
  });
});

describe("ExecutionMode type espelha ADR-006 (3 modos exatos)", () => {
  it("enum tem exatamente 3 values (sem rogue 'auto', 'co-pilot', etc.)", () => {
    const values = ExecutionModeSchema.options as readonly string[];
    expect(new Set(values)).toEqual(
      new Set(["manual_assisted", "copilot", "autonomous_supervised"]),
    );
    expect(values.length).toBe(3);
  });
});
