import type { Pool } from "pg";
import type { Logger } from "pino";

import type { ExecutionMode } from "../integration/execution-payload.schema.js";

/**
 * LLM completion request/response shape used by pipeline agents (DirectEngine pattern).
 * Backed by `LlmClientBridge` in `src/runtime/execution-handler.ts`, which adapts
 * the decorated `LLMGateway` (retry + circuit-breaker + credential pool) to this
 * simpler text-in/text-out interface.
 */
export interface LlmCompletionRequest {
  model: string;
  system: string;
  user: string;
  responseFormat?: { type: "json_object" | "text" };
  maxTokens?: number;
  /** Doutrina/preâmbulo de sistema entregue como system message líder, separado do goal. */
  doctrine?: string;
}

export interface LlmCompletionResponse {
  content: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface LlmClient {
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

/** Per-account configuration available at execution time. */
export interface AccountConfig {
  llmModel?: string;
  llmProvider?: string;
}

/** A single message in the conversation history. */
export interface ConversationMessage {
  direction: "incoming" | "outgoing";
  content: string;
  role?: "user" | "assistant" | "system";
  messageId?: bigint;
  createdAt?: Date;
}

/**
 * Optional Sprint C.2 streaming callback. Reasoning engines that detect a
 * defined callback in their context emit `reasoning_step` /
 * `engine_strategy` events. When `undefined`, engines preserve their
 * pre-streaming behaviour exactly.
 *
 * The callback signature mirrors `StreamCallback` from
 * `src/integration/llm/streaming/types.ts`; we redeclare it here to avoid a
 * cross-package dependency (the streaming module already imports types
 * from `llm-gateway.ts`, which sits between the two).
 */
export type AgentStreamCallback = (event: {
  type: "reasoning_step" | "engine_strategy" | "tool_result";
  payload: unknown;
}) => Promise<void>;

/**
 * Full execution context passed to agents.
 * Superset of the infrastructure ExecutionContext from the runtime layer.
 */
export interface AgentExecutionContext {
  executionId: string;
  organizationId: string;
  contactId?: bigint;
  conversationKey: string;
  messageId?: bigint;

  db: Pool;
  logger: Logger;

  /** LLM client for DirectEngine calls (wraps the decorated LLMGateway via LlmClientBridge). */
  llmClient: LlmClient;

  /** Account-level configuration (model overrides, etc.). */
  accountConfig?: AccountConfig;

  /** Conversation messages available for this execution. */
  messages?: ConversationMessage[];

  /**
   * Sprint C.2 — Optional streaming callback. When defined, reasoning
   * engines emit intermediate events (reasoning_step, engine_strategy).
   * When undefined, engines preserve their pre-streaming behaviour exactly.
   */
  streamCallback?: AgentStreamCallback;

  /** System prompt resolvido (doutrina) — entregue ao engine separado do goal. Fase 0. */
  systemPrompt?: string;

  /**
   * Modo de autonomia da IA (canon ADR-006 / _shared/ADR-006). 3 modos:
   *
   *   - `manual_assisted` — IA sugere; humano aprova. Mutações retornam proposal.
   *   - `copilot` — IA estrutura conhecimento; mutações retornam proposal.
   *   - `autonomous_supervised` — IA executa dentro de regras; escala exceções.
   *
   * C8 (auditoria 2026-06-02) — campo parseado do payload do worker BullMQ
   * e propagado para o agente + tool execution context. Tools de mutação
   * que herdem de `MutationTool` (futuro C9) consomem este campo via
   * `ToolContext.executionMode` para escolher executar-direto vs propor.
   *
   * Default conservador para retrocompat: `autonomous_supervised` (V0
   * behavior — sempre executa). Backend envia o campo obrigatório, então
   * o default só ativa em testes / tools antigas / payloads não-canon.
   */
  executionMode?: ExecutionMode;

  /**
   * Idempotency lineage root (canon APPROVED — bevox-knowledge #62
   * harness-proposal + #63 backend-edits). OPTIONAL: when a staff replay is
   * dispatched, the backend sends a NEW `executionId` but the SAME
   * `originalExecutionId` (the ROOT of the replay lineage — the backend chains
   * every replay to the root). Threaded from `payload.original_execution_id`
   * through the `wrapMutationTool` bridge into `ToolContext.original_execution_id`,
   * where `MutationTool.deriveIdempotencyKey` uses it (falling back to
   * `executionId` when absent) as the execution_id component of the
   * idempotency-key hash. Effect: a replay derives the SAME key as the original
   * execution → backend dedups → NO duplicate appointment mutation. ABSENT
   * (default) → byte-identical to today's key derivation.
   */
  originalExecutionId?: string;

  /**
   * a-reasoning-01 — Notas de reflexão acumuladas pelo ReflexionWrapper. Em
   * cada retry de falha o wrapper anexa o `learnedContext` derivado pela
   * micro-call de `_evaluateFailure`. Engines que suportam reflexão (hoje só
   * `ReactEngine`) prependem estas notas à doctrine do prompt do retry, para
   * que a 2ª tentativa de fato se beneficie do insight. ABSENT (default) /
   * vazio → comportamento byte-idêntico ao 1º attempt. Engines que não leem o
   * campo (rewoo/plan-execute/direct hoje) o ignoram — follow-up.
   *
   * NB privacidade (harness-llm.md): as notas são derivadas de LLM sobre
   * mensagens de erro/saída de tool; ficam dentro da mesma postura de
   * redaction — nunca logar a doctrine montada.
   */
  reflexionNotes?: string[];

  /**
   * C13 — acumulador per-execução de tokens reais reportados pelo
   * `LLMGateway.complete()`. Mutável por referência: o `UsageDecorator`
   * (injetado em `createLLMGateway`) incrementa cada vez que o LLM
   * responde. O handler lê os valores acumulados ao construir o
   * `/complete` final (substitui o `totalTokens = 0` hardcoded de antes).
   *
   * Opcional para não quebrar callers de teste que não acumulam métricas.
   */
  usageAccumulator?: { promptTokens: number; completionTokens: number };

  /**
   * J8 — deadline absoluto de wall-clock (epoch ms). Derivado de
   * `devStartTs + maxExecutionTimeMs` no handler. A GARANTIA de wall-clock vem
   * do wrapper `runWithTimeout(surfaceLoop, maxExecutionTimeMs/2)` (estoura →
   * `phase_timeout` → desfecho terminal `aborted_timeout`); o antigo gate
   * cooperativo `Date.now() >= deadlineMs` no topo de cada step era
   * inalcançável e foi removido. Este campo agora só dimensiona o budget
   * RESTANTE do `synthesize` (`remainingMs = deadlineMs - Date.now()`).
   * Opcional: callers de teste que não o setam preservam o comportamento.
   */
  deadlineMs?: number;

  /**
   * J9 — teto de custo em centavos USD (resolvido de `payload.max_cost_usd`
   * OU `env.HARNESS_MAX_COST_USD`). Quando definido, o loop aborta assim que
   * `costAccumulator.costCents` o cruzar. `undefined` = sem teto (legacy).
   */
  costCeilingCents?: number;

  /**
   * J9 — acumulador per-execução de custo corrente (centavos USD). Mutável
   * por referência, espelha `usageAccumulator`: o `onUsage` callback soma via
   * `calculateCostCents` usando o `meta` model/provider. Lido no loop e no
   * span/log de telemetria.
   */
  costAccumulator?: { costCents: number };
}
