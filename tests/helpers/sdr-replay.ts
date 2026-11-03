/**
 * SDR Fixture-Replay Helper — Fase A §4.3
 *
 * Runs the real surface-agent path (handleExecution) against a scenario
 * fixture using a pre-configured FakeLLMGateway, then returns the produced
 * output and the resolved system prompt that the gateway received.
 *
 * This is TEST INFRA ONLY — no src/ code is modified.
 *
 * Design:
 *  - The caller (test file) sets up vi.mock for bevox-callback and
 *    llm-gateway at the module level. The helper receives the already-mocked
 *    sendComplete spy so it can extract the final response text.
 *  - resolvedSystemPrompt is read from gateway.calls using an EXPLICIT,
 *    content-based invariant (NOT positional slicing):
 *
 *    LlmClientBridge.complete (execution-handler.ts) emits messages as:
 *      [ ...(req.doctrine ? [{role:"system", content: req.doctrine}] : []),
 *        {role:"system", content: req.system},   // engine's own prompt
 *        {role:"user",   content: req.user} ]
 *
 *    The doctrine message is identified by content, not by index:
 *      - SDR ENABLED:  exactly one system message must contain SDR_DOCTRINE_MARKER;
 *                      that message's content is returned. If missing → throw.
 *      - SDR DISABLED: NO system message may contain SDR_DOCTRINE_MARKER;
 *                      if one does → throw loudly (prevents zero-cost gate
 *                      passing for the wrong reason). The doctrine message is
 *                      identified as the system message whose content equals
 *                      the base agent_config.system_prompt.
 *
 *    Robustness invariant: the helper asserts the expected number of system
 *    messages (2 when doctrine is present, ≥1 otherwise). Any future Phase B
 *    reordering or extra system message insertion will trip a loud assertion
 *    rather than silently extracting the wrong string.
 */

import type { Pool } from "pg";
import type IORedis from "ioredis";
import type { MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// Doctrine marker — canonical string that identifies the SDR doctrine system
// message. Must match the heading in src/sdr/doctrine.ts SDR_DOCTRINE.
// If the doctrine text is refactored, this constant must be updated together.
// ---------------------------------------------------------------------------

/**
 * Canonical marker that identifies an SDR doctrine system message.
 * Used for content-based (not positional) extraction of resolvedSystemPrompt.
 */
export const SDR_DOCTRINE_MARKER = "## DOUTRINA SDR";

import { AgentRegistry } from "../../src/agents/registry.js";
import { UnifiedToolRegistry } from "../../src/tools/unified-registry.js";
import { createAgentRouter } from "../../src/runtime/agent-router.js";
import { BaseAgent } from "../../src/agents/base-agent.js";
import type { AgentResult } from "../../src/agents/types.js";
import type { AgentExecutionContext } from "../../src/agents/execution-context.js";
import type { ExecutionContext } from "../../src/runtime/execution-handler.js";
import { handleExecution } from "../../src/runtime/execution-handler.js";
import { FakeLLMGateway } from "../fakes/llm-gateway.fake.js";
import type { LLMResponse } from "../../src/integration/llm-gateway.js";

// ---------------------------------------------------------------------------
// Scenario fixture type
// ---------------------------------------------------------------------------

export interface SdrScenarioMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SdrScenarioLlmResponse {
  content: string;
  tool_calls: [];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  model: string;
  provider: string;
  latency_ms: number;
}

export interface SdrScenario {
  id: string;
  description: string;
  agent_config: Record<string, unknown>;
  messages: SdrScenarioMessage[];
  /** Sequential scripted responses for the surface-agent LLM calls. */
  llm_responses: SdrScenarioLlmResponse[];
  /** Optional scripted judge response for prospect-ready scorer (separate gateway). */
  judge_response?: SdrScenarioLlmResponse;
}

// ---------------------------------------------------------------------------
// Replay result
// ---------------------------------------------------------------------------

export interface SdrReplayResult {
  /** The last user message content (what the surface agent received as input). */
  input: string;
  /** The agent's final output text (agentResponse.answer from sendComplete). */
  output: string;
  /**
   * The resolved system prompt delivered to the gateway as the doctrine message.
   * For sdr_profile.enabled=true: base + SDR_DOCTRINE.
   * For no sdr_profile: exactly the input agent_config.system_prompt.
   */
  resolvedSystemPrompt: string;
}

// ---------------------------------------------------------------------------
// Stub agents — minimal, no llmClient calls
// ---------------------------------------------------------------------------

/**
 * Stub pipeline analyzer. Returns intent "unknown" so the default route table
 * dispatches to the surface agent named "scheduler" (which has a route rule
 * for "unknown" intent — see agent-router.ts DEFAULT_ROUTE_RULES).
 */
class SdrStubAnalyzer extends BaseAgent {
  constructor() {
    super({
      name: "message-analyzer",
      type: "pipeline",
      description: "stub analyzer for sdr replay",
      reasoning: { default: "direct" },
      permissions: { required: [], denied: [] },
    });
  }

  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return {
      success: true,
      output: {
        intent: "unknown",
        sentiment: "neutral",
        sentimentConfidence: 0.8,
        topics: [],
        urgency: "low",
      },
    };
  }
}

