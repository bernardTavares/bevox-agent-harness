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

export interface ReflexionWrapperConfig {
  /** The engine being wrapped. */
  inner: ReasoningEngine;
  /** Maximum retry attempts on step failure. Default: 2. */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// ReflexionWrapper
// ---------------------------------------------------------------------------

/**
 * Decorator that wraps any ReasoningEngine.
 *
 * On step failure:
 *  1. LLM micro-call evaluates the error and produces learnedContext.
 *  2. learnedContext is injected into the context's reflexionNotes.
 *  3. The step is retried up to maxRetries times with the enriched context.
 *  4. If still failing after maxRetries, the failed StepResult is propagated.
 */
export class ReflexionWrapper implements ReasoningEngine {
  private readonly inner: ReasoningEngine;
  private readonly maxRetries: number;
  private retriesUsed = 0;

  constructor(config: ReflexionWrapperConfig) {
    this.inner = config.inner;
    this.maxRetries = config.maxRetries ?? 2;
  }

  // -------------------------------------------------------------------------
  // Delegate — strategy
  // -------------------------------------------------------------------------

  get strategy(): AgentResponse["strategy"] {
    return this.inner.strategy;
  }

  // -------------------------------------------------------------------------
  // Delegate — plan(), observe(), shouldContinue()
  // -------------------------------------------------------------------------

  plan(input: string, context: AgentExecutionContext): Promise<Plan> {
    return this.inner.plan(input, context);
  }

  observe(stepResult: StepResult, context: AgentExecutionContext): Promise<Observation> {
    return this.inner.observe(stepResult, context);
  }

  shouldContinue(
    observations: Observation[],
    plan: Plan,
    context: AgentExecutionContext,
  ): Promise<boolean> {
    return this.inner.shouldContinue(observations, plan, context);
  }

  // -------------------------------------------------------------------------
  // Override — synthesize() injects retriesUsed
  // -------------------------------------------------------------------------

  async synthesize(
    observations: Observation[],
    plan: Plan,
    context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    const response = await this.inner.synthesize(observations, plan, context);
    return { ...response, retriesUsed: this.retriesUsed };
  }

  // -------------------------------------------------------------------------
  // Override — step() with retry-on-failure + reflexion
  // -------------------------------------------------------------------------

  async step(
    plan: Plan,
    stepIndex: number,
    tools: ToolDefinition[],
    context: AgentExecutionContext,
    executeTool: ToolExecutor,
    traceCallback?: TraceCallback,
  ): Promise<StepResult> {
    // First attempt
    let result = await this.tryStep(plan, stepIndex, tools, context, executeTool, traceCallback);

    if (result.success) return result;

    // Reflexion retry loop
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const learnedContext = await this._evaluateFailure(result, context);

      // Inject learned context into reflexionNotes
      const augmented = this.augmentContext(context, learnedContext);

      result = await this.tryStep(plan, stepIndex, tools, augmented, executeTool, traceCallback);
      this.retriesUsed++;

      if (result.success) return result;
    }

    // Exhausted retries — return the final failed result with full error info
    return {
      ...result,
      errorMessage: `[ReflexionWrapper] Failed after ${this.maxRetries} retries. Last error: ${result.errorMessage ?? "unknown"}`,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async tryStep(
    plan: Plan,
    stepIndex: number,
    tools: ToolDefinition[],
    context: AgentExecutionContext,
    executeTool: ToolExecutor,
    traceCallback?: TraceCallback,
  ): Promise<StepResult> {
    try {
      return await this.inner.step(plan, stepIndex, tools, context, executeTool, traceCallback);
    } catch (err) {
      return {
        stepIndex,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: 0,
      };
    }
  }

  /**
   * LLM micro-call: evaluates the failure and returns a learnedContext string.
   */
  private async _evaluateFailure(
    stepResult: StepResult,
    context: AgentExecutionContext,
  ): Promise<string> {
    const model = context.accountConfig?.llmModel ?? "gpt-4o-mini";

    try {
      const response = await context.llmClient.complete({
        model,
        system:
          "You are a failure analyst. A step in an agentic workflow failed. " +
          "Briefly explain what went wrong and how to fix it. " +
          'Return JSON: { "learnedContext": "<brief actionable fix>" }',
        user:
          `Step ${stepResult.stepIndex} failed.\n` +
          `Tool: ${stepResult.toolName ?? "none"}\n` +
          `Error: ${stepResult.errorMessage ?? "unknown"}\n` +
          `Output: ${JSON.stringify(stepResult.toolOutput).slice(0, 300)}`,
        responseFormat: { type: "json_object" },
        maxTokens: 128,
      });

      const parsed = JSON.parse(response.content) as { learnedContext?: unknown };
      return typeof parsed.learnedContext === "string"
        ? parsed.learnedContext
        : `Step ${stepResult.stepIndex} failed: ${stepResult.errorMessage ?? "unknown error"}`;
    } catch {
      return `Step ${stepResult.stepIndex} failed: ${stepResult.errorMessage ?? "unknown error"}`;
    }
  }

  /**
   * Returns a shallow copy of the context with the learned context appended
   * to reflexionNotes. Does not mutate the original context.
   */
  private augmentContext(
    context: AgentExecutionContext,
    learnedContext: string,
  ): AgentExecutionContext {
    // a-reasoning-01 — `reflexionNotes` agora é tipado em
    // AgentExecutionContext, então o cast inseguro (`as unknown as object`)
    // some. Cópia rasa: o original NÃO é mutado (coberto pelo teste
    // "no mutation of original").
    const existingNotes = context.reflexionNotes ?? [];
    return {
      ...context,
      reflexionNotes: [...existingNotes, learnedContext],
    };
  }
}
