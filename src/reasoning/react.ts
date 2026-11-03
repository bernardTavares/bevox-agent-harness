import type { AgentExecutionContext } from "../agents/execution-context.js";
import type { ToolDefinition } from "../tools/types.js";

import type {
  AgentResponse,
  Observation,
  Plan,
  ReasoningEngine,
  StepResult,
  ToolExecutor,
  TraceCallback,
} from "./engine.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ReactEngineConfig {
  /** Maximum number of think-act-observe iterations. Default: 10. */
  maxSteps?: number;
  /** Tool names that signal the end of execution. Default: ['send-message', 'request-human']. */
  stopTools?: string[];
}

// ---------------------------------------------------------------------------
// Internal message shape for LLM conversation history
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// ReactEngine
// ---------------------------------------------------------------------------

/**
 * Classic ReAct loop: think → act (tool call) → observe → repeat.
 * The LLM decides which tool to call each iteration.
 * Stops when a stop-tool is called, maxSteps is reached, or LLM returns text.
 */
export class ReactEngine implements ReasoningEngine {
  readonly strategy: AgentResponse["strategy"] = "react";

  private readonly maxSteps: number;
  private readonly stopTools: string[];

  constructor(config: ReactEngineConfig = {}) {
    this.maxSteps = config.maxSteps ?? 10;
    this.stopTools = config.stopTools ?? ["send-message", "request-human"];
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — plan()
  // -------------------------------------------------------------------------

  async plan(input: string, _context: AgentExecutionContext): Promise<Plan> {
    return {
      goal: input,
      steps: [{ index: 0, description: "react-loop" }],
      estimatedComplexity: "low",
    };
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — step()
  // -------------------------------------------------------------------------

  async step(
    plan: Plan,
    stepIndex: number,
    tools: ToolDefinition[],
    context: AgentExecutionContext,
    executeTool: ToolExecutor,
    traceCallback?: TraceCallback,
  ): Promise<StepResult> {
    const startMs = Date.now();

    const model = context.accountConfig?.llmModel ?? "gpt-4o-mini";

    // Build tool-list description for the prompt
    const toolsDescription = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");

    const systemPrompt = this.buildSystemPrompt(plan.goal, toolsDescription);

    // Build conversation: show previously accumulated observations as context
    // We pass the goal as the user turn; the LLM must choose a tool or respond
    const userContent = this.buildUserContent(plan, stepIndex);

    let toolName: string | undefined;
    let toolParams: unknown;
    let toolOutput: unknown;
    let thinkingTrace: string | undefined;
    let errorMessage: string | undefined;

    // a-reasoning-01 — injeta as notas de reflexão (se houver) na doctrine do
    // retry. Sem notas → byte-idêntico (doctrine = systemPrompt puro). A
    // doctrine vira system message LÍDER no LlmClientBridge, então o retry
    // NÃO é mais idêntico ao 1º attempt.
    const reflexionPreamble =
      context.reflexionNotes && context.reflexionNotes.length > 0
        ? `Prior attempt(s) failed. Apply these lessons:\n${context.reflexionNotes
            .map((n, i) => `${i + 1}. ${n}`)
            .join("\n")}\n\n`
        : "";
    const doctrine = reflexionPreamble
      ? `${reflexionPreamble}${context.systemPrompt ?? ""}`
      : context.systemPrompt;

    try {
      const response = await context.llmClient.complete({
        model,
        system: systemPrompt,
        user: userContent,
        responseFormat: { type: "json_object" },
        maxTokens: 1024,
        doctrine,
      });

      // Parse the structured action from the LLM
      const parsed = this.parseAction(response.content);
      thinkingTrace = parsed.thinking;

      if (parsed.toolName) {
        toolName = parsed.toolName;
        toolParams = parsed.toolParams ?? {};

        // Execute via callback
        toolOutput = await executeTool(toolName, toolParams, context);
      } else {
        // LLM returned a plain text answer — treat as final answer
        toolOutput = { text: parsed.text ?? response.content };
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const result: StepResult = {
      stepIndex,
      success: errorMessage === undefined,
      toolName,
      toolParams,
      toolOutput,
      errorMessage,
      thinkingTrace,
      durationMs: Date.now() - startMs,
    };

    if (traceCallback) {
      const obs = await this.observe(result, context);
      traceCallback({
        engineStrategy: this.strategy,
        stepIndex,
        stepResult: result,
        observation: obs,
        resolvedSystemPrompt: context.systemPrompt,
      });
    }

    // Sprint C.2 — opt-in streaming hook. Failure here MUST NOT propagate.
    if (context.streamCallback) {
      try {
        await context.streamCallback({
          type: "reasoning_step",
          payload: {
            strategy: this.strategy,
            stepIndex,
            summary: (thinkingTrace ?? "").slice(0, 200),
          },
        });
      } catch {
        // streaming is best-effort
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — observe()
  // -------------------------------------------------------------------------

  async observe(stepResult: StepResult, _context: AgentExecutionContext): Promise<Observation> {
    const stopSignal =
      stepResult.toolName !== undefined && this.stopTools.includes(stepResult.toolName);

    const summary = stepResult.errorMessage
      ? `[Error] ${stepResult.errorMessage}`
      : typeof stepResult.toolOutput === "object"
        ? JSON.stringify(stepResult.toolOutput)
        : String(stepResult.toolOutput ?? "");

    return {
      stepIndex: stepResult.stepIndex,
      summary,
      success: stepResult.success,
      raw: stepResult,
      stopSignal,
    };
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — shouldContinue()
  // -------------------------------------------------------------------------

  async shouldContinue(
    observations: Observation[],
    _plan: Plan,
    _context: AgentExecutionContext,
  ): Promise<boolean> {
    if (observations.length === 0) return true;

    const last = observations[observations.length - 1];

    // Stop if a stop-tool was called
    if (last.stopSignal) return false;

    // Stop if max steps reached
    if (observations.length >= this.maxSteps) return false;

    // Stop if last step had no tool call (plain text answer)
    if (!last.raw.toolName) return false;

    return true;
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — synthesize()
  // -------------------------------------------------------------------------

  async synthesize(
    observations: Observation[],
    _plan: Plan,
    _context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    // Find the best final answer: last stop-signal observation, or last successful
    const stopObs = [...observations].reverse().find((o) => o.stopSignal);
    const lastSuccessful = [...observations].reverse().find((o) => o.success);
    const final = stopObs ?? lastSuccessful ?? observations[observations.length - 1];

    // STOP tools (send-message, request-human) emitem `data.{message,reason}`
    // que deve virar o `response_text` do `/complete`. Sem isto, o handler
    // mandaria o envelope JSON cru (`'{"sent":true,"message":"..."}'`) ao
    // backend, corrompendo a resposta visível ao cliente — auditoria
    // CRÍT #6. `summary` é o fallback para tools não-STOP (que não
    // declaram um campo message canônico).
    let answer = "";
    // `resolved` marca que uma STOP tool já forneceu o response_text canônico
    // (inclusive o handoff vazio do request-human). Sem este flag, o fallback
    // `final.summary` abaixo sobrescreveria o "" deliberado do handoff com o
    // envelope JSON cru — §2.1.
    let resolved = false;
    if (stopObs && stopObs.raw && typeof stopObs.raw === "object") {
      const out = (stopObs.raw as { toolOutput?: unknown }).toolOutput;
      if (out && typeof out === "object") {
        // O executor entrega o ToolResult COMPLETO `{success, data}`; os
        // campos canônicos das STOP tools (message/handoff/proposal) ficam
        // sob `.data`. Tolera também o shape desembrulhado (mocks legados)
        // via `?? out`. Sem isto, `response_text` saía como envelope JSON
        // cru — auditoria CRÍT #6 / §2.1.
        const payload = ((out as { data?: unknown }).data ?? out) as {
          message?: unknown;
          handoff?: unknown;
          proposal?: { params?: { message?: unknown } };
        };
        if (typeof payload.message === "string" && payload.message.length > 0) {
          answer = payload.message; // send-message executado (autonomous)
          resolved = true;
        } else if (payload.handoff === true) {
          answer = ""; // request-human → response_text vazio (semântica no strategy)
          resolved = true;
        } else if (typeof payload.proposal?.params?.message === "string") {
          answer = payload.proposal.params.message; // send-message PROPOSTO (draft)
          resolved = true;
        }
      }
    }
    if (!resolved && !answer) answer = final?.summary ?? "";

    return {
      answer,
      observations,
      totalSteps: observations.length,
      strategy: "react",
      escalated: false,
      retriesUsed: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildSystemPrompt(goal: string, toolsDescription: string): string {
    return `You are an autonomous agent executing the following goal:
${goal}

Available tools:
${toolsDescription}

Respond with a JSON object in one of these two formats:

If you want to call a tool:
{
  "thinking": "<your chain-of-thought>",
  "toolName": "<tool_name>",
  "toolParams": { ... }
}

If you have a final answer (no more tools needed):
{
  "thinking": "<your chain-of-thought>",
  "text": "<your final answer>"
}

Return ONLY the JSON object. No markdown.`;
  }

  private buildUserContent(_plan: Plan, stepIndex: number): string {
    return `Step ${stepIndex}: continue executing the goal. Choose the next action.`;
  }

  private parseAction(content: string): {
    thinking?: string;
    toolName?: string;
    toolParams?: unknown;
    text?: string;
  } {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return {
        thinking: typeof parsed["thinking"] === "string" ? parsed["thinking"] : undefined,
        toolName: typeof parsed["toolName"] === "string" ? parsed["toolName"] : undefined,
        toolParams: parsed["toolParams"],
        text: typeof parsed["text"] === "string" ? parsed["text"] : undefined,
      };
    } catch {
      // If parse fails, treat entire content as plain text answer
      return { text: content };
    }
  }
}

// Export ChatMessage for potential re-use in other engines
export type { ChatMessage };
