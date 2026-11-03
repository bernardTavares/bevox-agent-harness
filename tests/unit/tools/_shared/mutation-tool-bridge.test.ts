/**
 * EM-03 POC (issue #44) — `wrapMutationTool` + `extractProposal`.
 *
 * O bridge converte uma `MutationTool` em `ToolDefinition` que respeita
 * `executionMode` do `AgentExecutionContext`. `extractProposal` é o
 * inverso: lê o `ToolResult` produzido pelo bridge e devolve o proposal
 * para o acumulador per-execução (consumido pelo execution-handler em
 * `/complete.proposals[]`).
 *
 * Testa o pattern fim-a-fim:
 *   - Bridge sem fetch (proposal path) em manual_assisted/copilot.
 *   - Bridge com fetch (real path) em autonomous_supervised.
 *   - Default conservador quando `executionMode` é undefined.
 *   - `extractProposal` discrimina shapes (proposal-bearing vs vazio vs
 *     failure).
 */

import { describe, it, expect } from "vitest";

import type { AgentExecutionContext } from "../../../../src/agents/execution-context.js";
import {
  MutationTool,
  MutationPreconditionError,
  extractProposal,
  wrapMutationTool,
  type ToolContext,
} from "../../../../src/tools/_shared/mutation-tool.js";
import type { ToolResult } from "../../../../src/tools/types.js";

interface FakeParams {
  x: string;
}
interface FakeResult {
  echoed: string;
}

class FakeMutation extends MutationTool<FakeParams, FakeResult> {
  readonly name = "fake-mutation";
  readonly action = "fake-mutation";
  public executeCalls = 0;
  async execute(params: FakeParams, _context: ToolContext): Promise<FakeResult> {
    this.executeCalls += 1;
    return { echoed: params.x };
  }
}

/**
 * Stub de AgentExecutionContext apenas com os campos consumidos pelo
 * bridge. As demais propriedades (db, llmClient, logger) são forçadas
 * via cast — o bridge NÃO toca nelas.
 */
function makeAgentCtx(mode?: AgentExecutionContext["executionMode"]): AgentExecutionContext {
  return {
    executionId: "exec-bridge-1",
    organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
    conversationKey: "conv-1",
    executionMode: mode,
  } as unknown as AgentExecutionContext;
}

