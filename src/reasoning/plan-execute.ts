import type { AgentExecutionContext } from "../agents/execution-context.js";
import type { ToolDefinition } from "../tools/types.js";

import type {
  AgentResponse,
  Observation,
  Plan,
  PlanStep,
  ReasoningEngine,
  StepResult,
  ToolExecutor,
  TraceCallback,
} from "./engine.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PlanExecuteEngineConfig {
  /** Maximum number of steps to execute. Default: 15. */
  maxSteps?: number;
  /** Allow replanning when divergence exceeds threshold. Default: true. */
  allowReplan?: boolean;
  /**
   * Divergence score (0–1) above which a replan is triggered.
   * Default: 0.6.
   */
  replanThreshold?: number;
}

// ---------------------------------------------------------------------------
// PlanExecuteEngine
// ---------------------------------------------------------------------------

/**
 * Plan-first, sequential execution engine.
 *
 * 1. plan(): LLM generates a numbered list of steps.
 * 2. step(): Execute each step sequentially.
 * 3. observe(): Score divergence via lightweight LLM micro-call.
 * 4. shouldContinue(): If divergence > threshold and allowReplan, trigger replan.
 * 5. synthesize(): Build AgentResponse; escalated = true if replan occurred.
 */
export class PlanExecuteEngine implements ReasoningEngine {
  readonly strategy: AgentResponse["strategy"] = "plan-execute";

  private readonly maxSteps: number;
  private readonly allowReplan: boolean;
  private readonly replanThreshold: number;

  /** Tracks whether a replan has been triggered during this execution. */
  private replanOccurred = false;
  /**
   * Current divergence score from the last observe() call.
   *
   * NOTE: Prefer reading `observations[observations.length - 1].divergenceScore`
   * inside `shouldContinue()` rather than this instance field — instance
   * state is mutated by `_replan()` (reset to 0) and can become stale across
   * replan boundaries (audit ref: `a-reasoning-04`).
   */
  private lastDivergenceScore = 0;
  /** Internal flag set by shouldContinue() to trigger replan on next call. */
  private needsReplan = false;
  /**
   * Monotonic plan-revision counter. Stamped on the Plan returned by `plan()`
   * (always 0) and on every Observation produced by `observe()`. Incremented
   * inside `_replan()` so observations from the prior revision can be
   * filtered out in termination checks (audit ref: `a-reasoning-04`).
   */
  private currentPlanGeneration = 0;

