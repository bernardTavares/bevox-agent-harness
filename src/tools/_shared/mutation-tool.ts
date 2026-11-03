// src/tools/_shared/mutation-tool.ts
//
// Base class para tools de mutação do harness. Implementa ADR-006 — toda
// mutação tem dois caminhos:
//   - autonomous_supervised → executa de fato (efeito colateral real)
//   - manual_assisted | copilot → retorna proposal sem efeito (vira AISuggestion)
//
// Wave 7 — Gap G1 do esqueleto Claude Code.

import { createHash } from "node:crypto";

import type { AgentExecutionContext } from "../../agents/execution-context.js";
import type { ExecutionMode } from "../../integration/execution-payload.schema.js";
import type { ToolDefinition, ToolResult as ToolDefResult } from "../types.js";

export interface ToolResult<T = unknown> {
  ok: true;
  result: T;
}

export interface ToolProposal<P = unknown> {
  ok: true;
  proposal: {
    action: string;
    params: P;
  };
}

export interface ToolFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ToolOutcome<Result, Params> = ToolResult<Result> | ToolProposal<Params> | ToolFailure;

export interface ToolContext {
  execution_id: string;
  organization_id: string;
  /**
   * Raiz da linhagem de replay (canon APROVADO — bevox-knowledge #62
   * harness-proposal + #63 backend-edits). OPCIONAL: um replay de staff
   * chega com um `execution_id` NOVO mas o MESMO `original_execution_id`
   * (a RAIZ da linhagem — o backend encadeia todo replay à raiz). Quando
   * presente, `deriveIdempotencyKey` o usa (em vez de `execution_id`) como
   * o componente execution_id do hash, de modo que o replay deriva a MESMA
   * chave da execução original → backend dedup → SEM mutação duplicada de
   * agendamento. AUSENTE (default) → byte-idêntico a hoje (usa
   * `execution_id`). Propagado pelo bridge `wrapMutationTool` a partir de
   * `AgentExecutionContext.originalExecutionId`.
   */
  original_execution_id?: string;
  /** Opcional: ID do round na execução, usado em idempotency-key (ADR-023). */
  step_index?: number;
  /**
   * Modo de autonomia da IA (canon ADR-006). Propagado do payload BullMQ
   * pelo handler de execução através de `AgentExecutionContext.executionMode`.
   * Tools de mutação que herdam de `MutationTool` consomem este campo via
   * `executeOrPropose()` para escolher executar-direto vs propor.
   * Default conservador no handler: `autonomous_supervised`.
   */
  execution_mode?: ExecutionMode;
}

/**
 * Erro estruturado que `executeOrPropose` captura e converte em
 * `{ ok: false, error: { code, message } }`, preservando o `code` tipado
 * (ex: INVALID_PARAMS, RATE_LIMITED) em vez de colapsar para
 * `E_TOOL_BACKEND_5XX`. Subclasses de `MutationTool` lançam isto em
 * pré-condições (validação de params, rate-limit). Movida para cá do
 * `create-appointment.mutation.ts` (§4.2.a) para reuso pelas 4 mutation
 * tools migradas.
 */
export class MutationPreconditionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MutationPreconditionError";
  }
}

/**
 * Canonicalização determinística (chaves ordenadas recursivamente) para
 * `canonical(params)` do ADR-015. Mesmo shape de params → mesma string,
 * independente da ordem de inserção. Segue o precedente de
 * `src/integration/llm/request-hasher.ts:22`.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

/**
 * Base para tools de mutação. Subclasses implementam apenas `execute()`;
 * o duplo caminho (executar vs propor) fica em `executeOrPropose()`.
 *
 * Conforme ADR-006:
 *   - Em modo `autonomous_supervised` → invoca `execute()` real.
 *   - Em modo `manual_assisted` ou `copilot` → retorna proposal SEM efeito.
 */
export abstract class MutationTool<Params, Result> {
  /** Nome canônico da tool (ex: `create-appointment`). */
  abstract readonly name: string;

  /** Ação registrada na proposal (geralmente igual a `name`). */
  abstract readonly action: string;

  /**
   * Execução real (com efeito colateral). Subclasses implementam.
   * Chamada apenas em `autonomous_supervised`.
   */
  abstract execute(params: Params, context: ToolContext): Promise<Result>;

