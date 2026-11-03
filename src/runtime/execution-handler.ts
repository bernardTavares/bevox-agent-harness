import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { z } from "zod";
import { UnrecoverableError } from "bullmq";

import type { AgentExecutionContext } from "../agents/execution-context.js";
import type {
  AgentStreamCallback,
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
} from "../agents/execution-context.js";
import { getEnv } from "../config/env.js";
import { ExecutionModeSchema } from "../integration/execution-payload.schema.js";
import { StreamPublisher } from "./stream-publisher.js";
import { AgentRegistry } from "../agents/registry.js";
import type { AgentDefinition } from "../agents/types.js";
import { getHarnessConfig } from "../config/harness-config.js";
import { ExecutionAbortError } from "./errors.js";
import { createLogger } from "../config/logger.js";
import { getDevEventBus, isDevModeEnabled } from "../dev/event-bus.js";
import { updateStatus, sendComplete, buildCompletePayload } from "../integration/bevox-callback.js";
import type { LLMGateway, LLMMessage } from "../integration/llm-gateway.js";
import { filterPermittedTools } from "../permissions/evaluator.js";
import { emitExecutionAudit, sanitizeAuditDetails } from "../security/execution-audit.js";
import type {
  AgentResponse,
  Observation,
  Plan,
  ToolExecutor,
  TraceCallback,
} from "../reasoning/engine.js";
import type { ReasoningEngine } from "../reasoning/engine.js";
import { ReflexionWrapper } from "../reasoning/reflexion.js";
import { PlanExecuteEngine } from "../reasoning/plan-execute.js";
import { ReWOOEngine, CyclicDependencyError } from "../reasoning/rewoo.js";
import type { EscalationConfig } from "../reasoning/step-evaluator.js";
import { stepEvaluator } from "../reasoning/step-evaluator.js";
import { strategyRouter } from "../reasoning/strategy-router.js";

import type { AgentRouter } from "./agent-router.js";
import { createEvalSamplingHook, runPostExecutionHooks } from "./hooks/index.js";

import { buildPermissionContext } from "../permissions/permission-context.js";
import { createLLMGateway } from "../integration/llm-gateway.js";
import { enqueueCondense } from "../integration/condense-queue.js";
import { getCondenseQueue, getMessageIndexer } from "../memory/registry.js";
import { withSpan } from "../observability/spans.js";
import { calculateCostCents } from "../observability/cost-calculator.js";
import { SessionStore } from "../session/session-store.js";
import { UnifiedToolRegistry } from "../tools/unified-registry.js";
import type { ToolDefinition } from "../tools/types.js";
import { extractProposal, MutationTool } from "../tools/_shared/mutation-tool.js";
import { runWorkflow, resumeWorkflow, type RunWorkflowResult } from "../workflow/engine.js";
import { WorkflowRegistry } from "../workflow/registry.js";
import { WorkflowStateStore } from "../workflow/state-store.js";
import { sdrProfileSchema } from "./sdr-profile.schema.js";
import { composeSystemPrompt, type SdrFsmProjection } from "../sdr/compose.js";
import { getSdrAccountState } from "../sdr/sdr-account-state.repository.js";
import { wasReplied, markReplied, REPLIED_MARKER_TTL_SEC } from "../sdr/replied-marker.js";
import { CorrelationStore, type CorrelationRow } from "../workflow/correlation-store.js";
import { resolveQualificationFramework } from "../sdr/tunables.js";
import { enforceBudget } from "../context/budget-enforcer.js";
import { createContextBuilder } from "../context/builder-factory.js";
import { computeCalibrationRatio } from "../context/calibration.js";
import { isUsingFallbackTokenizer } from "../context/tokenizer.js";
import {
  buildContextInput,
  foldContext,
  setContextSpanAttributes,
} from "./context-wiring.js";
import type { BuiltContext } from "../context/types.js";

const config = getHarnessConfig();
const logger = createLogger({ name: "execution-handler", level: config.harness.logLevel });

/**
 * PERM-03 — names of tools that have real side effects (mutations). When the
 * surface-agent executor invokes one of these, a `mutation_execution` row is
 * appended to `permission_audit` capturing parameters (sanitized), the
 * caller, and success/failure.
 *
 * Kept as a closed set in code rather than a tool-level `sideEffects` flag
 * for POC simplicity. Follow-up: move to `ToolDefinition.sideEffects: boolean`
 * so individual tools declare their own status.
 */
const MUTATION_TOOL_NAMES = new Set<string>([
  "create-appointment",
  "cancel-appointment",
  "reschedule-appointment",
  "waitlist-add",
  "send-message",
]);

/**
 * C10 — chave idempotente para o callback `/complete`, discriminada por
 * DESFECHO terminal (não pelo conteúdo do payload, que é volátil entre
 * retries). `params = {}` → estável; só `complete:<kind>` discrimina.
 * Assim um retry do MESMO desfecho deduplica, mas `failed` nunca colide
 * com `success`. Defense-in-depth atrás do Redis dedup + replied-marker.
 */
function completeKey(executionId: string, organizationId: string, kind: string): string {
  return MutationTool.deriveIdempotencyKey(
    { execution_id: executionId, organization_id: organizationId },
    `complete:${kind}`,
    {},
  );
}

// ---------------------------------------------------------------------------
// C.5 — Model-C dispatch seam
//
// Module-level overridable pointer for the Model-C short-circuit path.
// C.7 wires the real implementation (_dispatchModelCImpl) as the default.
//
// `dispatchModelC` receives the resolved correlation row plus the execution
// context required by C.7, and must return the same shape as handleExecution
// (Promise<void>) so the caller can `return await dispatchModelC(...)`.
// ---------------------------------------------------------------------------
export interface DispatchModelCArgs {
  corr: CorrelationRow;
  agentContext: AgentExecutionContext;
  organizationId: string;
  contactKey: string;
  messages: Array<{ role: string; content: string }>;
  /** C.7: execution token needed by dispatchModelC to call sendComplete */
  executionToken: string;
  /**
   * C.7 Fix 1: the raw (pre-doctrine) system prompt from agent_config.system_prompt.
   * Required so _dispatchModelCImpl can call composeSystemPrompt(rawSystemPrompt, profile,
   * null, undefined, fsmProjection) and produce byte-identical output to the previous
   * manual concat without double-injecting the doctrine.
   */
  rawSystemPrompt: string;
  /** C.7 Fix 1: the resolved SDR profile (already validated enabled=true at call site). */
  sdrProfile: import("./sdr-profile.schema.js").SdrProfile;
  /**
   * C.8: Redis client for wasReplied / markReplied split-idempotency marker.
   * Passed from handleExecution so _dispatchModelCImpl does not need to access
   * a global or context singleton.
   */
  redis: Redis;
  /**
   * PERM-05 (auditoria 2026-06-02, runtime-gap §PERM-05): Layer-2
   * account-level denied tools, pre-computed by the caller from
   * `payload.account_denied_tools` (explicit blacklist) ∪
   * complement(toolRegistry, `payload.skills`) (allowlist negation). Passed
   * down so the Model-C short-circuit path enforces the same Layer-2 policy
   * as the main ReAct path. Defaults to `[]` at the destructure site when
   * the caller omits it (transitional shim while callers migrate).
   */
  accountDeniedTools?: string[];
}

// ---------------------------------------------------------------------------
// C.7 — Real Model-C implementation
//
// Flow:
//   1. Load workflow state row by suspend_token (validated via migrateState in store).
//   2. Build a compact FSM projection (account-status + cadence step + allowed
//      next transitions — small, non-compressible, always < 200 chars).
//   3. Recompose agentContext.systemPrompt via composeSystemPrompt with the
//      FSM projection appended (SAME string, NOT a new system message →
//      system-message count stays 2).
//   4. Run the normal doctrine-governed surface loop (runSurfaceAgentLoop).
//   5. AFTER reply confirmed sent (sendComplete), await resumeWorkflow with the
//      inbound message as resume payload BEFORE returning (awaited, not fire-
//      and-forget — C.8 handles split-idempotency residual).
//
// Guard: NEVER double-respond. Reply happens once via surface loop; workflow
// advance is the post-send side-effect.
// ---------------------------------------------------------------------------

/**
 * Build a compact FSM projection from a workflow state row's stepOutputs.
 * Non-throwing — returns a safe default if the row is absent or malformed.
 */
function buildFsmProjection(
  row: {
    currentStep: string | null;
    state: { stepOutputs: Record<string, unknown> };
  } | null,
): SdrFsmProjection {
  if (!row) {
    return {
      accountStatus: "Cold",
      cadenceStep: "unknown",
      allowedTransitions: [
        "positive-reply → Qualified/Nurture:Active",
        "opt-out → Nurture:Dead",
        "soft-no → continue",
      ],
    };
  }

  const stepOutputs = row.state.stepOutputs ?? {};
  const accountStatus = (stepOutputs["account-status"] as string | undefined) ?? "Cold";
  const cadenceStep = row.currentStep ?? "touch-1";

  // Determine allowed next transitions from the current account status
  let allowedTransitions: string[];
  if (accountStatus === "Cold" || accountStatus === "Working") {
    allowedTransitions = [
      "positive-reply → Qualified/Nurture:Active",
      "opt-out → Nurture:Dead",
      "soft-no → continue cadence",
    ];
  } else {
    // Terminal / absorbing state — no further prospect transitions
    allowedTransitions = [`${accountStatus} (terminal — no further transitions)`];
  }

  return { accountStatus, cadenceStep, allowedTransitions };
}