  constructor(config: PlanExecuteEngineConfig = {}) {
    this.maxSteps = config.maxSteps ?? 15;
    this.allowReplan = config.allowReplan ?? true;
    this.replanThreshold = config.replanThreshold ?? 0.6;
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — plan()
  // -------------------------------------------------------------------------

  async plan(input: string, context: AgentExecutionContext): Promise<Plan> {
    const model = context.accountConfig?.llmModel ?? "gpt-4o-mini";

    const systemPrompt = `You are a planning assistant. Given a goal, produce a numbered list of steps to achieve it.
Return a JSON object with this shape:
{
  "steps": [
    { "index": 0, "description": "...", "toolName": "optional-tool-hint", "toolParams": {} },
    ...
  ]
}
Return ONLY the JSON. No markdown.`;

    const userPrompt = `Goal: ${input}\n\nProduce a step-by-step plan.`;

    try {
      const response = await context.llmClient.complete({
        model,
        system: systemPrompt,
        user: userPrompt,
        responseFormat: { type: "json_object" },
        maxTokens: 1024,
        doctrine: context.systemPrompt,
      });

      const parsed = JSON.parse(response.content) as { steps?: PlanStep[] };
      const steps = Array.isArray(parsed.steps) ? parsed.steps : [];

      if (steps.length === 0) {
        return this.fallbackPlan(input);
      }

      // Ensure indexes are normalised
      const normalisedSteps: PlanStep[] = steps.map((s, i) => ({
        ...s,
        index: i,
      }));

      return {
        goal: input,
        steps: normalisedSteps,
        estimatedComplexity: "high",
        generation: this.currentPlanGeneration,
      };
    } catch {
      return this.fallbackPlan(input);
    }
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
    const currentStep = plan.steps[stepIndex];

    if (!currentStep) {
      return {
        stepIndex,
        success: false,
        errorMessage: `Step ${stepIndex} not found in plan`,
        durationMs: Date.now() - startMs,
      };
    }

    const model = context.accountConfig?.llmModel ?? "gpt-4o-mini";
    const toolsDescription = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");

    const systemPrompt = `You are executing step ${stepIndex} of a plan.
Goal: ${plan.goal}

Full plan:
${plan.steps.map((s) => `${s.index}. ${s.description}${s.toolName ? ` [tool: ${s.toolName}]` : ""}`).join("\n")}

Available tools:
${toolsDescription}

Current step: ${currentStep.description}
${currentStep.toolName ? `Preferred tool: ${currentStep.toolName}` : ""}

Respond with a JSON object:
If calling a tool:
{ "thinking": "...", "toolName": "...", "toolParams": { ... } }
If answering directly:
{ "thinking": "...", "text": "..." }

Return ONLY the JSON.`;

    const userPrompt = `Execute step ${stepIndex}: ${currentStep.description}`;

    let toolName: string | undefined;
    let toolParams: unknown;
    let toolOutput: unknown;
    let thinkingTrace: string | undefined;
    let errorMessage: string | undefined;

    try {
      const response = await context.llmClient.complete({
        model,
        system: systemPrompt,
        user: userPrompt,
        responseFormat: { type: "json_object" },
        maxTokens: 1024,
        doctrine: context.systemPrompt,
      });

      const parsed = JSON.parse(response.content) as Record<string, unknown>;
      thinkingTrace = typeof parsed["thinking"] === "string" ? parsed["thinking"] : undefined;

      if (typeof parsed["toolName"] === "string") {
        toolName = parsed["toolName"];
        toolParams = parsed["toolParams"] ?? {};
        toolOutput = await executeTool(toolName, toolParams, context);
      } else {
        toolOutput = {
          text: typeof parsed["text"] === "string" ? parsed["text"] : response.content,
        };
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
      });
    }

    // Sprint C.2 — opt-in streaming hook.
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

  async observe(stepResult: StepResult, context: AgentExecutionContext): Promise<Observation> {
    // Compute divergence score via lightweight micro-call
    let divergenceScore = 0;

    if (stepResult.success) {
      divergenceScore = await this.scoreDivergence(stepResult, context);
    }

    this.lastDivergenceScore = divergenceScore;

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
      divergenceScore,
      planGeneration: this.currentPlanGeneration,
    };
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — shouldContinue()
  // -------------------------------------------------------------------------

  async shouldContinue(
    observations: Observation[],
    plan: Plan,
    context: AgentExecutionContext,
  ): Promise<boolean> {
    if (observations.length === 0) return true;

    const last = observations[observations.length - 1];

    // Stop if a stop-tool was called
    if (last.raw.toolName && ["send-message", "request-human"].includes(last.raw.toolName)) {
      return false;
    }

    // Stop if max steps reached.
    // NOTE: maxSteps counts cumulative work (intentional safety cap), not
    // per-plan-revision step count.
    if (observations.length >= this.maxSteps) return false;

    // Stop if all steps of the CURRENT plan revision are done.
    //
    // We count observations whose `planGeneration` matches the current plan
    // generation. This prevents the audit `a-reasoning-04` bug where
    // accumulated observations from a prior plan inflated the count and
    // either terminated too early or thrashed across replan boundaries.
    //
    // Fallback: if the plan has no `generation` (older callers) or the
    // observations are unstamped, behave like the legacy check
    // (length >= steps.length) so we don't regress non-replan callers.
    const planGeneration = plan.generation;
    const currentGenObservations =
      planGeneration === undefined
        ? observations
        : observations.filter(
            (o) => o.planGeneration === undefined || o.planGeneration === planGeneration,
          );

    if (currentGenObservations.length >= plan.steps.length) return false;

    // Check if replan is needed.
    //
    // Read divergence from the LAST OBSERVATION (which carries its own
    // divergenceScore stamped by observe()) rather than from
    // `this.lastDivergenceScore` instance state. The instance field is
    // reset to 0 inside `_replan()`, so reading it post-replan would always
    // be 0 and observations from later iterations would never re-trigger
    // a replan even if they diverged again (audit ref: `a-reasoning-04`).
    const lastDivergence = last.divergenceScore ?? this.lastDivergenceScore;
    if (this.allowReplan && lastDivergence > this.replanThreshold) {
      await this._replan(observations, plan, context);
      this.replanOccurred = true;
    }

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
    const lastSuccessful = [...observations].reverse().find((o) => o.success);
    const answer = lastSuccessful?.summary ?? observations[observations.length - 1]?.summary ?? "";

    return {
      answer,
      observations,
      totalSteps: observations.length,
      strategy: "plan-execute",
      escalated: this.replanOccurred,
      retriesUsed: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private fallbackPlan(input: string): Plan {
    return {
      goal: input,
      steps: [{ index: 0, description: "execute-goal-directly" }],
      estimatedComplexity: "low",
      generation: this.currentPlanGeneration,
    };
  }

  /**
   * Lightweight LLM micro-call to score divergence (0–1) between the step
   * description and its actual output.
   */
  private async scoreDivergence(
    stepResult: StepResult,
    context: AgentExecutionContext,
  ): Promise<number> {
    try {
      const model = context.accountConfig?.llmModel ?? "gpt-4o-mini";

      const response = await context.llmClient.complete({
        model,
        system:
          'You are a divergence scorer. Respond with ONLY a JSON object: { "score": <number 0 to 1> }. ' +
          "0 = result matches expectation exactly, 1 = completely diverged.",
        user:
          `Step description: "${stepResult.toolName ?? "direct answer"}"\n` +
          `Actual output: ${JSON.stringify(stepResult.toolOutput).slice(0, 300)}`,
        responseFormat: { type: "json_object" },
        maxTokens: 32,
        doctrine: context.systemPrompt,
      });

      const parsed = JSON.parse(response.content) as { score?: unknown };
      const score = Number(parsed.score);
      return isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Replans remaining steps using the LLM given the current observations.
   * Mutates plan.steps in-place, replacing steps after currentIndex.
   */
  private async _replan(
    observations: Observation[],
    plan: Plan,
    context: AgentExecutionContext,
  ): Promise<void> {
    const currentIndex = observations.length;
    const model = context.accountConfig?.llmModel ?? "gpt-4o-mini";

    const completedSummary = observations
      .map((o) => `Step ${o.stepIndex}: ${o.summary}`)
      .join("\n");

    const systemPrompt = `You are a re-planning assistant. Given the original goal, completed steps, and remaining steps, produce a revised plan for the remaining work.
Return JSON: { "steps": [{ "index": <number>, "description": "...", "toolName": "optional" }] }
Return ONLY the JSON.`;

    const userPrompt = `Original goal: ${plan.goal}

Completed steps (observations):
${completedSummary}

Remaining original steps:
${plan.steps
  .slice(currentIndex)
  .map((s) => `${s.index}. ${s.description}`)
  .join("\n")}

Produce revised remaining steps starting from index ${currentIndex}.`;

    try {
      const response = await context.llmClient.complete({
        model,
        system: systemPrompt,
        user: userPrompt,
        responseFormat: { type: "json_object" },
        maxTokens: 1024,
        doctrine: context.systemPrompt,
      });

      const parsed = JSON.parse(response.content) as { steps?: PlanStep[] };
      if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        const newSteps: PlanStep[] = parsed.steps.map((s, i) => ({
          ...s,
          index: currentIndex + i,
        }));
        plan.steps.splice(currentIndex, plan.steps.length - currentIndex, ...newSteps);
        // Bump plan generation so subsequent observations are stamped with
        // the new revision and the legacy `observations.length >=
        // plan.steps.length` check counts only the post-replan slice
        // (audit ref: `a-reasoning-04`).
        this.currentPlanGeneration += 1;
        plan.generation = this.currentPlanGeneration;
      }
    } catch {
      // If replan fails, keep original remaining steps — graceful degradation
    }
    this.lastDivergenceScore = 0;
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — reset() (optional)
  // -------------------------------------------------------------------------

  /**
   * Clears mutable instance state so the engine can be safely reused after
   * the harness escalates and produces a fresh plan revision. Called by
   * `execution-handler.runSurfaceAgentLoop()` immediately after a fresh
   * `engine.plan()` returns (audit ref: `a-reasoning-04`).
   *
   * Idempotent: safe to call multiple times. Leaves `currentPlanGeneration`
   * untouched (that counter spans the engine lifetime, not just one plan).
   */
  reset(): void {
    this.lastDivergenceScore = 0;
    this.replanOccurred = false;
    this.needsReplan = false;
  }
}