describe("wrapMutationTool (EM-03 bridge)", () => {
  const params: FakeParams = { x: "hello" };
  const meta = {
    description: "fake",
    category: "calendar" as const,
    agentType: "surface" as const,
    parameters: { type: "object" },
  };

  it("manual_assisted → ToolResult contém data.proposal e mutation.execute() NÃO é chamado", async () => {
    const mutation = new FakeMutation();
    const tool = wrapMutationTool(mutation, meta);
    const ctx = makeAgentCtx("manual_assisted");

    const result = await tool.execute(params, ctx);

    expect(result.success).toBe(true);
    expect(mutation.executeCalls).toBe(0);

    const proposal = extractProposal(result);
    expect(proposal).toBeDefined();
    expect(proposal?.action).toBe("fake-mutation");
    expect(proposal?.params).toEqual(params);
  });

  it("copilot → idem manual_assisted (sem side-effect)", async () => {
    const mutation = new FakeMutation();
    const tool = wrapMutationTool(mutation, meta);
    const ctx = makeAgentCtx("copilot");

    const result = await tool.execute(params, ctx);

    expect(result.success).toBe(true);
    expect(mutation.executeCalls).toBe(0);
    expect(extractProposal(result)?.action).toBe("fake-mutation");
  });

  it("autonomous_supervised → executa real e data NÃO tem proposal", async () => {
    const mutation = new FakeMutation();
    const tool = wrapMutationTool(mutation, meta);
    const ctx = makeAgentCtx("autonomous_supervised");

    const result = await tool.execute(params, ctx);

    expect(result.success).toBe(true);
    expect(mutation.executeCalls).toBe(1);
    expect(result.data).toEqual({ echoed: "hello" });
    expect(extractProposal(result)).toBeUndefined();
  });

  it("executionMode undefined → default conservador autonomous_supervised", async () => {
    const mutation = new FakeMutation();
    const tool = wrapMutationTool(mutation, meta);
    const ctx = makeAgentCtx(undefined);

    const result = await tool.execute(params, ctx);

    expect(result.success).toBe(true);
    expect(mutation.executeCalls).toBe(1);
    expect(extractProposal(result)).toBeUndefined();
  });

  it("mutation.execute() lança → bridge devolve {success:false, error, detail}", async () => {
    class FailingMutation extends MutationTool<FakeParams, FakeResult> {
      readonly name = "failing";
      readonly action = "failing";
      async execute(): Promise<FakeResult> {
        throw new Error("calendar 503");
      }
    }
    const tool = wrapMutationTool(new FailingMutation(), { ...meta });
    const result = await tool.execute(params, makeAgentCtx("autonomous_supervised"));

    expect(result.success).toBe(false);
    expect(result.error).toBe("E_TOOL_BACKEND_5XX");
    expect(result.detail).toContain("calendar 503");
  });

  it("propaga organization_id + execution_id de AgentExecutionContext para ToolContext", async () => {
    let captured: ToolContext | undefined;
    class SpyMutation extends MutationTool<FakeParams, FakeResult> {
      readonly name = "spy";
      readonly action = "spy";
      async execute(_p: FakeParams, ctx: ToolContext): Promise<FakeResult> {
        captured = ctx;
        return { echoed: "ok" };
      }
    }
    const tool = wrapMutationTool(new SpyMutation(), { ...meta });
    await tool.execute(params, makeAgentCtx("autonomous_supervised"));

    expect(captured).toBeDefined();
    expect(captured?.execution_id).toBe("exec-bridge-1");
    expect(captured?.organization_id).toBe("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
    expect(captured?.execution_mode).toBe("autonomous_supervised");
  });

  // Idempotency lineage (canon APPROVED — bevox-knowledge #62 + #63):
  // the bridge must thread AgentExecutionContext.originalExecutionId into
  // ToolContext.original_execution_id so MutationTool.deriveIdempotencyKey
  // can dedup staff replays.
  it("threads originalExecutionId de AgentExecutionContext para ToolContext.original_execution_id", async () => {
    let captured: ToolContext | undefined;
    class SpyMutation extends MutationTool<FakeParams, FakeResult> {
      readonly name = "spy-lineage";
      readonly action = "spy-lineage";
      async execute(_p: FakeParams, ctx: ToolContext): Promise<FakeResult> {
        captured = ctx;
        return { echoed: "ok" };
      }
    }
    const ROOT = "018f3a2b-7c4d-7e1f-9a2b-000000000root";
    const replayCtx = {
      executionId: "018f3a2b-7c4d-7e1f-9a2b-0000000replay",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      conversationKey: "conv-1",
      executionMode: "autonomous_supervised" as const,
      originalExecutionId: ROOT,
    } as unknown as AgentExecutionContext;

    const tool = wrapMutationTool(new SpyMutation(), { ...meta });
    await tool.execute(params, replayCtx);

    expect(captured).toBeDefined();
    expect(captured?.execution_id).toBe("018f3a2b-7c4d-7e1f-9a2b-0000000replay");
    expect(captured?.original_execution_id).toBe(ROOT);
  });

  it("originalExecutionId ausente → ToolContext.original_execution_id undefined (fallback to execution_id)", async () => {
    let captured: ToolContext | undefined;
    class SpyMutation extends MutationTool<FakeParams, FakeResult> {
      readonly name = "spy-no-lineage";
      readonly action = "spy-no-lineage";
      async execute(_p: FakeParams, ctx: ToolContext): Promise<FakeResult> {
        captured = ctx;
        return { echoed: "ok" };
      }
    }
    const tool = wrapMutationTool(new SpyMutation(), { ...meta });
    // makeAgentCtx never sets originalExecutionId.
    await tool.execute(params, makeAgentCtx("autonomous_supervised"));

    expect(captured).toBeDefined();
    expect(captured?.original_execution_id).toBeUndefined();
    expect(captured?.execution_id).toBe("exec-bridge-1");
  });

  it("bridge-threaded replay derives the SAME idempotency key as the original execution", async () => {
    let originalKey: string | undefined;
    let replayKey: string | undefined;
    class KeyEmittingMutation extends MutationTool<FakeParams, FakeResult> {
      readonly name = "key-emitter";
      readonly action = "key-emitter";
      // exposes the protected derivation for assertion
      keyFor(ctx: ToolContext, params: unknown): string {
        return this.deriveIdempotencyKey(ctx, params);
      }
      async execute(p: FakeParams, ctx: ToolContext): Promise<FakeResult> {
        // capture the key derived under the bridge-built ToolContext
        const k = this.keyFor(ctx, p);
        if (ctx.original_execution_id) {
          replayKey = k;
        } else {
          originalKey = k;
        }
        return { echoed: "ok" };
      }
    }
    const ROOT = "018f3a2b-7c4d-7e1f-9a2b-000000000root";
    const sameParams: FakeParams = { x: "appt-payload" };

    // Original execution: execution_id IS the root, no lineage field set.
    const originalAgentCtx = {
      executionId: ROOT,
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      conversationKey: "conv-1",
      executionMode: "autonomous_supervised" as const,
    } as unknown as AgentExecutionContext;

    // Staff replay: NEW execution_id, SAME original_execution_id (the root).
    const replayAgentCtx = {
      executionId: "018f3a2b-7c4d-7e1f-9a2b-0000000replay",
      organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      conversationKey: "conv-1",
      executionMode: "autonomous_supervised" as const,
      originalExecutionId: ROOT,
    } as unknown as AgentExecutionContext;

    const tool = wrapMutationTool(new KeyEmittingMutation(), { ...meta });
    await tool.execute(sameParams, originalAgentCtx);
    await tool.execute(sameParams, replayAgentCtx);

    expect(originalKey).toBeDefined();
    expect(replayKey).toBeDefined();
    expect(replayKey).toBe(originalKey);
  });
});

describe("extractProposal (EM-03 hoist helper)", () => {
  it("retorna undefined para result convencional (sem data.proposal)", () => {
    const result: ToolResult = { success: true, data: { regular: "payload" } };
    expect(extractProposal(result)).toBeUndefined();
  });

  it("retorna undefined para failure", () => {
    const result: ToolResult = { success: false, error: "OOPS" };
    expect(extractProposal(result)).toBeUndefined();
  });

  it("retorna undefined para data null/primitive", () => {
    expect(extractProposal({ success: true, data: null })).toBeUndefined();
    expect(extractProposal({ success: true, data: "string-payload" })).toBeUndefined();
    expect(extractProposal({ success: true, data: 42 })).toBeUndefined();
  });

  it("retorna undefined quando data.proposal não tem action string", () => {
    const result: ToolResult = {
      success: true,
      data: { proposal: { params: { x: 1 } } }, // sem action
    };
    expect(extractProposal(result)).toBeUndefined();
  });

  it("extrai proposal canônico {action, params}", () => {
    const result: ToolResult = {
      success: true,
      data: { proposal: { action: "create-appointment", params: { x: 1 } } },
    };
    const out = extractProposal(result);
    expect(out).toEqual({ action: "create-appointment", params: { x: 1 } });
  });
});

describe("executeOrPropose honors MutationPreconditionError.code (§4.2.b)", () => {
  interface PParams {
    ok: boolean;
  }
  class TypedErrorMutation extends MutationTool<PParams, { done: true }> {
    readonly name = "typed-error";
    readonly action = "typed-error";
    async execute(params: PParams): Promise<{ done: true }> {
      if (!params.ok) {
        throw new MutationPreconditionError("INVALID_PARAMS", "ok is required");
      }
      return { done: true };
    }
  }

  it("preserves the typed code in autonomous mode (not E_TOOL_BACKEND_5XX)", async () => {
    const m = new TypedErrorMutation();
    const ctx: ToolContext = { execution_id: "e1", organization_id: "o1" };
    const outcome = await m.executeOrPropose({ ok: false }, ctx, "autonomous_supervised");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INVALID_PARAMS");
      expect(outcome.error.message).toBe("ok is required");
    }
  });

  it("generic (non-typed) errors still collapse to E_TOOL_BACKEND_5XX", async () => {
    class GenericFail extends MutationTool<PParams, { done: true }> {
      readonly name = "generic-fail";
      readonly action = "generic-fail";
      async execute(): Promise<{ done: true }> {
        throw new Error("network 503");
      }
    }
    const ctx: ToolContext = { execution_id: "e1", organization_id: "o1" };
    const outcome = await new GenericFail().executeOrPropose(
      { ok: true },
      ctx,
      "autonomous_supervised",
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("E_TOOL_BACKEND_5XX");
      expect(outcome.error.message).toContain("503");
    }
  });
});