async function _dispatchModelCImpl(args: DispatchModelCArgs): Promise<void> {
  const {
    corr,
    agentContext,
    organizationId,
    contactKey,
    messages,
    executionToken,
    rawSystemPrompt,
    sdrProfile,
    redis,
    accountDeniedTools = [],
  } = args;
  const executionId = agentContext.executionId;
  const envMc = getEnv();

  logger.info(
    { executionId, workflowExecutionId: corr.workflowExecutionId, contactKey: corr.contactKey },
    "Model-C dispatch: loading workflow state for FSM projection",
  );

  // C.8 — Compute the inbound message string early so it can be used for the
  // replied-marker check before we run the surface loop.
  const inboundMessage = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");

  // 1. Load workflow state row to build the FSM projection.
  //    suspendToken from the correlation row is the key.
  const store = new WorkflowStateStore(agentContext.db);
  const wfRow = corr.suspendToken
    ? await store.loadBySuspendToken(corr.suspendToken, organizationId).catch(() => null)
    : null;

  // 2. Build compact FSM projection.
  const fsmProjection = buildFsmProjection(wfRow);

  // 3. Recompose agentContext.systemPrompt with FSM projection appended.
  //    Route through composeSystemPrompt(rawSystemPrompt, sdrProfile, null, undefined,
  //    fsmProjection) so the fsmProjection branch in compose.ts is the single
  //    assembly seam (Fix 1 — C.7 spec review).
  //
  //    We pass rawSystemPrompt (pre-doctrine) rather than agentContext.systemPrompt
  //    (which already contains the doctrine from the 2-arg compose at ~716) to avoid
  //    double-injecting the doctrine. composeSystemPrompt then produces:
  //      rawSystemPrompt + "\n\n" + SDR_DOCTRINE + "\n\n" + FSM_BLOCK
  //    which is byte-identical to the previous manual concat:
  //      agentContext.systemPrompt + "\n\n" + FSM_BLOCK
  //    because agentContext.systemPrompt == rawSystemPrompt + "\n\n" + SDR_DOCTRINE
  //    at this point (correlation probe fires BEFORE the B.8 L3 recompose seam).
  // CTX-01 (issue #39): flag-gated ContextBuilder wiring for Model-C. Build
  // ONCE; fails open to the legacy compose on any error. The doctrine tail
  // carries the FSM projection (base="" — BaseConfigLayer owns base).
  if (envMc.CONTEXT_BUILDER_ENABLED && agentContext.contactId != null) {
    try {
      const contextInput = buildContextInput({
        executionId,
        organizationId,
        contactId: agentContext.contactId,
        conversationKey: agentContext.conversationKey,
        systemPrompt: rawSystemPrompt,
        dispatchPayload: { messages } as unknown as Record<string, unknown>,
        userMessage: inboundMessage,
      });
      const builder = createContextBuilder(
        { db: agentContext.db },
        { layerTimeoutMs: envMc.CONTEXT_BUILDER_LAYER_TIMEOUT_MS },
      );
      const builtContextMc = await builder.build(contextInput);
      const doctrineTail = composeSystemPrompt("", sdrProfile, null, undefined, fsmProjection);
      agentContext.systemPrompt = foldContext(builtContextMc, doctrineTail, { withMarker: true });
    } catch (err) {
      logger.warn(
        { err, executionId },
        "CTX-01 (Model-C): context builder failed; falling back to legacy prompt",
      );
      agentContext.systemPrompt = composeSystemPrompt(
        rawSystemPrompt,
        sdrProfile,
        null,
        undefined,
        fsmProjection,
      );
    }
  } else {
    agentContext.systemPrompt = composeSystemPrompt(
      rawSystemPrompt,
      sdrProfile,
      null,
      undefined,
      fsmProjection,
    );
  }

  logger.debug({ executionId, fsmProjection }, "Model-C: FSM projection appended to system prompt");

  // 4. Resolve surface agent — reuse the default ("scheduler") route.
  //    In the Model-C path we skip the LLM analyzer and go directly to the
  //    surface agent. We build the tool executor and permissions here.
  const agentRegistry = AgentRegistry.getInstance();
  const toolRegistry = UnifiedToolRegistry.getInstance();

  const agentName = agentRegistry.has("scheduler") ? "scheduler" : "request-human";
  if (agentName === "request-human") {
    // Fix 3 (intentional behavior — not a bug): no surface agent available.
    // We send an empty reply and return WITHOUT calling resumeWorkflow, so the
    // cadence remains suspended at its current step. This is the correct
    // fail-safe: no proper reply was produced, so the FSM must NOT advance.
    // The suspend's own timeout (or a future retry from Bevox) will eventually
    // recover the cadence — NOT this execution path.
    //
    // C.8 NOTE: we do NOT call markReplied here — no real reply was produced,
    // so the marker must not be written. If a retry enters the request-human
    // branch again, it will correctly send the same empty reply (harmless) and
    // still not advance the cadence.

    // PERM-03 — audit the escalation BEFORE the callback so a failure of
    // sendComplete still leaves the escalation attempt in `permission_audit`.
    // Fire-and-forget; never blocks the runtime path.
    emitExecutionAudit({
      executionId,
      organizationId,
      agentName: "request-human",
      toolName: "request-human",
      actionType: "escalation",
      actionDetails: {
        escalation_reason: "no_surface_agent_available",
        path: "model_c",
        strategy: "request-human",
      },
      result: "pending_approval",
    });

    await sendComplete(
      executionId,
      executionToken,
      buildCompletePayload({
        responseText: "",
        sentiment: "neutral",
        strategy: "request-human",
      }),
      completeKey(executionId, organizationId, "request-human"),
    );
    return;
  }

  const surfaceAgent = agentRegistry.resolve(agentName);
  const agentDef = surfaceAgent.definition;

  // Model-C path: a entrada já foi gated no correlation probe (sdr_profile.enabled
  // + resolved contactId), mas o registry inteiro continua acessível ao LLM se
  // ele nomear uma tool arbitrária. C7 (auditoria 2026-06-02): defesa em
  // profundidade — aplica o mesmo filtro de permissão por-tool que o ReAct path
  // usa, garantindo que tools fora do escopo do surface agent sejam negadas
  // mesmo se o LLM tentar chamá-las. Sem AgentRouter no Model-C, usa só as
  // 3 camadas estáticas (agent-static, execution-context, account-denied).
  //
  // PERM-05 (auditoria 2026-06-02): `accountDeniedTools` is now propagated
  // from the caller (handleExecution → DispatchModelCArgs), derived from
  // payload.account_denied_tools + complement(toolRegistry, payload.skills).
  // No longer hard-coded to [].
  const permCtx = {
    executionId: agentContext.executionId,
    agentName: agentDef.name,
    agentType: agentDef.type,
    organizationId,
    conversationKey: agentContext.conversationKey,
    unavailableTools: [],
    accountDeniedTools,
  };
  const permittedTools = (await import("../permissions/evaluator.js")).filterPermittedTools(
    toolRegistry.all(),
    agentDef,
    permCtx,
  );
  const permittedNamesMc = new Set(permittedTools.map((t) => t.name));

  // Build user input from the inbound messages
  const userMessages = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  const input = `User request:\n${userMessages}`;

  // §4.6: Model-C precisa do mesmo hoist de propostas que o caminho main.
  // Sem isto, uma mutation tool em draft mode roteada por Model-C perderia
  // sua proposta (nunca chegaria a /complete.proposals[]).
  const mcProposals: Array<{ action: string; params: unknown }> = [];

  // Build executeTool (no devBus instrumentation needed in Model-C path)
  const executeTool: ToolExecutor = async (toolName, params, toolContext) => {
    const tool = toolRegistry.resolve(toolName);
    if (!tool) return { success: false as const, error: `Tool not found: ${toolName}` };
    if (!permittedNamesMc.has(toolName)) {
      logger.warn(
        { executionId: agentContext.executionId, agent: agentDef.name, toolName },
        "C7 runtime permission gate (Model-C): tool denied",
      );
      return {
        success: false as const,
        error: `PERMISSION_DENIED: tool "${toolName}" not in permitted set for agent "${agentDef.name}"`,
      };
    }
    const result = await tool.execute(params, toolContext);
    if (MUTATION_TOOL_NAMES.has(toolName)) {
      const proposal = extractProposal(result);
      if (proposal !== undefined) {
        mcProposals.push(proposal);
        logger.info(
          { executionId: agentContext.executionId, toolName, action: proposal.action },
          "EM-03 (Model-C): proposal captured (draft mode) — emitting in /complete.proposals[]",
        );
      }
    }
    return result;
  };

  // C.8 — Split-idempotency: check whether a reply was already sent for this
  // (account, contact, inbound-message) triple. If yes, skip the surface loop
  // and sendComplete entirely to prevent a double-reply on BullMQ retry.
  //
  // The replied-marker is keyed on (organizationId, contactKey, inboundMessage) so it
  // survives across execution_ids (retries arrive with new execution_ids, but the
  // same inbound content). Fail-open: if Redis is unavailable, wasReplied returns
  // false and we proceed as if it's the first attempt (see replied-marker.ts JSDoc).
  const alreadyReplied = await wasReplied(redis, organizationId, contactKey, inboundMessage);

  let agentResponseAnswer = "";

  if (alreadyReplied) {
    // Retry path: reply already sent. Skip the surface loop and sendComplete.
    // Proceed directly to resumeWorkflow to retry the FSM advance independently.
    logger.info(
      { executionId, organizationId, contactKey },
      "Model-C C.8: reply already sent (replied-marker hit) — skipping surface loop + sendComplete, retrying FSM advance",
    );
  } else {
    // First-attempt path: run the surface loop and send the reply.

    // CTX-01/CTX-02 (Model-C, B4): enforce the token budget before reasoning,
    // mirroring the ReAct gate (handleExecution :1312). Model-C had NO gate
    // before this. Tools are counted but never trimmed.
    const budgetRawMc = (agentContext as { agentConfig?: { maxContextTokens?: unknown } }).agentConfig
      ?.maxContextTokens;
    const budgetTokensMc =
      typeof budgetRawMc === "number" && Number.isFinite(budgetRawMc) && budgetRawMc > 0
        ? budgetRawMc
        : undefined;
    const enforcedMc = enforceBudget({
      systemPrompt: agentContext.systemPrompt ?? "",
      tools: permittedTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      maxContextTokens: budgetTokensMc,
    });
    if (enforcedMc.warning) {
      logger.warn(
        { executionId, warning: enforcedMc.warning },
        "CTX-02 (Model-C): budget enforcement could not be applied; proceeding with full prompt",
      );
    } else if (enforcedMc.wasCompressed) {
      logger.info(
        {
          executionId,
          original_tokens: enforcedMc.originalTokens,
          final_tokens: enforcedMc.finalTokens,
          budget_tokens: enforcedMc.budgetTokens,
        },
        "CTX-02 (Model-C): system prompt compressed to fit token budget",
      );
    }
    agentContext.systemPrompt = enforcedMc.systemPrompt;

    // 4 (continued). Run the normal doctrine-governed surface loop.
    const loopResult = await runWithTimeout(
      runSurfaceAgentLoop(agentDef, input, agentContext, permittedTools, executeTool),
      config.harness.maxExecutionTimeMs / 2,
      `ModelC-SurfaceAgent(${agentName})`,
    );
    const observations = loopResult.observations;

    // Synthesize final response — R02: usa o engine ESCALADO do loop (não um
    // rebuild do default), idêntico ao main path, senão Model-C mantém o bug
    // de `strategy`/`escalated` sempre = default.
    const engine = loopResult.engine;
    const finalPlan = {
      goal: input,
      steps: [{ index: 0, description: "model-c-surface-execution" }],
      estimatedComplexity: "medium" as const,
    };
    const agentResponse: AgentResponse = await engine.synthesize(
      observations,
      finalPlan,
      agentContext,
    );

    agentResponseAnswer = agentResponse.answer;

    // 5a. Send reply (ONCE — no double-respond).
    await sendComplete(
      executionId,
      executionToken,
      buildCompletePayload({
        responseText: agentResponse.answer,
        sentiment: "neutral",
        strategy: agentResponse.strategy,
        proposals: mcProposals,
      }),
      completeKey(executionId, organizationId, "success"),
    );

    // C.8 — Mark the reply as sent AFTER confirmed sendComplete.
    // Uses SET (not NX) so retries safely refresh the TTL.
    await markReplied(redis, organizationId, contactKey, inboundMessage, REPLIED_MARKER_TTL_SEC);

    logger.info({ executionId }, "Model-C: reply sent; advancing workflow cadence");
  }

  // 5b. AFTER send (or after confirming reply was already sent): await resumeWorkflow
  //     to advance the cadence. This is ALWAYS attempted — even on retry — so the
  //     FSM advance is retried independently of the reply idempotency.
  //     Assemble definition + context + toolExecutor mirroring resume-server.ts.
  if (corr.suspendToken) {
    // Fix 2: use the loaded row's workflowId rather than hardcoding "sdr-cadence",
    // matching the resume-server.ts pattern (row.workflowId). Fallback to
    // "sdr-cadence" only when wfRow is null (no row loaded — safe default).
    const workflowId = wfRow?.workflowId ?? "sdr-cadence";
    const definition = WorkflowRegistry.getInstance().getExact(workflowId, corr.workflowVersion);
    if (!definition) {
      logger.warn(
        {
          executionId,
          workflowExecutionId: corr.workflowExecutionId,
          workflowId,
          version: corr.workflowVersion,
        },
        "Model-C: workflow definition not found for version — skipping resume",
      );
      return;
    }

    // Resume payload: inbound message + reasoning signals for the cadence guard.
    // FOLLOW-UP (post-Fase-C): observedSignals is intentionally left empty in Fase C.
    // Mapping an inbound reply to cadence signals (positive/optOut/softNo/pain/authority)
    // requires NLU/reply-extraction logic that is explicitly out of Fase C scope.
    // Until this is implemented, the live bridge can only route replies to set-working-tN
    // (cannot advance the FSM to Qualified or Nurture branches without fixture payloads).
    // Reference: linkedin-ssi-engine spec §Model-C / cadence-guard signal contract.
    const resumePayload = {
      inboundMessage,
      reasoningOutcome: agentResponseAnswer,
      observedSignals: {},
    };

    await resumeWorkflow(store, corr.suspendToken, organizationId, resumePayload, {
      definition,
      context: agentContext,
      toolExecutor: executeTool,
    }).catch((err) => {
      // Non-fatal: log and continue — C.8 replied-marker ensures no double-reply
      // on the next BullMQ retry; the retry will skip sendComplete and re-attempt
      // this resumeWorkflow call.
      logger.warn(
        { executionId, err },
        "Model-C: resumeWorkflow failed (non-fatal, C.8 retry will re-attempt FSM advance)",
      );
    });

    logger.info(
      { executionId, workflowExecutionId: corr.workflowExecutionId },
      "Model-C: cadence advanced",
    );
  }
}

