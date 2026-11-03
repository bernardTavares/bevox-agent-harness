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

export interface DirectEngineConfig {
  /**
   * JSON schema describing the expected output shape.
   * Passed to the LLM as response format hint and used for documentation.
   * Validation is left to the caller.
   */
  outputSchema?: Record<string, unknown>;
  /** Override the model for this engine; falls back to context.accountConfig.llmModel. */
  modelOverride?: string;
  /** System prompt to use. If omitted a generic JSON-extraction prompt is used. */
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// DirectEngine
// ---------------------------------------------------------------------------

/**
 * Single LLM call with structured JSON output.
 *
 * Designed for pipeline agents (MessageAnalyzerAgent, MemoryExtractorAgent)
 * that do NOT need a tool loop. The plan / step / observe / shouldContinue
 * methods are trivial stubs; only synthesize() does real work.
 */
export class DirectEngine implements ReasoningEngine {
  readonly strategy: AgentResponse["strategy"] = "direct";

  private readonly config: Required<Pick<DirectEngineConfig, "modelOverride" | "systemPrompt">> & {
    outputSchema?: Record<string, unknown>;
  };

  constructor(config: DirectEngineConfig = {}) {
    this.config = {
      modelOverride: config.modelOverride ?? "",
      systemPrompt:
        config.systemPrompt ??
        "You are a structured-output assistant. Return ONLY valid JSON. No markdown, no explanation.",
      outputSchema: config.outputSchema,
    };
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — plan()
  // -------------------------------------------------------------------------

  async plan(input: string, _context: AgentExecutionContext): Promise<Plan> {
    return {
      goal: input,
      steps: [{ index: 0, description: "direct-llm-call" }],
      estimatedComplexity: "low",
    };
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — step()
  // -------------------------------------------------------------------------

  async step(
    plan: Plan,
    stepIndex: number,
    _tools: ToolDefinition[],
    context: AgentExecutionContext,
    _executeTool: ToolExecutor,
    traceCallback?: TraceCallback,
  ): Promise<StepResult> {
    const startMs = Date.now();

    const model = this.config.modelOverride || context.accountConfig?.llmModel || "gpt-4o-mini";

    let toolOutput: unknown;
    let errorMessage: string | undefined;

    try {
      const response = await context.llmClient.complete({
        model,
        system: this.config.systemPrompt,
        user: plan.goal,
        responseFormat: { type: "json_object" },
        doctrine: context.systemPrompt,
      });

      // Parse JSON; fall back to raw string if not valid JSON
      try {
        toolOutput = JSON.parse(response.content);
      } catch {
        toolOutput = response.content;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const result: StepResult = {
      stepIndex,
      success: errorMessage === undefined,
      toolOutput,
      errorMessage,
      durationMs: Date.now() - startMs,
    };

    if (traceCallback) {
      const obs = await this.observe(result, context);
      traceCallback({
        engineStrategy: this.strategy,
        stepIndex,
        stepResult: result,
        observation: obs,
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — observe()
  // -------------------------------------------------------------------------

  async observe(stepResult: StepResult, _context: AgentExecutionContext): Promise<Observation> {
    return {
      stepIndex: stepResult.stepIndex,
      summary: JSON.stringify(stepResult.toolOutput),
      success: stepResult.success,
      raw: stepResult,
    };
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — shouldContinue()
  // -------------------------------------------------------------------------

  async shouldContinue(
    _observations: Observation[],
    _plan: Plan,
    _context: AgentExecutionContext,
  ): Promise<boolean> {
    // DirectEngine never loops
    return false;
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — synthesize()
  // -------------------------------------------------------------------------

  async synthesize(
    observations: Observation[],
    _plan: Plan,
    _context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    const first = observations[0];
    return {
      answer: first?.summary ?? "",
      observations,
      totalSteps: 1,
      strategy: "direct",
      escalated: false,
      retriesUsed: 0,
    };
  }
}
