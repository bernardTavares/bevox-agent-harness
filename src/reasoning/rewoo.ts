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

export interface ReWOOEngineConfig {
  /** Maximum concurrent tool calls per execution wave. Default: 5. */
  maxParallel?: number;
}

// ---------------------------------------------------------------------------
// ReWOOEngine
// @experimental — not default for any agent
// ---------------------------------------------------------------------------

/**
 * @experimental
 *
 * ReWOO (Reasoning Without Observation) engine.
 *
 * Plans all steps upfront with dependency annotations, then executes
 * independent steps in parallel waves. Dependent steps wait for their
 * prerequisites before executing.
 *
 * Not selected by default for any agent. Activate via:
 *   reasoning: { default: 'rewoo' }
 */
export class ReWOOEngine implements ReasoningEngine {
  readonly strategy: AgentResponse["strategy"] = "rewoo";

  private readonly maxParallel: number;

  constructor(config: ReWOOEngineConfig = {}) {
    this.maxParallel = config.maxParallel ?? 5;
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — plan()
  // -------------------------------------------------------------------------

  async plan(input: string, context: AgentExecutionContext): Promise<Plan> {
    const model = context.accountConfig?.llmModel ?? "gpt-4o-mini";

    const systemPrompt = `You are a parallel planning assistant. Given a goal, produce a plan where each step has an optional "dependsOn" array listing the indexes of steps that MUST complete before this one.
Return a JSON object:
{
  "steps": [
    { "index": 0, "description": "...", "toolName": "optional", "dependsOn": [] },
    { "index": 1, "description": "...", "toolName": "optional", "dependsOn": [0] },
    ...
  ]
}
Independent steps (no prerequisites) should have "dependsOn": [].
Return ONLY the JSON. No markdown.`;

    const userPrompt = `Goal: ${input}\n\nProduce a dependency-annotated plan.`;

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

      const normalisedSteps: PlanStep[] = steps.map((s, i) => ({
        ...s,
        index: i,
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
      }));

      // Validate no cyclic dependencies
      this.validateNoCycles(normalisedSteps);

      return {
        goal: input,
        steps: normalisedSteps,
        estimatedComplexity: "high",
      };
    } catch (err) {
      if (err instanceof CyclicDependencyError) throw err;
      return this.fallbackPlan(input);
    }
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — step()
  // -------------------------------------------------------------------------

  /**
   * Single-step execution — interface compliance.
   * In practice, ReWOOEngine executes steps via _executeWaves().
   */
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

    const systemPrompt = `You are executing a step in a parallel plan.
Goal: ${plan.goal}
Current step: ${currentStep.description}
${currentStep.toolName ? `Preferred tool: ${currentStep.toolName}` : ""}

Available tools:
${toolsDescription}

Respond with JSON:
If calling a tool: { "thinking": "...", "toolName": "...", "toolParams": { ... } }
If answering directly: { "thinking": "...", "text": "..." }

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

    return result;
  }

  // -------------------------------------------------------------------------
  // ReasoningEngine — observe()
  // -------------------------------------------------------------------------

  async observe(stepResult: StepResult, _context: AgentExecutionContext): Promise<Observation> {
    const stopSignal =
      stepResult.toolName !== undefined &&
      ["send-message", "request-human"].includes(stepResult.toolName);

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

  /**
   * Called after each wave. Returns false if any stop-tool was called.
   */
  async shouldContinue(
    observations: Observation[],
    _plan: Plan,
    _context: AgentExecutionContext,
  ): Promise<boolean> {
    return !observations.some((o) => o.stopSignal);
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
      strategy: "rewoo",
      escalated: false,
      retriesUsed: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Wave executor (primary execution path for ReWOO)
  // -------------------------------------------------------------------------

  /**
   * Topological sort → execute independent steps in parallel waves.
   * Each wave is limited to maxParallel concurrent executions.
   */
  async executeWaves(
    plan: Plan,
    tools: ToolDefinition[],
    context: AgentExecutionContext,
    executeTool: ToolExecutor,
    traceCallback?: TraceCallback,
  ): Promise<Observation[]> {
    const allObservations: Observation[] = [];
    const completedIndexes = new Set<number>();
    const waves = this.buildWaves(plan.steps);

    for (const wave of waves) {
      // Check stop condition before each wave
      const shouldStop = !(await this.shouldContinue(allObservations, plan, context));
      if (shouldStop) break;

      // Execute wave in parallel, capped at maxParallel
      const waveResults = await this.executeParallel(
        wave,
        plan,
        tools,
        context,
        executeTool,
        traceCallback,
      );

      for (const [stepIndex, result] of waveResults) {
        const obs = await this.observe(result, context);
        allObservations.push(obs);
        completedIndexes.add(stepIndex);
      }
    }

    return allObservations;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private fallbackPlan(input: string): Plan {
    return {
      goal: input,
      steps: [{ index: 0, description: "execute-goal-directly", dependsOn: [] }],
      estimatedComplexity: "low",
    };
  }

  /**
   * Builds execution waves via topological sort.
   * Each wave contains step indexes that can be executed in parallel.
   */
  private buildWaves(steps: PlanStep[]): number[][] {
    const waves: number[][] = [];
    const completed = new Set<number>();

    while (completed.size < steps.length) {
      const wave: number[] = [];

      for (const step of steps) {
        if (completed.has(step.index)) continue;
        const deps = step.dependsOn ?? [];
        if (deps.every((d) => completed.has(d))) {
          wave.push(step.index);
        }
      }

      if (wave.length === 0) {
        // Cycle detected — should have been caught in validateNoCycles()
        throw new CyclicDependencyError("Cycle detected during wave building");
      }

      waves.push(wave);
      wave.forEach((i) => completed.add(i));
    }

    return waves;
  }

  /**
   * Execute a wave of step indexes in parallel, capped at maxParallel.
   */
  private async executeParallel(
    wave: number[],
    plan: Plan,
    tools: ToolDefinition[],
    context: AgentExecutionContext,
    executeTool: ToolExecutor,
    traceCallback?: TraceCallback,
  ): Promise<[number, StepResult][]> {
    const results: [number, StepResult][] = [];

    // Chunk wave into batches of maxParallel
    for (let i = 0; i < wave.length; i += this.maxParallel) {
      const batch = wave.slice(i, i + this.maxParallel);
      const batchResults = await Promise.all(
        batch.map(async (stepIndex): Promise<[number, StepResult]> => {
          const result = await this.step(
            plan,
            stepIndex,
            tools,
            context,
            executeTool,
            traceCallback,
          );
          return [stepIndex, result];
        }),
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Validates that the dependency graph has no cycles using DFS.
   * Throws CyclicDependencyError if a cycle is found.
   */
  private validateNoCycles(steps: PlanStep[]): void {
    const indexMap = new Map(steps.map((s) => [s.index, s]));
    const visited = new Set<number>();
    const inStack = new Set<number>();

    const dfs = (index: number): void => {
      if (inStack.has(index)) {
        throw new CyclicDependencyError(`Cycle detected in dependency graph at step ${index}`);
      }
      if (visited.has(index)) return;

      inStack.add(index);
      visited.add(index);

      const step = indexMap.get(index);
      for (const dep of step?.dependsOn ?? []) {
        dfs(dep);
      }

      inStack.delete(index);
    };

    for (const step of steps) {
      dfs(step.index);
    }
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class CyclicDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclicDependencyError";
  }
}