export let dispatchModelC: ((args: DispatchModelCArgs) => Promise<void>) | undefined =
  _dispatchModelCImpl;

/**
 * TEST SEAM: Override the dispatchModelC pointer for unit tests.
 * Call with `undefined` to reset to the default (safe fall-through) state.
 */
export function __setDispatchModelCForTests(
  fn: ((args: DispatchModelCArgs) => Promise<void>) | undefined,
): void {
  dispatchModelC = fn;
}

// ---------------------------------------------------------------------------
// Payload schema — matches what Bevox dispatches via BullMQ
// ---------------------------------------------------------------------------

export const MAX_MESSAGES = 100;
export const MAX_MESSAGE_LENGTH = 8_000;
export const MAX_PAYLOAD_BYTES = 256 * 1024;

// Allowlist of LLM model providers we recognize (Task 3 INDEX correction).
// `default_model` must match a regex AND its provider prefix (when present) must
// be in this set.
const MODEL_REGEX = /^[a-z0-9.\-_/]+$/i;
const MODEL_PROVIDER_ALLOWLIST = new Set(["openai", "gemini", "anthropic"]);

function isValidModelString(model: string): boolean {
  if (model.length === 0 || model.length > 64) return false;
  if (!MODEL_REGEX.test(model)) return false;
  const slash = model.indexOf("/");
  if (slash === -1) return true; // bare model name (e.g. "gpt-4o-mini")
  const provider = model.slice(0, slash).toLowerCase();
  return MODEL_PROVIDER_ALLOWLIST.has(provider);
}

const messageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string().max(MAX_MESSAGE_LENGTH),
  })
  .passthrough();

const executionPayloadSchema = z
  .object({
    execution_id: z.string().uuid(),
    execution_token: z.string().min(20).max(512),
    callback_base_url: z.string().url().optional(),
    // ADR-019 (landed canon) + _shared/ADR-021: organization_id (UUID string)
    // is the SOLE tenant identifier for the harness. Legacy INT account /
    // organization_id is retired.
    organization_id: z.string().uuid(),
    conversation: z.record(z.string(), z.unknown()).optional(),
    messages: z.array(messageSchema).max(MAX_MESSAGES).optional().default([]),
    context: z.record(z.string(), z.unknown()).optional(),
    agent_config: z
      .record(z.string(), z.unknown())
      .optional()
      .refine((cfg) => {
        if (!cfg) return true;
        const model = cfg["default_model"];
        if (model === undefined) return true;
        return typeof model === "string" && isValidModelString(model);
      }, "default_model must match charset/length/allowlist policy"),
    // PERM-05 (auditoria 2026-06-02, runtime-gap §PERM-05): per-execution
    // tool allowlist sent by bevox-backend Layer-2 policy. When non-empty,
    // any tool NOT in this list is denied at execution time via the derived
    // `accountDeniedTools` set (complement vs. the registry). When empty,
    // no allowlist filter is applied. See
    // `src/permissions/permission-context.ts:deriveAccountDeniedTools`.
    skills: z.array(z.string()).max(50).optional().default([]),
    // PERM-05: per-execution explicit denylist (authoritative blacklist).
    // Sent by bevox-backend Layer-2 policy when an organization has tools
    // forbidden regardless of agent definition. Merged with the derived
    // complement of `skills` (the allowlist) into the final Layer-2 set.
    account_denied_tools: z.array(z.string()).max(200).optional().default([]),
    // Sprint C.2 — per-execution opt-in for streaming. Effective only when
    // env.STREAM_ENABLED is also true (global AND per-execution).
    stream: z.boolean().optional().default(false),
    // C8 (auditoria 2026-06-02): modo de autonomia (canon ADR-006). Backend
    // sempre envia, mas tornamos opcional com default conservador para
    // retrocompat com payloads de teste e versões antigas. Propagado para
    // AgentExecutionContext.executionMode → ToolContext.execution_mode →
    // MutationTool.executeOrPropose (consumido em C9).
    execution_mode: ExecutionModeSchema.optional().default("autonomous_supervised"),
    // Idempotency lineage (canon APPROVED — bevox-knowledge #62 harness-proposal
    // + #63 backend-edits). OPTIONAL inbound field: the ROOT execution_id of a
    // replay lineage. A staff replay arrives with a NEW `execution_id` but the
    // SAME `original_execution_id` (the backend chains every replay to the root).
    // When present, `MutationTool.deriveIdempotencyKey` uses it as the
    // execution_id component of the hash, so a replay derives the SAME key as
    // the original execution → backend dedups → NO duplicate mutation. ABSENT
    // (default) → byte-identical to today (key uses `execution_id`). The schema
    // already `.passthrough()`es, but we declare the field explicitly so it is
    // typed and threaded into AgentExecutionContext.
    original_execution_id: z.string().uuid().optional(),
    // J9 (runtime-gap): teto de custo por-execução em USD, enviado pelo
    // bevox-backend quando a org/plano impõe limite. Opcional; quando ausente,
    // cai no default env HARNESS_MAX_COST_USD (ou sem teto se env=0). Positivo
    // e ≤ 1000 USD (sanidade). Use ausência (não 0 explícito) para "sem teto".
    max_cost_usd: z.number().positive().max(1000).optional(),
    // J8 backend-coupling (canon APPROVED: bevox-knowledge #62/#63): deadline
    // ABSOLUTO de wall-clock em epoch ms, ancorado no RELÓGIO DO BACKEND (DB).
    // Quando presente e positivo, o harness prefere este valor ao deadline
    // derivado localmente (`devStartTs + maxExecutionTimeMs`) — fechando o skew
    // fila + clock entre producer e worker (ver §4.10 Backend coupling). Um
    // retry tardio nascido com `deadline_ms` JÁ NO PASSADO faz o gate de
    // deadline/abort J8 disparar imediatamente → terminal `aborted_timeout`.
    // OPCIONAL: ausente/inválido ⇒ fallback byte-idêntico ao comportamento atual.
    deadline_ms: z.number().int().positive().optional(),
  })
  .passthrough();

export type ExecutionPayload = z.infer<typeof executionPayloadSchema>;

/**
 * J3 — payload que o harness NUNCA conseguirá processar (oversize ou
 * Zod-inválido). Distinto de erros transientes do handler: re-tentar um
 * payload poison é um loop garantido — e com `attempts: 7` LIVE no
 * produtor seria um retry-storm 7x.
 *
 * ESTENDE `UnrecoverableError` do BullMQ (NÃO `Error`): o BullMQ honra
 * `err instanceof UnrecoverableError || err.name == 'UnrecoverableError'`
 * (verificado em `bullmq@5.76.9` `classes/job.js:486`) e move o job direto
 * pro `failed` set sem re-tentar, INDEPENDENTE de `attempts`. Sem
 * dependência da API `discard()` (deprecated + síncrona/void no 5.76.9).
 *
 * Carrega o execution_id/token quando recuperáveis de um payload
 * parcialmente válido, para o sinal dead-letter best-effort (§4.3).
 */
export class UnprocessablePayloadError extends UnrecoverableError {
  readonly nonRetryable = true as const;
  readonly executionId?: string;
  readonly executionToken?: string;
  constructor(message: string, salvage?: { executionId?: string; executionToken?: string }) {
    super(message);
    this.name = "UnprocessablePayloadError";
    this.executionId = salvage?.executionId;
    this.executionToken = salvage?.executionToken;
  }
}

// Revalida ISOLADAMENTE apenas os dois campos de auth, com os mesmos bounds
// do schema vivo (execution_id uuid `:517`, execution_token 20..512 `:518`),
// para nunca propagar token-lixo no header X-Execution-Token (risco §8.3).
const salvageSchema = z.object({
  execution_id: z.string().uuid(),
  execution_token: z.string().min(20).max(512),
});

function salvageIdToken(raw: unknown): { executionId?: string; executionToken?: string } {
  // safeParse (não .parse): evita uma segunda exceção dentro do path de erro;
  // retorna {} quando id/token não são confiáveis → sem sinal (comportamento
  // seguro do risco §8.3).
  const r = salvageSchema.safeParse(raw);
  if (!r.success) return {};
  return { executionId: r.data.execution_id, executionToken: r.data.execution_token };
}

/**
 * Validates payload size (UTF-8 byte length of the JSON encoding) and shape.
 * Em violação lança `UnprocessablePayloadError` (poison). Oversize NÃO faz
 * salvage (id/token nunca validados); Zod-inválido faz salvage best-effort.
 */
export function parseExecutionPayload(raw: unknown): ExecutionPayload {
  const json = JSON.stringify(raw);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_PAYLOAD_BYTES) {
    throw new UnprocessablePayloadError(
      `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes (got ${byteLength})`,
    );
  }
  const result = executionPayloadSchema.safeParse(raw);
  if (!result.success) {
    const salvage = salvageIdToken(raw);
    throw new UnprocessablePayloadError(
      `Invalid dispatch payload: ${result.error.message}`,
      salvage,
    );
  }
  return result.data;
}

export { executionPayloadSchema };

// ---------------------------------------------------------------------------
// Context passed down from the bootstrap stage
// ---------------------------------------------------------------------------

export interface ExecutionContext {
  db: Pool;
  redis: Redis;
  agentRegistry?: AgentRegistry;
  toolRegistry?: UnifiedToolRegistry;
  agentRouter?: AgentRouter;
}

// ---------------------------------------------------------------------------
// LLM bridge — adapts LLMGateway → LlmClient used by pipeline agents
// ---------------------------------------------------------------------------

class LlmClientBridge implements LlmClient {
  constructor(private readonly gateway: LLMGateway) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const messages: LLMMessage[] = [
      ...(req.doctrine ? [{ role: "system" as const, content: req.doctrine }] : []),
      { role: "system" as const, content: req.system },
      { role: "user" as const, content: req.user },
    ];

    // For json_object format: pass a simple schema hint (no strict schema)
    const responseSchema: Record<string, unknown> | undefined =
      req.responseFormat?.type === "json_object" ? { type: "object" } : undefined;

    const response = await this.gateway.complete({
      messages,
      responseSchema,
      maxTokens: req.maxTokens,
    });

    return {
      content: response.content ?? "",
      model: response.model,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    };
  }
}