/**
 * Stub surface agent with react reasoning.
 * Named "scheduler" so the default route table (intent:"unknown" → "scheduler")
 * dispatches here without any src/ changes.
 * The real ReAct engine calls FakeLLMGateway to produce the scripted SDR output.
 */
class SdrSurfaceAgent extends BaseAgent {
  constructor() {
    super({
      name: "scheduler",
      type: "surface",
      description: "SDR surface agent for certification replay",
      reasoning: { default: "react" },
      permissions: { required: [], denied: [] },
    });
  }

  // BaseAgent.execute is called by the registry but the execution-handler
  // calls runSurfaceAgentLoop directly with the agentDef — so this is never
  // reached in the integration path. Provided for safety.
  async execute(_ctx: AgentExecutionContext): Promise<AgentResult> {
    return { success: true, output: "sdr-surface-stub" };
  }
}

// ---------------------------------------------------------------------------
// Replay helper
// ---------------------------------------------------------------------------

/**
 * Runs `handleExecution` with the given scenario fixture using a real
 * Postgres + Redis (provided by the test's integration setup), captures the
 * produced output and resolved system prompt, and returns them.
 *
 * @param scenario   Parsed fixture JSON.
 * @param pool       Real Postgres pool (from setupInfra).
 * @param redis      Real IORedis client (from setupInfra).
 * @param gatewayMock The vi.mock hoisted stub for `createLLMGateway` — the
 *                   helper installs a fresh FakeLLMGateway for each replay.
 * @param sendCompleteMock The vi.mock spy on `sendComplete` — used to
 *                   extract the final agent response text.
 * @param executionId Unique UUID for this replay run.
 * @param opts.assertFsmKeywords  When true, additionally asserts that the
 *                               doctrine system message (the one containing
 *                               SDR_DOCTRINE_MARKER) also contains the FSM
 *                               STATE section keywords — use in Model-C/cadence
 *                               replay scenarios where the FSM projection was
 *                               appended to the composed prompt string (C.7).
 *                               The system-message COUNT invariant stays 2
 *                               regardless — FSM is in the same string.
 */