  /**
   * Despacha conforme modo. Em draft (manual_assisted/copilot), nunca chama `execute()`.
   */
  async executeOrPropose(
    params: Params,
    context: ToolContext,
    mode: ExecutionMode,
  ): Promise<ToolOutcome<Result, Params>> {
    if (mode === "autonomous_supervised") {
      try {
        const result = await this.execute(params, context);
        return { ok: true, result };
      } catch (err) {
        // Honra códigos tipados de pré-condição (INVALID_PARAMS,
        // RATE_LIMITED) — sem isto o catch colapsava tudo em
        // E_TOOL_BACKEND_5XX, matando os códigos legados (§4.2.b).
        const code = err instanceof MutationPreconditionError ? err.code : "E_TOOL_BACKEND_5XX";
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: {
            code,
            message,
          },
        };
      }
    }
    // manual_assisted ou copilot — retorna proposal sem efeito (ADR-006 + ADR-007)
    return {
      ok: true,
      proposal: {
        action: this.action,
        params,
      },
    };
  }

  /**
   * Deriva idempotency-key conforme ADR-023.
   * Sub-classes podem sobrescrever se precisarem de chave específica de domínio.
   * Implementação default delega ao helper estático para permitir reuso
   * fora da hierarquia MutationTool (ex: `sendComplete` no handler).
   */
  protected deriveIdempotencyKey(context: ToolContext, params: unknown): string {
    return MutationTool.deriveIdempotencyKey(context, this.name, params);
  }

  /**
   * Chave canônica ADR-015 (bevox-backend/ADR-015, renumerado do hub ADR-023):
   *   sha256(`${lineageId}:${step_index}:${tool_name}:${canonical(params)}`)
   *
   * `lineageId = context.original_execution_id ?? context.execution_id`.
   * Linhagem de replay (canon APROVADO — bevox-knowledge #62 + #63): um
   * replay de staff chega com um `execution_id` NOVO mas o MESMO
   * `original_execution_id` (a RAIZ da linhagem; o backend encadeia todo
   * replay à raiz). Usar a raiz como componente faz o replay derivar a MESMA
   * chave da execução original → backend dedup → SEM mutação duplicada de
   * agendamento. Isto des-bloqueia o replay seguro de mutação de
   * agendamento. AUSENTE → cai para `execution_id` (byte-idêntico a hoje).
   *
   * `step_index` cai para 0 (degenerado): no domínio de mutações de
   * calendário do harness, params idênticos ⇒ duplicata genuína (dedup
   * correto), e params distintos ⇒ chaves distintas. Logo a posição do step
   * não acrescenta distinção e o conteúdo (params) é o discriminador.
   * Determinística e trajectory-independent: a MESMA operação lógica produz
   * a MESMA chave em qualquer retry (BullMQ após-throw, Reflexion in-process)
   * e em qualquer replay encadeado à mesma raiz de linhagem.
   * Saída: 64-char hex — passa o regex opaco do backend.
   */
  static deriveIdempotencyKey(
    context: ToolContext,
    operationName: string,
    params: unknown,
  ): string {
    const lineageId = context.original_execution_id ?? context.execution_id;
    const step = context.step_index ?? 0;
    const raw = `${lineageId}:${step}:${operationName}:${canonicalize(params)}`;
    return createHash("sha256").update(raw).digest("hex");
  }
}

/**
 * EM-03 POC (issue #44) — Bridge: MutationTool → ToolDefinition.
 *
 * Adapta uma instância de `MutationTool` para o contrato `ToolDefinition`
 * usado pelo `ToolRegistry` + executor do `execution-handler`. A ponte:
 *
 *  1. Lê `executionMode` de `AgentExecutionContext` (canon ADR-006,
 *     propagado pelo handler — C8 wired em 2026-06-02).
 *  2. Converte `AgentExecutionContext` em `ToolContext` (`organization_id`,
 *     `execution_id`).
 *  3. Invoca `executeOrPropose(params, ctx, mode)`.
 *  4. Materializa o resultado canônico no shape `ToolDefResult`:
 *     - Sucesso real → `{ success: true, data: <result> }`
 *     - Proposta (manual_assisted / copilot) → `{ success: true,
 *       data: { proposal: { action, params } } }` — sinaliza ao handler
 *       que o efeito NÃO foi aplicado e o objeto deve ser hoisted para
 *       `proposals[]` no `/complete`.
 *     - Falha → `{ success: false, error, detail }`
 *
 * Default conservador: se `executionMode` é `undefined`, trata como
 * `autonomous_supervised` (V0 behavior — sempre executa). Mesmo default
 * já é aplicado no payload schema (`executionPayloadSchema`).
 *
 * POC: apenas `createAppointmentTool` adota o bridge nesta entrega para
 * provar o pattern fim-a-fim. As outras 4 mutation tools
 * (`cancel-appointment`, `reschedule-appointment`, `send-message`,
 * `waitlist-add`) ficam como follow-up (C9 cleanup).
 */