// ---------------------------------------------------------------------------
// Surface agent execution loop (step-level escalation)
// ---------------------------------------------------------------------------

/**
 * Runs a surface agent's reasoning loop with step-level escalation.
 *
 * After each step the StepEvaluator checks whether the current engine
 * should be swapped:
 *  - wrap-reflexion   → wrap current engine with ReflexionWrapper
 *  - escalate-to-plan-execute → replace engine with PlanExecuteEngine, re-plan
 *  - escalate-to-rewoo        → replace engine with ReWOOEngine, re-plan
 *
 * Accumulated observations are always preserved across engine swaps.
 */
/**
 * R02 (a-reasoning-02) — resultado do surface loop, expondo o engine que de
 * fato executou o último step (escalado ou não) para que o synthesis e a
 * telemetria reflitam a realidade, não o default do agent.
 */
export interface SurfaceLoopResult {
  observations: Observation[];
  /** Engine que executou o último step (escalado/embrulhado ou o original). */
  engine: ReasoningEngine;
  /** true se houve qualquer swap/reflexão (escalationChain.length > 1). */
  escalated: boolean;
  /** Cadeia from→to: ["react"] = sem escalation; ["react","reflexion"] etc. */
  escalationChain: string[];
}

export async function runSurfaceAgentLoop(
  agent: AgentDefinition,
  input: string,
  agentContext: AgentExecutionContext,
  tools: ToolDefinition[],
  executeTool: ToolExecutor,
  traceCallback?: TraceCallback,
): Promise<SurfaceLoopResult> {
  const escalationConfig: EscalationConfig = {
    stepThreshold: agent.reasoning?.escalation?.stepThreshold ?? 5,
    parallelThreshold: agent.reasoning?.escalation?.parallelThreshold ?? 2,
    onFailure: agent.reasoning?.escalation?.onFailure ?? "abort",
    escalateTo: agent.reasoning?.escalation?.escalateTo ?? "plan-execute",
  };

  let engine: ReasoningEngine = strategyRouter.build(agent, agentContext);
  let plan: Plan = await engine.plan(input, agentContext);
  const allObservations: Observation[] = [];
  let stepIndex = 0;
  // R02 — cadeia de estratégias para telemetria. Inicia com a estratégia do
  // engine construído pelo router (o scheduler entra como ReflexionWrapper,
  // cujo `.strategy` delega ao inner React → "react").
  const escalationChain: string[] = [engine.strategy];

  while (await engine.shouldContinue(allObservations, plan, agentContext)) {
    // J8 — gate cooperativo de deadline ABSOLUTO no topo de cada step.
    //
    // No caso de FALLBACK (`deadlineMs = devStartTs + maxExecutionTimeMs`) o
    // wrapper `runWithTimeout(..., maxExecutionTimeMs/2)` que envolve este loop
    // SEMPRE estoura primeiro (metade do budget < budget inteiro), então este
    // gate é inalcançável e o desfecho é `phase_timeout` → `aborted_timeout`,
    // byte-idêntico ao comportamento legado (o gate nunca trip nesse caminho).
    //
    // O gate só dispara quando `deadlineMs` é um deadline ABSOLUTO vindo do
    // payload (backend coupling, canon #62/#63) e JÁ está no passado/cruzado —
    // p.ex. um retry tardio nascido depois do deadline do backend. Aí ele
    // aborta IMEDIATAMENTE, sem gastar outro step de LLM numa execução
    // condenada → terminal `aborted_timeout` (`wall_clock_timeout` é mapeado
    // pro mesmo desfecho que `phase_timeout` no boundary). `retryable:false`:
    // re-rodar a MESMA execução só re-estoura o mesmo deadline absoluto.
    if (
      agentContext.deadlineMs != null &&
      Date.now() >= agentContext.deadlineMs
    ) {
      throw new ExecutionAbortError(
        "wall_clock_timeout",
        `Execution exceeded wall-clock deadline (deadline=${agentContext.deadlineMs}, now=${Date.now()})`,
        /* retryable */ false,
      );
    }

    // J9 — teto de custo (determinístico ⇒ non-retryable). Checado ANTES do
    // próximo step: se o step anterior já cruzou o teto, aborta sem novo gasto.
    if (
      agentContext.costCeilingCents != null &&
      (agentContext.costAccumulator?.costCents ?? 0) >= agentContext.costCeilingCents
    ) {
      throw new ExecutionAbortError(
        "cost_ceiling",
        `Cost ceiling reached: ${agentContext.costAccumulator?.costCents}c >= ${agentContext.costCeilingCents}c`,
        /* retryable */ false,
      );
    }

    // Execute one step (wrapped in span)
    const stepResult = await withSpan(
      "reasoning.step",
      {
        "engine.type": engine.strategy,
        "step.index": stepIndex,
        "plan.length": plan.steps?.length,
        "execution.id": agentContext.executionId,
      },
      async () => engine.step(plan, stepIndex, tools, agentContext, executeTool, traceCallback),
    );

    const observation = await engine.observe(stepResult, agentContext);
    allObservations.push(observation);

    // Evaluate escalation
    const decision = stepEvaluator.evaluate(allObservations, plan, escalationConfig);

    if (decision.action !== "continue") {
      logger.info(
        { execution_id: agentContext.executionId, escalation: decision },
        "Escalating reasoning strategy",
      );

      // Sprint C.2 — emit engine_strategy event when streaming is enabled.
      const fromStrategy = engine.strategy;

      if (decision.action === "wrap-reflexion") {
        // R02 — embrulha NO MÁXIMO uma vez. O scheduler JÁ entra embrulhado
        // pelo router (onFailure:'reflexion'), então normalmente NÃO re-embrulha
        // — sem este guard, cada falha repetida (Rule 1 re-dispara) aninharia
        // um novo ReflexionWrapper, multiplicando os retries.
        if (!(engine instanceof ReflexionWrapper)) {
          engine = new ReflexionWrapper({ inner: engine });
        }
        // Telemetria/cadeia disparam SEMPRE (mesmo já-embrulhado), senão a
        // observabilidade de reflexão fica morta p/ o scheduler. Dedup: só
        // empurra "reflexion" se ainda não for o topo da cadeia.
        if (escalationChain[escalationChain.length - 1] !== "reflexion") {
          escalationChain.push("reflexion");
        }
        if (agentContext.streamCallback) {
          try {
            await agentContext.streamCallback({
              type: "engine_strategy",
              payload: { from: fromStrategy, to: "reflexion", reason: decision.action },
            });
          } catch {
            // best-effort
          }
        }
        // (sem `continue` — comportamento legado: cai em stepIndex++)
      } else if (decision.action === "escalate-to-plan-execute") {
        engine = new PlanExecuteEngine();
        escalationChain.push(engine.strategy);
        if (agentContext.streamCallback) {
          try {
            await agentContext.streamCallback({
              type: "engine_strategy",
              payload: { from: fromStrategy, to: engine.strategy, reason: decision.action },
            });
          } catch {
            // best-effort
          }
        }
        const remainingInput = `${input}\n\nCompleted so far:\n${allObservations.map((o) => o.summary).join("\n")}`;
        plan = await engine.plan(remainingInput, agentContext);
        // Audit ref a-reasoning-04: clear mutable engine state after a fresh
        // plan revision so prior-engine divergence scores and replan flags
        // do not bleed into the new plan's shouldContinue() checks.
        engine.reset?.();
        stepIndex = 0;
        continue;
      } else if (decision.action === "escalate-to-rewoo") {
        // R03 (a-reasoning-03) — dirige ReWOO pelo path PARALELO real
        // (executeWaves), honrando a ORDEM de dependsOn (NÃO fluxo de dados
        // entre steps — OQ6), em vez do loop sequencial genérico que ignora
        // dependsOn. As waves rodam o plano inteiro de uma vez → break.
        const rewoo = new ReWOOEngine();
        engine = rewoo;
        escalationChain.push(engine.strategy);
        if (agentContext.streamCallback) {
          try {
            await agentContext.streamCallback({
              type: "engine_strategy",
              payload: { from: fromStrategy, to: engine.strategy, reason: decision.action },
            });
          } catch {
            // best-effort
          }
        }
        const remainingInput = `${input}\n\nCompleted so far:\n${allObservations.map((o) => o.summary).join("\n")}`;

        // J8 — gate de deadline ANTES de disparar waves (paralelo é caro).
        if (agentContext.deadlineMs != null && Date.now() >= agentContext.deadlineMs) {
          throw new ExecutionAbortError(
            "wall_clock_timeout",
            `Execution exceeded wall-clock deadline before ReWOO waves (deadline=${agentContext.deadlineMs}, now=${Date.now()})`,
            /* retryable */ false,
          );
        }
        // J9 — teto de custo ANTES das waves.
        if (
          agentContext.costCeilingCents != null &&
          (agentContext.costAccumulator?.costCents ?? 0) >= agentContext.costCeilingCents
        ) {
          throw new ExecutionAbortError(
            "cost_ceiling",
            `Cost ceiling reached before ReWOO waves: ${agentContext.costAccumulator?.costCents}c >= ${agentContext.costCeilingCents}c`,
            /* retryable */ false,
          );
        }

        try {
          plan = await rewoo.plan(remainingInput, agentContext);
        } catch (err) {
          if (err instanceof CyclicDependencyError) {
            // Plano cíclico é determinístico → abort não-retryable (re-rodar só
            // re-gera o mesmo ciclo). OQ4: fallback sequencial fica fora do piloto.
            throw new ExecutionAbortError("invalid_plan", err.message, /* retryable */ false);
          }
          throw err;
        }

        const waveObs = await withSpan(
          "reasoning.rewoo.waves",
          {
            "engine.type": engine.strategy,
            "plan.length": plan.steps?.length,
            "execution.id": agentContext.executionId,
          },
          async () => rewoo.executeWaves(plan, tools, agentContext, executeTool, traceCallback),
        );
        allObservations.push(...waveObs);

        // J9 — re-check pós-waves (waves podem ter cruzado o teto).
        if (
          agentContext.costCeilingCents != null &&
          (agentContext.costAccumulator?.costCents ?? 0) >= agentContext.costCeilingCents
        ) {
          throw new ExecutionAbortError(
            "cost_ceiling",
            `Cost ceiling reached after ReWOO waves: ${agentContext.costAccumulator?.costCents}c >= ${agentContext.costCeilingCents}c`,
            /* retryable */ false,
          );
        }
        break; // ReWOO roda o plano inteiro de uma vez → run completa.
      }
    }

    stepIndex++;
  }

  return {
    observations: allObservations,
    engine,
    escalated: escalationChain.length > 1,
    escalationChain,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Promise-timeout wrapper. J8: este wrapper É a GARANTIA de wall-clock. O
 * surface loop roda dentro de `runWithTimeout(..., maxExecutionTimeMs/2)`; no
 * estouro ele dispara `controller?.abort()` (best-effort para trabalho
 * cooperativo in-flight) e rejeita com `ExecutionAbortError("phase_timeout")`.
 * Trabalho não-cooperativo (um `fetch` LLM in-flight) NÃO é cancelado por aqui
 * — fica bounded pelo `AbortSignal.timeout(30s)` self-imposto do adapter. O
 * `controller` é opcional: callers legados (`:376`, `:1059`, `:1088`, `:1529`)
 * continuam compilando sem mudança. O `phase_timeout` é marcado
 * `retryable: false`: estourar o budget de wall-clock é um desfecho TERMINAL
 * (re-tentar a MESMA execução só re-estoura), então o boundary o trata como
 * abort terminal (ACK + /complete `aborted_timeout`, sem rethrow para retry).
 */
function runWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  controller?: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(
        new ExecutionAbortError(
          "phase_timeout",
          `Timeout: ${label} exceeded ${ms}ms`,
          /* retryable */ false,
        ),
      );
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Maps a workflow result onto the `/complete` callback payload contract.
 *
 * Workflows do not produce sentiment or token usage natively, so:
 *  - `sentiment` defaults to the pipeline analyzer's reading (passed in).
 *  - `usage` is omitted (nullable per CompletePayload). When Phase 4
 *    telemetry exposes per-step LLM usage in workflow context, populate
 *    this from the aggregated counter.
 */
function mapWorkflowResultToCallback(
  result: RunWorkflowResult,
  fallbackSentiment: string,
): import("../integration/bevox-callback.js").CompletePayload {
  let responseText = "";
  if (result.status === "completed") {
    responseText = formatWorkflowResponse(result.output ?? result.stepOutputs);
  } else if (result.status === "failed") {
    responseText = `Workflow failed: ${result.error ?? "unknown error"}`;
  } else if (result.status === "cancelled") {
    responseText = "Workflow cancelled";
  }
  return buildCompletePayload({
    responseText,
    sentiment: fallbackSentiment,
    strategy: "workflow",
  });
}

function formatWorkflowResponse(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    try {
      return JSON.stringify(output);
    } catch {
      return "[unserialisable workflow output]";
    }
  }
  return String(output);
}

export function extractAnalyzerOutput(agentResult: { success: boolean; output: unknown }): {
  intent: string;
  sentiment: string;
  sentimentConfidence: number;
  topics: string[];
  urgency: string;
  sdrSubMode?: string;
} {
  if (!agentResult.success || !agentResult.output) {
    return {
      intent: "unknown",
      sentiment: "neutral",
      sentimentConfidence: 0.5,
      topics: [],
      urgency: "medium",
    };
  }
  const out = agentResult.output as Record<string, unknown>;
  return {
    intent: typeof out["intent"] === "string" ? out["intent"] : "unknown",
    sentiment: typeof out["sentiment"] === "string" ? out["sentiment"] : "neutral",
    sentimentConfidence:
      typeof out["sentimentConfidence"] === "number" ? out["sentimentConfidence"] : 0.5,
    topics: Array.isArray(out["topics"]) ? (out["topics"] as string[]) : [],
    urgency: typeof out["urgency"] === "string" ? out["urgency"] : "medium",
    sdrSubMode: typeof out["sdrSubMode"] === "string" ? out["sdrSubMode"] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleExecution(rawPayload: unknown, ctx: ExecutionContext): Promise<void> {
  // 1. Validate payload (size + shape)
  let payload: ExecutionPayload;
  try {
    payload = parseExecutionPayload(rawPayload);
  } catch (err) {
    if (err instanceof UnprocessablePayloadError) {
      logger.error(
        { jobErr: err.message, hasSalvage: Boolean(err.executionId) },
        "Unprocessable dispatch payload (poison) — rethrowing to failed set + dead_letter signal",
      );
      // §4.2/§b: NÃO emitir callback aqui. O salvage (id/token) viaja no
      // UnprocessablePayloadError e é lido pelo `worker.on("failed")` listener
      // (Task 8), que escreve `status='dead_letter'` UMA vez. Emitir
      // sendComplete(failed) aqui seria invisível à replay UI (não seta
      // dead_letter) e duplicaria o sinal.
    }
    // SEMPRE relança: o worker marca o job `failed` (UnrecoverableError → sem
    // retry-storm 7x) em vez de `completed`; o failed listener escreve o sinal.
    throw err;
  }
  const { execution_id, execution_token } = payload;
  const organizationId = payload.organization_id;

  logger.info({ execution_id, organizationId }, "Handling execution");

  return withSpan(
    "execution.handle",
    { "execution.id": execution_id, "organization.id": organizationId },
    async (rootSpan) => {
      // 2. Redis dedup — SET NX with 1-hour TTL
      const dedupKey = `harness:dedup:${execution_id}`;
      const acquired = await withSpan(
        "execution.dedup",
        { "execution.id": execution_id },
        async () => ctx.redis.set(dedupKey, "1", "EX", 3600, "NX"),
      );
      if (acquired === null) {
        logger.warn({ execution_id }, "Duplicate execution — skipping");
        rootSpan.setAttribute("execution.dedup.duplicate", true);
        return;
      }

      // Dev playground bus (no-op when HARNESS_DEV_MODE not set).
      const devBus = isDevModeEnabled() ? getDevEventBus() : null;
      const devStartTs = Date.now();
      if (devBus) {
        const recentMessages = (payload.messages ?? []).slice(-3);
        devBus.emitEvent({
          kind: "execution.started",
          executionId: execution_id,
          organizationId,
          ts: devStartTs,
          payload: { messages: recentMessages },
        });
      }

      const sessionStore = new SessionStore(ctx.redis);

      // 3. Create session
      const conversationId =
        typeof payload.conversation?.["id"] === "number" ? payload.conversation["id"] : 0;

      await withSpan("execution.session.create", { "execution.id": execution_id }, async () =>
        sessionStore.create(execution_id, {
          executionId: execution_id,
          organizationId,
          conversationId,
          status: "running",
          startedAt: new Date().toISOString(),
        }),
      );

      // Resolve registries — fall back to singletons if not injected
      const agentRegistry = ctx.agentRegistry ?? AgentRegistry.getInstance();
      const toolRegistry = ctx.toolRegistry ?? UnifiedToolRegistry.getInstance();
      const agentRouter = ctx.agentRouter;

      // Build LLM gateway and bridge
      const agentConfigRaw = payload.agent_config ?? {};
      const defaultModel =
        typeof agentConfigRaw["default_model"] === "string"
          ? agentConfigRaw["default_model"]
          : undefined;

      // C13 — accumulator de tokens reais. Mutado por referência pelo
      // UsageDecorator a cada response do LLM; lido no /complete final
      // (substitui o `totalTokens = 0` hardcoded). Best-effort: callback
      // engole erros internamente.
      const usageAccumulator = { promptTokens: 0, completionTokens: 0 };
      // J9 — acumulador de custo corrente (centavos USD). Espelha o padrão
      // by-reference do usageAccumulator. Threaded no agentContext (Task 7)
      // e lido pelo cost gate (Task 6) + telemetria (Task 11).
      const costAccumulator = { costCents: 0 };
      // CTX-04 Option C: captured AFTER the budget gate (~:1730) by reference;
      // the closure reads it on the first LLM response to compare our estimate
      // against the provider's real `input_tokens`. 0 until the gate runs.
      let estimatedPromptTokens = 0;
      const gateway = createLLMGateway(
        { default_model: defaultModel },
        {
          onUsage: (usage, meta) => {
            usageAccumulator.promptTokens += usage.input_tokens ?? 0;
            usageAccumulator.completionTokens += usage.output_tokens ?? 0;
            // J9 — custo via o model EFETIVAMENTE usado (pós-failover) reportado
            // pelo adapter. Modelos sem pricing → 0 (teto não dispara, gap §8).
            // ⚠️ Math.ceil por-chamada (cost-calculator.ts:53) over-conta ao
            // somar — fail-safe (gate dispara cedo), aceitável p/ teto de
            // segurança. Streaming sub-conta (completeStream pass-through, §8).
            costAccumulator.costCents += calculateCostCents(
              meta.model,
              usage.input_tokens ?? 0,
              usage.output_tokens ?? 0,
              logger,
            );
            // CTX-04 Option C: best-effort calibration telemetry (UsageDecorator
            // already swallows throws). null ratio -> no signal -> skip attrs.
            const ratio = computeCalibrationRatio(estimatedPromptTokens, usage.input_tokens);
            if (ratio !== null) {
              rootSpan.setAttribute("context.token_estimate_ratio", ratio);
              rootSpan.setAttribute("context.tokenizer_fallback", isUsingFallbackTokenizer());
            }
          },
        },
      );
      const llmClient = new LlmClientBridge(gateway);

      // Build base agent context (shared by pipeline agents)
      const conversationKey =
        typeof payload.conversation?.["id"] === "string"
          ? payload.conversation["id"]
          : String(payload.conversation?.["id"] ?? execution_id);

      const systemPrompt =
        typeof agentConfigRaw["system_prompt"] === "string" ? agentConfigRaw["system_prompt"] : "";

      const sdrParsed = sdrProfileSchema.safeParse(agentConfigRaw["sdr_profile"]);
      const sdrProfile = sdrParsed.success ? sdrParsed.data : undefined;
      // CTX-01 (issue #39): legacy compose kept as the default + fallback.
      // The flag-gated ContextBuilder wiring below (after contactIdCtx is
      // resolved) overrides `composedSystemPrompt` when enabled.
      let composedSystemPrompt = composeSystemPrompt(systemPrompt, sdrProfile);
      let builtContext: BuiltContext | undefined;

      // Sprint C.2 — feature flag matrix: STREAM_ENABLED is global AND
      // payload.stream is per-execution. BOTH must be true to enable.
      const env_ = getEnv();
      // J8 — deadline absoluto de wall-clock (budget INTEIRO, não re-slice).
      // Backend coupling (canon APPROVED bevox-knowledge #62/#63): quando o
      // payload traz um `deadline_ms` ABSOLUTO válido (epoch ms, positivo),
      // ancorado no relógio do backend, ele PREVALECE sobre a derivação local
      // — isso elimina o skew "tempo na fila + clock entre hosts" do worker.
      // Ausente/inválido ⇒ fallback `devStartTs + maxExecutionTimeMs`
      // (byte-idêntico ao comportamento legado). Um `deadline_ms` já no PASSADO
      // é deliberadamente preservado: o gate cooperativo no topo do surface
      // loop (`Date.now() >= deadlineMs`) dispara de imediato → terminal
      // `aborted_timeout` (retry tardio condenado, sem novo gasto de LLM).
      const payloadDeadlineMs = payload.deadline_ms;
      const deadlineMs =
        typeof payloadDeadlineMs === "number" &&
        Number.isFinite(payloadDeadlineMs) &&
        payloadDeadlineMs > 0
          ? payloadDeadlineMs
          : devStartTs + config.harness.maxExecutionTimeMs;
      // J9 — teto: payload override (USD) > default env (USD). Resolvido em
      // centavos; ausente/0 ⇒ undefined ⇒ sem teto (legacy byte-idêntico).
      const ceilingUsd = payload.max_cost_usd ?? env_.HARNESS_MAX_COST_USD;
      const costCeilingCents =
        ceilingUsd && ceilingUsd > 0 ? Math.ceil(ceilingUsd * 100) : undefined;
      const streamEnabled = env_.STREAM_ENABLED && payload.stream === true;
      if (payload.stream === true && !env_.STREAM_ENABLED) {
        logger.warn(
          { execution_id },
          "payload.stream=true ignored because STREAM_ENABLED=false (global flag wins)",
        );
      }
      const streamPublisher = streamEnabled
        ? new StreamPublisher({
            executionId: execution_id,
            token: execution_token,
            callbackBaseUrl: config.bevox.callbackBaseUrl,
            flushMs: env_.STREAM_FLUSH_MS,
            flushTokens: env_.STREAM_FLUSH_TOKENS,
            callbackTimeoutMs: env_.STREAM_CALLBACK_TIMEOUT_MS,
          })
        : undefined;
      const streamCallback: AgentStreamCallback | undefined = streamPublisher
        ? (evt) => streamPublisher.emit(evt)
        : undefined;

      // B.7 — parse contactId for surface agentContext (mirrors D.3 logic at ~875-886)
      const contactIdRawCtx =
        (payload.conversation?.["contact_id"] as number | string | undefined) ??
        (payload.context?.["contact_id"] as number | string | undefined);
      let contactIdCtx: bigint | undefined;
      try {
        if (contactIdRawCtx !== undefined && contactIdRawCtx !== null) {
          contactIdCtx = BigInt(contactIdRawCtx);
        }
      } catch {
        contactIdCtx = undefined;
      }

      // CTX-01 — flag-gated ContextBuilder run (ReAct path). Build ONCE here;
      // reused at the B.8 L3 seam below (no rebuild). Fails open to the legacy
      // prompt on any error; default-off via CONTEXT_BUILDER_ENABLED.
      if (env_.CONTEXT_BUILDER_ENABLED && contactIdCtx != null) {
        try {
          const lastUserMsg = payload.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content)
            .at(-1);
          const contextInput = buildContextInput({
            executionId: execution_id,
            organizationId,
            contactId: contactIdCtx,
            conversationKey,
            systemPrompt,
            dispatchPayload: payload as unknown as Record<string, unknown>,
            userMessage: lastUserMsg,
          });
          const builder = createContextBuilder(
            { db: ctx.db },
            { layerTimeoutMs: env_.CONTEXT_BUILDER_LAYER_TIMEOUT_MS },
          );
          builtContext = await builder.build(contextInput);
          const doctrineTail = composeSystemPrompt("", sdrProfile);
          composedSystemPrompt = foldContext(builtContext, doctrineTail, { withMarker: true });
          setContextSpanAttributes(rootSpan, builtContext);
          if (builtContext.layersFailedUnexpected.length > 0) {
            logger.warn(
              {
                execution_id,
                layers_failed_unexpected: builtContext.layersFailedUnexpected,
              },
              "CTX-01: context layers failed with unexpected errors",
            );
          }
        } catch (err) {
          logger.warn(
            { err, execution_id },
            "CTX-01: context builder failed; falling back to legacy prompt",
          );
          builtContext = undefined;
          composedSystemPrompt = composeSystemPrompt(systemPrompt, sdrProfile);
        }
      }

      const agentContext: AgentExecutionContext = {
        executionId: execution_id,
        organizationId,
        contactId: contactIdCtx,
        conversationKey,
        db: ctx.db,
        logger: logger.child({ execution_id }),
        llmClient,
        accountConfig: {
          llmModel: defaultModel?.split("/")[1] ?? config.llm.model,
          llmProvider: defaultModel?.split("/")[0] ?? config.llm.provider,
        },
        messages: payload.messages.map((m) => ({
          direction: m.role === "user" ? ("incoming" as const) : ("outgoing" as const),
          content: m.content,
          role: m.role,
        })),
        streamCallback,
        systemPrompt: composedSystemPrompt,
        executionMode: payload.execution_mode,
        originalExecutionId: payload.original_execution_id,
        usageAccumulator,
        costAccumulator, // J9
        deadlineMs, // J8
        costCeilingCents, // J9
      };

      // -----------------------------------------------------------------------
      // Step 2.5 — Correlation probe (C.5)
      //
      // Before spending the MessageAnalyzer LLM, check whether this inbound
      // message belongs to a suspended cadence execution. If so, short-circuit
      // to Model C (dispatchModelC) and return immediately — pipeline skipped.
      //
      // Guard: probe runs only when sdr_profile.enabled=true AND contactId was
      // resolved. Both conditions must hold to avoid any cost on the non-SDR
      // path (zero-cost gate). A DB error from resolveActive degrades to a safe
      // fall-through — the probe NEVER throws.
      // -----------------------------------------------------------------------
      if (sdrProfile?.enabled && agentContext.contactId != null) {
        const contactKey = String(agentContext.contactId);
        const corr = await new CorrelationStore(ctx.db)
          .resolveActive(organizationId, contactKey)
          .catch(() => null);

        if (corr !== null) {
          if (dispatchModelC !== undefined) {
            // PERM-05 (auditoria 2026-06-02): derive Layer-2 accountDeniedTools
            // at the call site so the Model-C path receives the same policy
            // enforcement as the main ReAct path. Imported lazily to avoid
            // circular-init cost on the non-SDR path (zero-cost gate above).
            const { deriveAccountDeniedTools } =
              await import("../permissions/permission-context.js");
            const modelCAccountDeniedTools = deriveAccountDeniedTools(
              payload,
              toolRegistry.all().map((t) => t.name),
            );
            return await dispatchModelC({
              corr,
              agentContext,
              organizationId,
              contactKey,
              messages: payload.messages,
              executionToken: execution_token,
              rawSystemPrompt: systemPrompt,
              sdrProfile,
              redis: ctx.redis,
              accountDeniedTools: modelCAccountDeniedTools,
            });
          }
          // C.7 not yet wired — log and fall through (safe pre-C.7 state).
          logger.info(
            { execution_id, workflowExecutionId: corr.workflowExecutionId, contactKey },
            "Correlation probe HIT but dispatchModelC not wired (pre-C.7 fallthrough)",
          );
        }
        // No corr → fall through to normal pipeline.
      }

      let completeSent = false;
      const runStartedAt = Date.now();
      try {
        await updateStatus(execution_id, execution_token, "running");

        // 4-5. Pipeline: analyzer + extractor (within a single pipeline span)
        const analyzerOutput = await withSpan(
          "execution.pipeline",
          { "execution.id": execution_id },
          async () => {
            const analyzerAgentResult = await withSpan(
              "pipeline.message_analyzer",
              { "execution.id": execution_id },
              async () =>
                runWithTimeout(
                  (async () => {
                    if (agentRegistry.has("message-analyzer")) {
                      const agent = agentRegistry.resolve("message-analyzer");
                      return agent.execute(agentContext);
                    }
                    return {
                      success: true,
                      output: {
                        intent: "unknown",
                        sentiment: "neutral",
                        sentimentConfidence: 0.5,
                        topics: [],
                        urgency: "medium",
                      },
                    };
                  })(),
                  config.harness.maxExecutionTimeMs / 4,
                  "MessageAnalyzerAgent",
                ),
            );

            const out = extractAnalyzerOutput(analyzerAgentResult);

            if (agentRegistry.has("memory-extractor")) {
              await withSpan(
                "pipeline.memory_extractor",
                { "execution.id": execution_id },
                async () =>
                  runWithTimeout(
                    agentRegistry.resolve("memory-extractor").execute(agentContext),
                    config.harness.maxExecutionTimeMs / 4,
                    "MemoryExtractorAgent",
                  ),
              ).catch((err) => {
                logger.warn({ err }, "MemoryExtractorAgent failed (non-fatal)");
              });
            }

            return out;
          },
        );

        // 6. Route to surface agent
        const agentName = await withSpan(
          "execution.router.resolve",
          { intent: analyzerOutput.intent },
          async () => {
            if (agentRouter) {
              return agentRouter.resolve(analyzerOutput.intent, agentRegistry);
            }
            return agentRegistry.has("scheduler") ? "scheduler" : "request-human";
          },
        );

        if (agentName === "request-human") {
          // PERM-03 — audit the escalation BEFORE the callback so a failure
          // of sendComplete still leaves the escalation attempt visible.
          emitExecutionAudit({
            executionId: execution_id,
            organizationId,
            agentName: "request-human",
            toolName: "request-human",
            actionType: "escalation",
            actionDetails: {
              escalation_reason: "router_no_surface_agent",
              path: "main",
              strategy: "request-human",
              intent: analyzerOutput.intent,
            },
            result: "pending_approval",
          });

          await sendComplete(
            execution_id,
            execution_token,
            buildCompletePayload({
              responseText: "",
              sentiment: analyzerOutput.sentiment,
              strategy: "request-human",
            }),
            completeKey(execution_id, organizationId, "request-human"),
          );
          await sessionStore.update(execution_id, {
            status: "completed",
            completedAt: new Date().toISOString(),
          });
          devBus?.emitEvent({
            kind: "execution.completed",
            executionId: execution_id,
            ts: Date.now(),
            durationMs: Date.now() - devStartTs,
            status: "ok",
          });
          return;
        }

        // 7. Resolve surface agent + build permitted tool list
        const surfaceAgent = agentRegistry.resolve(agentName);
        const agentDef = surfaceAgent.definition;

        // 7a. Workflow precedence — if the agent declares a workflow id,
        //     dispatch to the workflow engine and skip reasoning entirely.
        //     Hard fail when the workflow is not registered (see JSDoc on
        //     AgentDefinition.workflow).
        if (agentDef.workflow) {
          const workflowDef = WorkflowRegistry.getInstance().get(agentDef.workflow);
          if (!workflowDef) {
            throw new Error(
              `Agent "${agentDef.name}" requires workflow "${agentDef.workflow}" but it is not registered`,
            );
          }

          // Build tool executor identical in shape to the reasoning path so
          // workflow steps reuse the same permission-filtered tool surface.
          const wfToolRegistry = toolRegistry;
          const wfExecuteTool = async (
            toolName: string,
            params: unknown,
            toolContext: AgentExecutionContext,
          ) => {
            const tool = wfToolRegistry.resolve(toolName);
            if (!tool) {
              return { success: false, error: `Tool not found: ${toolName}` };
            }
            return tool.execute(params, toolContext);
          };

          const userInput = payload.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content)
            .join("\n");

          const store = new WorkflowStateStore(ctx.db);

          const wfResult = await withSpan(
            "execution.workflow.run",
            {
              "workflow.id": workflowDef.id,
              "workflow.version": workflowDef.version,
              "execution.id": execution_id,
            },
            async () =>
              runWorkflow({
                definition: workflowDef,
                input: { userInput, messages: payload.messages, agentConfig: agentConfigRaw },
                context: agentContext,
                store,
                executionId: execution_id,
                organizationId,
                toolExecutor: wfExecuteTool,
                defaultStepTimeoutMs: config.harness.maxExecutionTimeMs / 4,
              }),
          );

          // Suspended workflows do NOT close the execution. Bevox is told
          // we're still running (V1 fallback per Task 8 Step 4 — coordinate
          // with Bevox before introducing a dedicated "suspended" status).
          // The resume server / subscriber will eventually call `complete`.
          //
          // NOTE: future Sprint C.2 (StreamPublisher) must check status
          // here — streaming MUST stop when a workflow suspends.
          if (wfResult.status === "suspended") {
            await updateStatus(execution_id, execution_token, "running");
            await sessionStore.update(execution_id, { status: "running" });
            logger.info(
              { execution_id, workflowExecutionId: wfResult.workflowExecutionId },
              "Workflow suspended; awaiting resume",
            );
            devBus?.emitEvent({
              kind: "execution.completed",
              executionId: execution_id,
              ts: Date.now(),
              durationMs: Date.now() - devStartTs,
              status: "ok",
            });
            return;
          }

          await sendComplete(
            execution_id,
            execution_token,
            mapWorkflowResultToCallback(wfResult, analyzerOutput.sentiment),
            completeKey(execution_id, organizationId, "workflow"),
          );
          await sessionStore.update(execution_id, {
            status: wfResult.status === "completed" ? "completed" : "failed",
            completedAt: new Date().toISOString(),
          });
          devBus?.emitEvent({
            kind: "execution.completed",
            executionId: execution_id,
            ts: Date.now(),
            durationMs: Date.now() - devStartTs,
            status: wfResult.status === "completed" ? "ok" : "error",
            error: wfResult.error,
          });
          return;
        }

        // B.8 — L3 sales-state recompose seam.
        // Runs AFTER analyzerOutput is resolved (post-pipeline) and BEFORE
        // runSurfaceAgentLoop. The base compose at ~481 set doctrine only;
        // here we layer in the per-(account,contact) state snapshot + subMode.
        // Guard: no sdrProfile, no contactId, or null snapshot → zero-cost
        // (agentContext.systemPrompt stays as set at ~538).
        if (sdrProfile?.enabled && agentContext.contactId != null) {
          const snapshot = await getSdrAccountState(ctx.db, organizationId, agentContext.contactId);
          if (snapshot) {
            if (builtContext) {
              // CTX-01: reuse the already-built context (build-once); only the
              // doctrine/L3 tail changes (base="" — BaseConfigLayer owns base).
              const doctrineTail = composeSystemPrompt(
                "",
                sdrProfile,
                snapshot,
                analyzerOutput.sdrSubMode,
              );
              agentContext.systemPrompt = foldContext(builtContext, doctrineTail, { withMarker: true });
            } else {
              agentContext.systemPrompt = composeSystemPrompt(
                systemPrompt,
                sdrProfile,
                snapshot,
                analyzerOutput.sdrSubMode,
              );
            }
          }
        }

        const { permittedTools } = await withSpan(
          "execution.permissions.filter",
          { "agent.name": agentDef.name },
          async () => {
            const unavailableTools = toolRegistry.getUnavailableNames();
            // PERM-05 (auditoria 2026-06-02): pass the full registry tool
            // names so buildPermissionContext can derive accountDeniedTools
            // from payload.skills (allowlist) + payload.account_denied_tools
            // (explicit blacklist). Without this the Layer-2 denylist would
            // stay empty even when the backend sends a policy.
            const allTools = toolRegistry.all();
            const allKnownToolNames = allTools.map((t) => t.name);
            const permCtx = buildPermissionContext({
              agent: agentDef,
              payload,
              unavailableTools,
              allKnownToolNames,
            });
            return { permittedTools: filterPermittedTools(allTools, agentDef, permCtx) };
          },
        );

        // 7b. CTX-02 (audit 2026-06-02) — enforce token budget on the
        // assembled (systemPrompt + permittedTools) before reasoning.
        //
        // POC scope: trims `agentContext.systemPrompt` in-place when the
        // estimate exceeds `agent_config.max_context_tokens` (falls back
        // to `DEFAULT_GLOBAL_MAX_TOKENS`). Tools are counted but never
        // trimmed. Full 5-layer `ContextBuilder` integration is a follow-up.
        const budgetTokensRaw = agentConfigRaw["max_context_tokens"];
        const budgetTokens =
          typeof budgetTokensRaw === "number" &&
          Number.isFinite(budgetTokensRaw) &&
          budgetTokensRaw > 0
            ? budgetTokensRaw
            : undefined;

        const enforced = enforceBudget({
          // `agentContext.systemPrompt` is typed as optional (see
          // `agents/execution-context.ts`); in this code path it has already
          // been set above (line ~918 / `composedSystemPrompt`). The `?? ""`
          // is defensive — an empty prompt is harmless (no tokens to trim).
          systemPrompt: agentContext.systemPrompt ?? "",
          tools: permittedTools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
          maxContextTokens: budgetTokens,
        });

        rootSpan.setAttribute("context.compressed", enforced.wasCompressed);
        rootSpan.setAttribute("context.original_tokens", enforced.originalTokens);
        rootSpan.setAttribute("context.final_tokens", enforced.finalTokens);
        rootSpan.setAttribute("context.budget_tokens", enforced.budgetTokens);
        rootSpan.setAttribute("context.within_budget", enforced.withinBudget);

        if (enforced.warning) {
          logger.warn(
            {
              execution_id,
              warning: enforced.warning,
              original_tokens: enforced.originalTokens,
              budget_tokens: enforced.budgetTokens,
            },
            "CTX-02: budget enforcement could not be applied; proceeding with full prompt",
          );
        } else if (enforced.wasCompressed) {
          logger.info(
            {
              execution_id,
              original_tokens: enforced.originalTokens,
              final_tokens: enforced.finalTokens,
              budget_tokens: enforced.budgetTokens,
            },
            "CTX-02: system prompt compressed to fit token budget",
          );
        }

        agentContext.systemPrompt = enforced.systemPrompt;
        // CTX-04 Option C: hand the gated prompt estimate to the onUsage
        // closure (declared ~:1180). The first LLM response's input_tokens is
        // the only one matching this prompt; later turns accumulate history,
        // so the emitted ratio is informative, not exact, after turn 1.
        estimatedPromptTokens = enforced.finalTokens;

        // 8. Build user input for surface agent
        const userMessages = payload.messages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("\n");
        const input = `User request:\n${userMessages}`;

        // 9. Collect traces for callback
        const traces: Array<{ step: number; type: string; content: string; timestamp: string }> =
          [];

        const traceCallback: TraceCallback = (event) => {
          traces.push({
            step: event.stepIndex,
            type: "observation",
            content: event.observation.summary,
            timestamp: new Date().toISOString(),
          });
        };

        // 10. Execute surface agent loop (instrumented tool executor)
        // C7 (auditoria 2026-06-02): runtime permission gate. `permittedTools`
        // foi calculado via `filterPermittedTools` no início do step 10, mas
        // ANTES deste fix o executor resolvia o toolName direto contra o
        // registry inteiro — uma tool negada por política, se o LLM a
        // nomeasse, executava. Agora rejeitamos com PERMISSION_DENIED.
        const permittedNames = new Set(permittedTools.map((t) => t.name));
        // EM-03 POC (issue #44): acumulador de propostas per-execução.
        // Tools que herdam de `MutationTool` via `wrapMutationTool` emitem
        // `data.proposal: { action, params }` em modos draft (ADR-006). O
        // executor abaixo extrai cada proposal via `extractProposal()` e
        // empurra aqui; o `/complete` final (linha ~1370) serializa o
        // array como `proposals[]` (consumido pelo seam
        // `executeProposals()` do bevox-backend, ADR-007).
        const proposalsAccumulator: Array<{ action: string; params: unknown }> = [];
        const executeTool: ToolExecutor = async (toolName, params, toolContext) => {
          const tool = toolRegistry.resolve(toolName);
          if (!tool) {
            const missing = { success: false as const, error: `Tool not found: ${toolName}` };
            devBus?.emitEvent({
              kind: "tool.call",
              executionId: execution_id,
              ts: Date.now(),
              tool: toolName,
              params,
              result: { error: missing.error },
              success: false,
              latencyMs: 0,
            });
            return missing;
          }
          if (!permittedNames.has(toolName)) {
            const denied = {
              success: false as const,
              error: `PERMISSION_DENIED: tool "${toolName}" not in permitted set for agent "${agentDef.name}"`,
            };
            logger.warn(
              { execution_id, agent: agentDef.name, toolName },
              "C7 runtime permission gate: tool denied (LLM tried to call denied/unfiltered tool)",
            );
            devBus?.emitEvent({
              kind: "tool.call",
              executionId: execution_id,
              ts: Date.now(),
              tool: toolName,
              params,
              result: { error: denied.error },
              success: false,
              latencyMs: 0,
            });
            return denied;
          }
          const tStart = Date.now();

          // C.9 — §7 tunable: deterministically override params.framework for
          // qualify-opportunity. Profile value (when sdr_profile.enabled) takes
          // precedence over config default; absent profile falls back to config.
          // This makes the PACT/PACT2 tunable live — NOT LLM-chosen (spec §1.1).
          // Other tools are untouched; no skill edit needed.
          let resolvedParams = params;
          if (toolName === "qualify-opportunity") {
            const profileValue = sdrProfile?.enabled
              ? sdrProfile.qualification_framework
              : undefined;
            const framework = resolveQualificationFramework(
              profileValue,
              config.sdr.qualificationFramework,
            );
            resolvedParams = {
              ...(params !== null && typeof params === "object"
                ? (params as Record<string, unknown>)
                : {}),
              framework,
            };
          }

          const result = await withSpan(
            "tool.execute",
            {
              "tool.name": tool.name,
              "tool.category": tool.category,
              "execution.id": execution_id,
            },
            async () => tool.execute(resolvedParams, toolContext),
          );

          // PERM-03 — audit mutation executions (side-effect tools).
          // Fire-and-forget; failure to write the audit row never blocks
          // the runtime path. send-message is included to cover STOP
          // signals routed through the surface-agent tool path.
          if (MUTATION_TOOL_NAMES.has(tool.name)) {
            const sanitizedParams =
              resolvedParams !== null && typeof resolvedParams === "object"
                ? sanitizeAuditDetails(resolvedParams as Record<string, unknown>)
                : {};
            // §4.5: em draft mode a tool retorna success:true com um proposal
            // (efeito NÃO aplicado). Rotular como "proposed" para o trail não
            // afirmar envio/mutação. `isProposal` reusado pelo hoist abaixo.
            const auditProposal = extractProposal(result);
            const isProposal = auditProposal !== undefined;
            emitExecutionAudit({
              executionId: execution_id,
              organizationId,
              agentName: agentDef.name,
              toolName: tool.name,
              actionType: isProposal
                ? "proposal"
                : tool.name === "send-message"
                  ? "escalation"
                  : "mutation_execution",
              actionDetails: {
                tool_category: tool.category,
                parameters: sanitizedParams,
                latency_ms: Date.now() - tStart,
              },
              result: isProposal ? "proposed" : result.success ? "success" : "failure",
              errorMessage: result.success ? undefined : result.error,
            });
          }

          // EM-03 POC (issue #44): hoist proposta para o acumulador.
          // `extractProposal` retorna `undefined` para results
          // convencionais — zero-cost no caminho autonomous_supervised.
          // Reusa o resultado já computado no bloco de auditoria acima.
          const proposal =
            MUTATION_TOOL_NAMES.has(tool.name) ? extractProposal(result) : undefined;
          if (proposal !== undefined) {
            proposalsAccumulator.push(proposal);
            logger.info(
              { execution_id, toolName: tool.name, action: proposal.action },
              "EM-03: proposal captured (draft mode) — will be emitted in /complete.proposals[]",
            );
          }
          devBus?.emitEvent({
            kind: "tool.call",
            executionId: execution_id,
            ts: Date.now(),
            tool: tool.name,
            params,
            result: result.success ? result.data : { error: result.error },
            success: result.success,
            latencyMs: Date.now() - tStart,
          });
          // Sprint C.2 — emit tool_result through stream callback when enabled.
          if (streamPublisher) {
            void streamPublisher.emit({
              type: "tool_result",
              payload: {
                toolCallId: "", // ReAct path doesn't carry an id; Bevox can correlate by sequence
                success: result.success,
                output: result.success ? result.data : { error: result.error },
                durationMs: Date.now() - tStart,
              },
            });
          }
          return result;
        };

        const loopResult = await withSpan(
          "execution.surface.loop",
          {
            "agent.name": agentDef.name,
            "reasoning.engine": agentDef.reasoning?.default,
          },
          async (loopSpan) => {
            const result = await runWithTimeout(
              runSurfaceAgentLoop(
                agentDef,
                input,
                agentContext,
                permittedTools,
                executeTool,
                traceCallback,
              ),
              config.harness.maxExecutionTimeMs / 2,
              `SurfaceAgent(${agentName})`,
            );
            // R02 (a-reasoning-02) — carimba o engine FINAL/escalado e a cadeia
            // no span do loop, não só o default do agent.
            loopSpan.setAttribute("reasoning.steps", result.observations.length);
            loopSpan.setAttribute("reasoning.final_strategy", result.engine.strategy);
            loopSpan.setAttribute("reasoning.escalated", result.escalated);
            loopSpan.setAttribute("reasoning.escalation_chain", result.escalationChain.join(">"));
            return result;
          },
        );
        const observations = loopResult.observations;

        // 11. Synthesize final response — agora bounded pelo deadline restante
        // (J8-b: fecha o buraco do synthesize não-bounded). reject-wrapper SEM
        // AbortController (chamada terminal única, sem step boundary): no
        // estouro o JOB é bounded, mas o fetch interno fica órfão até o
        // AbortSignal.timeout(30s) do adapter (risco §8.8 — NÃO é fix estrutural).
        // R02 — usa o engine ESCALADO do loop (não um rebuild do default), para
        // que `agentResponse.strategy`/`escalated` reflitam a realidade.
        const engine = loopResult.engine;
        const finalPlan = {
          goal: input,
          steps: [{ index: 0, description: "surface-execution" }],
          estimatedComplexity: "medium" as const,
        };
        const remainingMs = Math.max(1, deadlineMs - Date.now());
        const agentResponse: AgentResponse = await runWithTimeout(
          engine.synthesize(observations, finalPlan, agentContext),
          remainingMs,
          `Synthesize(${agentName})`,
        );

        // 12. C13 — usage real acumulado pelo UsageDecorator durante toda
        // a execução (cada call do LLM somou no `usageAccumulator`).
        const finalUsage = {
          prompt_tokens: usageAccumulator.promptTokens,
          completion_tokens: usageAccumulator.completionTokens,
        };

        // 13. Send completion callback
        // EM-03 POC (issue #44): `proposalsAccumulator` é populado durante
        // o surface loop quando tools de mutação retornam `data.proposal`
        // (modos manual_assisted / copilot). `buildCompletePayload` omite
        // o campo se o array estiver vazio (autonomous_supervised path
        // permanece byte-idêntico ao V0).
        await withSpan("execution.callback.complete", { "execution.id": execution_id }, async () =>
          sendComplete(
            execution_id,
            execution_token,
            buildCompletePayload({
              responseText: agentResponse.answer,
              sentiment: analyzerOutput.sentiment,
              strategy: agentResponse.strategy,
              usage: finalUsage,
              proposals: proposalsAccumulator,
            }),
            // §4.2b / C10: chave determinística por DESFECHO terminal. O helper
            // `completeKey` (J8/J9 landed) encapsula a forma viva de
            // deriveIdempotencyKey discriminada por `complete:<kind>` — um
            // retry do MESMO desfecho dedup, `success` nunca colide com `failed`.
            completeKey(execution_id, organizationId, "success"),
          ),
        );
        // §4.2b: o backend já viu SUCCESS. Qualquer throw nos passos
        // pós-/complete NÃO pode emitir um segundo /complete(failed).
        completeSent = true;

        // §4.6b: sinal forense. Se completamos PASSADO nosso próprio deadline,
        // o cron `bevox.timeout.scan` do backend pode já ter feito handoff
        // humano em paralelo (double-handling). Material p/ reconciliação/alerta.
        const runDeadlineMs = getHarnessConfig().harness.maxExecutionTimeMs;
        if (Date.now() - runStartedAt > runDeadlineMs) {
          logger.warn(
            { execution_id, elapsedMs: Date.now() - runStartedAt, deadlineMs: runDeadlineMs },
            "execution.late_completion — completed past run deadline; backend timeout handoff may have occurred",
          );
        }

        // §4.11 — outcome dimension no caminho de sucesso (consultável pelo
        // OTEL p/ agregar taxa de abort por org/causa sem parsear string).
        rootSpan.setAttribute("execution.outcome", "ok");
        rootSpan.setAttribute("execution.cost_cents", costAccumulator.costCents);

        // 13b. Post-execution hooks (eval sampling, etc.). Hooks run
        // strictly OFF the hot path and swallow their own errors.
        const lastUserMessage =
          payload.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
        await runPostExecutionHooks([createEvalSamplingHook()], {
          payload,
          agentResponse,
          finalResponse: agentResponse.answer,
          lastUserMessage,
          organizationId,
          agentName,
        });

        // 13c. Sprint D.3 — fire-and-forget message indexing + condense
        // enqueue. Both guarded by feature flags via the memory registry:
        // when flags are off, the getters return undefined and the block
        // is a no-op. Errors are explicitly swallowed — D.3 must NEVER
        // block or fail the main execution.
        const indexer = getMessageIndexer();
        const condenseQueue = getCondenseQueue();
        if (indexer || condenseQueue) {
          const contactIdRaw =
            (payload.conversation?.["contact_id"] as number | string | undefined) ??
            (payload.context?.["contact_id"] as number | string | undefined);
          let contactIdBig: bigint | undefined;
          try {
            if (contactIdRaw !== undefined && contactIdRaw !== null) {
              contactIdBig = BigInt(contactIdRaw);
            }
          } catch {
            contactIdBig = undefined;
          }
          if (contactIdBig !== undefined && organizationId) {
            const organizationIdLocal = organizationId;
            const contactIdLocal = contactIdBig;
            const messagesLocal = payload.messages.map((m, i) => ({
              messageId: `${execution_id}:${i}`,
              role: m.role,
              content: m.content,
              messageAt: new Date(),
            }));
            queueMicrotask(() => {
              void (async () => {
                try {
                  if (indexer) {
                    await indexer.index(organizationIdLocal, contactIdLocal, messagesLocal);
                  }
                  if (condenseQueue) {
                    await enqueueCondense(condenseQueue, organizationIdLocal, contactIdLocal);
                  }
                } catch (err) {
                  logger.warn(
                    { err, execution_id, organizationId: organizationIdLocal },
                    "D.3 memory post-hook failed (non-fatal)",
                  );
                }
              })();
            });
          }
        }

        // 14. Clean up — §4.2b: genuinamente off-hot-path (o backend já tem o
        // SUCCESS). NUNCA relançar daqui: um hiccup de Redis aqui caía no
        // boundary catch e emitia um segundo /complete(failed).
        await sessionStore
          .update(execution_id, {
            status: "completed",
            completedAt: new Date().toISOString(),
          })
          .catch((sessErr) => {
            logger.warn(
              { execution_id, sessErr },
              "Post-complete session update failed (non-fatal)",
            );
          });

        devBus?.emitEvent({
          kind: "execution.completed",
          executionId: execution_id,
          ts: Date.now(),
          durationMs: Date.now() - devStartTs,
          status: "ok",
        });

        logger.info({ execution_id }, "Execution completed");
      } catch (err) {
        logger.error({ execution_id, err }, "Execution failed");

        // J8/J9 — discrimina exhaustion de falha genérica. abort !== undefined
        // ⇒ wall_clock_timeout/cost_ceiling/phase_timeout. strategy distinto é
        // SÓ telemetria; pro contrato de idempotência os aborts mapeiam pro
        // mesmo desfecho de erro (spec irmã §4.4 ⇒ kind:"failed"). NÃO há novo
        // call-site de /complete: o boundary continua o ÚNICO emissor terminal.
        const abort = err instanceof ExecutionAbortError ? err : undefined;
        const strategy = abort
          ? abort.reason === "cost_ceiling"
            ? "aborted_cost"
            : "aborted_timeout"
          : "failed";

        devBus?.emitEvent({
          kind: "execution.completed",
          executionId: execution_id,
          ts: Date.now(),
          durationMs: Date.now() - devStartTs,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });

        // §4.11 (J8/J9) — telemetria obrigatória (sem isto o abort fecha CEGO). O
        // harness não tem counters; usamos span attrs + 1 log estruturado.
        rootSpan.setAttribute("execution.outcome", strategy);
        rootSpan.setAttribute("execution.duration_ms", Date.now() - devStartTs);
        rootSpan.setAttribute("execution.cost_cents", costAccumulator.costCents);
        if (abort) {
          rootSpan.setAttribute("execution.abort.reason", abort.reason);
          // Log estruturado dedicado — plataformas alertam sobre RATE deste
          // event (substituto do counter). SEM PII (regra harness-llm.md).
          logger.warn(
            {
              event: "execution.aborted",
              execution_id,
              reason: abort.reason,
              cost_cents: costAccumulator.costCents,
              ceiling_cents: costCeilingCents ?? null,
              duration_ms: Date.now() - devStartTs,
              deadline_ms: deadlineMs,
            },
            "Execution aborted (bounding gate)",
          );
        }

        // Error boundary: emissor terminal ÚNICO de /complete. COMBINA J8/J9 +
        // J3:
        //   • J8/J9: a `strategy` é DISCRIMINADA pelo desfecho
        //     (`failed` | `aborted_timeout` | `aborted_cost`) e a chave de
        //     idempotência C10 (`completeKey`) é discriminada pela MESMA
        //     `strategy` — um retry do mesmo desfecho dedup; desfechos distintos
        //     nunca colidem.
        //   • J3 (§4.2b): o guard `completeSent` impede um SEGUNDO /complete
        //     quando o SUCCESS já foi enviado e o throw veio de um passo
        //     pós-complete genuinamente off-hot-path. (Aborts disparam DENTRO
        //     do surface loop, antes do SUCCESS, então `completeSent` é false e
        //     o /complete terminal é emitido normalmente.)
        if (!completeSent) {
          await sendComplete(
            execution_id,
            execution_token,
            buildCompletePayload({ responseText: "", sentiment: "neutral", strategy }),
            // C10 idempotency key discriminated by the J8/J9 terminal outcome
            // (`failed` | `aborted_timeout` | `aborted_cost`) so a retry of the
            // SAME outcome dedups while distinct outcomes never collide.
            completeKey(execution_id, organizationId, strategy),
          ).catch((callbackErr) => {
            logger.warn({ callbackErr }, "Failed to send error /complete callback");
          });
        } else {
          logger.warn(
            { execution_id, err: err instanceof Error ? err.message : String(err) },
            "Post-complete step threw after SUCCESS callback — suppressing duplicate /complete(failed)",
          );
        }

        await sessionStore.update(execution_id, { status: "failed" }).catch(() => {});

        // J8 — ABORT é desfecho TERMINAL, não transiente. Um abort de
        // wall-clock/cost já emitiu /complete (acima) ⇒ o backend conciliou o
        // desfecho. Re-tentar via BullMQ (attempts:7 do producer) só re-roda
        // uma execução condenada a re-abortar. Logo:
        //   • ACK do job (RETURN, sem rethrow) ⇒ BullMQ marca success ⇒ ZERO
        //     retries. O replay por staff cunha um novo execution_id de
        //     qualquer forma — não dependemos de re-entrega da MESMA id.
        //   • RETER a dedup key (NÃO limpar) ⇒ qualquer re-entrega da mesma id
        //     bate no SET NX ⇒ return silencioso (§4.10), defesa em profundidade.
        // Erro NÃO-abort (genuinamente transiente, ex.: backend unreachable):
        // limpa a dedup key e RETHROW ⇒ attempts:7 do producer ainda aplica.
        if (abort) {
          return;
        }

        // C12 fix: erro transiente ⇒ limpar a dedup key permite retry legítimo
        // com o MESMO execution_id (o SET NX subsequente re-adquire a key).
        await ctx.redis.del(dedupKey).catch((delErr) => {
          logger.warn(
            { execution_id, delErr },
            "Failed to clear dedup key in error path; retries may be blocked until TTL expires",
          );
        });

        throw err;
      } finally {
        // Sprint C.2 — always close the publisher to drain the buffer.
        if (streamPublisher) {
          await streamPublisher.close().catch(() => {});
        }
      }
    },
  );
}