export async function replaySdrScenario(
  scenario: SdrScenario,
  pool: Pool,
  redis: IORedis,
  gatewayMock: { createLLMGateway: MockInstance },
  sendCompleteMock: MockInstance,
  executionId: string,
  opts: { assertFsmKeywords?: boolean } = {},
): Promise<SdrReplayResult> {
  // Build scripted surface-agent responses
  const surfaceResponses: LLMResponse[] = scenario.llm_responses.map((r) => ({
    content: r.content,
    tool_calls: [],
    usage: r.usage,
    model: r.model,
    provider: r.provider,
    latency_ms: r.latency_ms,
  }));

  const fakeGateway = new FakeLLMGateway({ responses: surfaceResponses });
  gatewayMock.createLLMGateway.mockReturnValue(fakeGateway);

  // Reset singletons to avoid cross-test contamination
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (AgentRegistry as any).instance = undefined;
  UnifiedToolRegistry.resetForTests();

  const agentRegistry = AgentRegistry.getInstance();
  const toolRegistry = UnifiedToolRegistry.getInstance();

  agentRegistry.register(new SdrStubAnalyzer());
  agentRegistry.register(new SdrSurfaceAgent());

  // Custom router: always route to sdr-surface
  const agentRouter = createAgentRouter();

  const ctx: ExecutionContext = {
    db: pool,
    redis,
    agentRegistry,
    toolRegistry,
    agentRouter,
  };

  // Clear the sendComplete spy call history for this run
  sendCompleteMock.mockClear();

  await handleExecution(
    {
      execution_id: executionId,
      execution_token: "replay-token-1234567890abcdef",
      organization_id: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
      messages: scenario.messages,
      agent_config: scenario.agent_config,
    },
    ctx,
  );

  // Extract final agent output from sendComplete call
  // sendComplete is called as: sendComplete(execution_id, token, { response, ... })
  const sendCompleteCall = sendCompleteMock.mock.calls[0];
  if (!sendCompleteCall) {
    throw new Error(
      `[sdr-replay] sendComplete was not called for scenario "${scenario.id}". ` +
        `The execution may have failed or been deduplicated.`,
    );
  }
  const completePayload = sendCompleteCall[2] as { response_text: string };
  const rawOutput: string = completePayload.response_text ?? "";

  // Parse the agent output: ReAct engine wraps the text in JSON
  // observation summary format: JSON.stringify({ text: "..." })
  // We unwrap it to get the plain SDR message text.
  let output = rawOutput;
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    if (typeof parsed["text"] === "string") {
      output = parsed["text"];
    }
  } catch {
    // rawOutput is not JSON — use as-is (direct engine path)
  }

  // ---------------------------------------------------------------------------
  // HARDENED resolvedSystemPrompt extraction (Fase A review §Important #2)
  //
  // Contract: identify the doctrine system message by CONTENT, not position.
  //
  // LlmClientBridge.complete emits messages in this order:
  //   [0] ...(req.doctrine ? [{role:"system", content: req.doctrine}] : [])
  //   [n] {role:"system", content: req.system}   — engine's own prompt
  //   [-] {role:"user",   content: req.user}
  //
  // When req.doctrine is non-empty (always true when agent_config.system_prompt
  // is non-empty), there are EXACTLY 2 system messages: doctrine + engine's own.
  //
  // The doctrine message is the one containing SDR_DOCTRINE_MARKER when SDR is
  // enabled, or the one whose content equals the base system_prompt when SDR is
  // disabled. Both cases assert invariants so any future reordering or extra
  // system message trips a loud failure instead of a silent wrong extraction.
  // ---------------------------------------------------------------------------
  let resolvedSystemPrompt = "";
  if (fakeGateway.calls.length > 0) {
    const firstCall = fakeGateway.calls[0];
    const systemMessages = firstCall.messages.filter((m) => m.role === "system");

    // Determine whether this scenario has SDR enabled
    const sdrProfile = scenario.agent_config["sdr_profile"];
    const sdrEnabled =
      sdrProfile !== null &&
      sdrProfile !== undefined &&
      typeof sdrProfile === "object" &&
      (sdrProfile as Record<string, unknown>)["enabled"] === true;

    if (sdrEnabled) {
      // --- SDR ENABLED invariant ---
      // The doctrine message must contain the SDR marker.
      // Assert exactly 2 system messages (doctrine + engine); fail loudly if not.
      if (systemMessages.length !== 2) {
        throw new Error(
          `[sdr-replay] SDR-enabled scenario "${scenario.id}": expected exactly 2 system ` +
            `messages (doctrine + engine prompt) but got ${systemMessages.length}. ` +
            `This indicates a message-ordering change in LlmClientBridge that breaks ` +
            `the doctrine extraction invariant. Update sdr-replay.ts to match.`,
        );
      }
      // Find the doctrine message by content marker — not by index.
      const doctrineMsg = systemMessages.find((m) =>
        m.content.includes(SDR_DOCTRINE_MARKER),
      );
      if (!doctrineMsg) {
        throw new Error(
          `[sdr-replay] SDR-enabled scenario "${scenario.id}": no system message contains ` +
            `the doctrine marker "${SDR_DOCTRINE_MARKER}". ` +
            `composeSystemPrompt may not have been called or the marker text changed.`,
        );
      }
      resolvedSystemPrompt = doctrineMsg.content;

      // C.7 — optional FSM-state content assertion (Model-C/cadence context).
      // When assertFsmKeywords=true, verify the doctrine message (same string,
      // NOT a new system message) also contains the FSM STATE section keywords.
      // The count stays 2 — FSM is APPENDED to the composed prompt string.
      if (opts.assertFsmKeywords) {
        if (!doctrineMsg.content.includes("FSM STATE")) {
          throw new Error(
            `[sdr-replay] SDR-enabled scenario "${scenario.id}" (assertFsmKeywords=true): ` +
              `the doctrine system message does not contain "FSM STATE". ` +
              `The FSM projection was not appended by _dispatchModelCImpl / composeSystemPrompt. ` +
              `Check C.7 implementation in execution-handler.ts.`,
          );
        }
        if (!doctrineMsg.content.includes("account-status")) {
          throw new Error(
            `[sdr-replay] SDR-enabled scenario "${scenario.id}" (assertFsmKeywords=true): ` +
              `the doctrine system message does not contain "account-status". ` +
              `The FSM projection fields are missing. Check buildFsmProjection in execution-handler.ts.`,
          );
        }
      }
    } else {
      // --- SDR DISABLED invariant ---
      // NO system message may contain the SDR marker (zero-cost gate protection).
      // If one does, the composeSystemPrompt gate is broken — fail loudly so the
      // zero-cost gate cannot pass for the wrong reason.
      const unexpectedDoctrineMsg = systemMessages.find((m) =>
        m.content.includes(SDR_DOCTRINE_MARKER),
      );
      if (unexpectedDoctrineMsg) {
        throw new Error(
          `[sdr-replay] SDR-DISABLED scenario "${scenario.id}": a system message contains ` +
            `the doctrine marker "${SDR_DOCTRINE_MARKER}" even though sdr_profile is absent ` +
            `or disabled. The zero-cost gate §4.4 would pass for the wrong reason. ` +
            `Check composeSystemPrompt and sdr_profile parsing in execution-handler.ts.`,
        );
      }
      // When systemPrompt (base) is non-empty, doctrine = base is prepended and
      // there are 2 system messages. Identify the doctrine message as the one
      // whose content equals the base agent_config.system_prompt.
      const baseSystemPrompt =
        typeof scenario.agent_config["system_prompt"] === "string"
          ? scenario.agent_config["system_prompt"]
          : "";
      if (baseSystemPrompt && systemMessages.length >= 2) {
        // Assert exactly 2 system messages for a non-empty base (doctrine=base + engine own).
        if (systemMessages.length !== 2) {
          throw new Error(
            `[sdr-replay] SDR-disabled scenario "${scenario.id}" with non-empty base: ` +
              `expected exactly 2 system messages (base-doctrine + engine prompt) but got ` +
              `${systemMessages.length}. A message-ordering change in LlmClientBridge ` +
              `may have broken the extraction invariant.`,
          );
        }
        // Doctrine message is the one matching the base system prompt exactly.
        const doctrineMsg = systemMessages.find((m) => m.content === baseSystemPrompt);
        if (!doctrineMsg) {
          throw new Error(
            `[sdr-replay] SDR-disabled scenario "${scenario.id}": no system message ` +
              `content matches the expected base system_prompt exactly. ` +
              `The extraction invariant is broken — check LlmClientBridge.complete ordering.`,
          );
        }
        resolvedSystemPrompt = doctrineMsg.content;
      } else if (!baseSystemPrompt && systemMessages.length >= 1) {
        // Empty base: req.doctrine is falsy, no doctrine message emitted.
        // Engine-only system message present; resolvedSystemPrompt = "" (no doctrine).
        resolvedSystemPrompt = "";
      }
      // else: no system messages at all — resolvedSystemPrompt stays "".
    }
  }

  const lastUserMessage =
    [...scenario.messages].reverse().find((m) => m.role === "user")?.content ?? "";

  return {
    input: lastUserMessage,
    output,
    resolvedSystemPrompt,
  };
}

/**
 * Builds a fresh FakeLLMGateway pre-loaded with a single judge response.
 * Used by the test to supply the gateway for prospect-ready scoring
 * separately from the surface-agent gateway.
 */
export function buildJudgeGateway(scenario: SdrScenario): FakeLLMGateway {
  if (!scenario.judge_response) {
    throw new Error(
      `[sdr-replay] Scenario "${scenario.id}" has no judge_response — ` +
        `cannot build a judge gateway for prospect-ready scoring.`,
    );
  }
  const judgeResp = scenario.judge_response;
  return new FakeLLMGateway({
    responses: [
      {
        content: judgeResp.content,
        tool_calls: [],
        usage: judgeResp.usage,
        model: judgeResp.model,
        provider: judgeResp.provider,
        latency_ms: judgeResp.latency_ms,
      },
    ],
  });
}