export function wrapMutationTool<P, R>(
  mutation: MutationTool<P, R>,
  meta: {
    description: string;
    category: ToolDefinition["category"];
    agentType: ToolDefinition["agentType"];
    parameters: Record<string, unknown>;
  },
): ToolDefinition {
  return {
    name: mutation.name,
    description: meta.description,
    category: meta.category,
    agentType: meta.agentType,
    parameters: meta.parameters,
    async execute(rawParams: unknown, context: AgentExecutionContext): Promise<ToolDefResult> {
      const params = rawParams as P;
      const mode: ExecutionMode = context.executionMode ?? "autonomous_supervised";
      const toolContext: ToolContext = {
        execution_id: context.executionId,
        organization_id: context.organizationId,
        // Idempotency lineage (canon APROVADO — bevox-knowledge #62 + #63):
        // when present, a staff replay shares this root across its NEW
        // execution_id, so `deriveIdempotencyKey` matches the original key
        // and the backend dedups the mutation. Absent → key falls back to
        // execution_id (byte-identical to today).
        original_execution_id: context.originalExecutionId,
        execution_mode: mode,
      };
      const outcome = await mutation.executeOrPropose(params, toolContext, mode);
      if (outcome.ok === false) {
        return {
          success: false,
          error: outcome.error.code,
          detail: outcome.error.message,
        };
      }
      if ("proposal" in outcome) {
        // Sinal canônico: presença de `data.proposal` indica que o efeito
        // NÃO foi aplicado e o handler deve hoist para `/complete.proposals[]`.
        return {
          success: true,
          data: { proposal: outcome.proposal },
        };
      }
      return { success: true, data: outcome.result };
    },
  };
}

/**
 * Produz APENAS a closure `execute` (AgentExecutionContext → ToolDefResult)
 * de um `MutationTool` — corpo idêntico ao `execute` de `wrapMutationTool`,
 * mas SEM exigir metadata duplicada. O `index.ts` da skill fornece isto como
 * `export default { execute: mutationExecute(<mutation>) }`; description /
 * category / agentType / parameters passam a viver SOMENTE no
 * `manifest.yaml` da skill (SKILLS-05 Phase 0).
 *
 * Comportamento preservado (ADR-006 / EM-03, testado em
 * mutation-proposal.test.ts):
 *   - executionMode `autonomous_supervised` (ou undefined) → efeito real,
 *     retorna `{ success: true, data: <result> }`.
 *   - `manual_assisted` / `copilot` → `{ success: true, data: { proposal } }`
 *     SEM efeito colateral.
 *   - falha → `{ success: false, error: code, detail: message }`.
 *
 * NOTA (SKILLS-05 Task 0.1): o `toolContext` é mantido idêntico ao construído
 * por `wrapMutationTool` — `AgentExecutionContext` não expõe `stepIndex`,
 * então `step_index` é omitido (o `deriveIdempotencyKey` canônico deriva a
 * chave do conteúdo de `params`, com `step` degenerado a 0). Inclui
 * `original_execution_id` (linhagem de replay, canon APROVADO — bevox-knowledge
 * #62 + #63): como `mutationExecute` é agora o caminho de roteamento LIVE de
 * TODAS as mutation tools migradas (SKILLS-05 substituiu os `.tool.ts`), ele
 * DEVE propagar a raiz da linhagem, sob pena de um replay de staff re-derivar
 * uma chave nova e o backend NÃO dedupar a mutação. Ausente → byte-idêntico a
 * hoje (chave usa `execution_id`).
 */
export function mutationExecute<P, R>(
  mutation: MutationTool<P, R>,
): (params: unknown, context: AgentExecutionContext) => Promise<ToolDefResult> {
  return async (rawParams: unknown, context: AgentExecutionContext): Promise<ToolDefResult> => {
    const params = rawParams as P;
    const mode: ExecutionMode = context.executionMode ?? "autonomous_supervised";
    const toolContext: ToolContext = {
      execution_id: context.executionId,
      organization_id: context.organizationId,
      original_execution_id: context.originalExecutionId,
      execution_mode: mode,
    };
    const outcome = await mutation.executeOrPropose(params, toolContext, mode);
    if (outcome.ok === false) {
      return { success: false, error: outcome.error.code, detail: outcome.error.message };
    }
    if ("proposal" in outcome) {
      return { success: true, data: { proposal: outcome.proposal } };
    }
    return { success: true, data: outcome.result };
  };
}

/**
 * EM-03 POC (issue #44) — extrai proposta de um `ToolDefResult` quando
 * presente. Retorna `undefined` para results convencionais (não-proposal).
 *
 * Convenção: o bridge `wrapMutationTool` materializa propostas em
 * `data.proposal: { action, params }`. O handler chama esta função após
 * cada `executeTool` para coletar propostas no acumulador per-execução
 * que é serializado no `/complete` final.
 */
export function extractProposal(
  result: ToolDefResult,
): { action: string; params: unknown } | undefined {
  if (!result.success || result.data === null || typeof result.data !== "object") {
    return undefined;
  }
  const proposal = (result.data as { proposal?: unknown }).proposal;
  if (proposal === null || typeof proposal !== "object") return undefined;
  const p = proposal as { action?: unknown; params?: unknown };
  if (typeof p.action !== "string") return undefined;
  return { action: p.action, params: p.params };
}
