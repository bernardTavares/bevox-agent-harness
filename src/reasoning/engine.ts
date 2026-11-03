import type { AgentExecutionContext } from "../agents/execution-context.js";
import type { ToolDefinition } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/** A single step inside a plan. */
export interface PlanStep {
  index: number;
  description: string;
  /** Hint from planner — not binding. */
  toolName?: string;
  toolParams?: unknown;
  /** Indexes of steps that must complete first (used by ReWOOEngine). */
  dependsOn?: number[];
}

/** A full plan produced by plan(). */
export interface Plan {
  goal: string;
  steps: PlanStep[];
  estimatedComplexity: "low" | "medium" | "high";
  /**
   * Monotonically-increasing revision counter set by reasoning engines that
   * support replanning (e.g. {@link PlanExecuteEngine}). 0 = initial plan
   * returned by `plan()`; incremented on every `_replan()`. Used by
   * `shouldContinue()` to filter observations belonging to the current plan
   * revision so accumulated history from prior plans cannot corrupt
   * termination checks (audit ref: `a-reasoning-04`).
   */
  generation?: number;
}

// ---------------------------------------------------------------------------
// Step / Observation types
// ---------------------------------------------------------------------------

/** Result of executing a single step. */
export interface StepResult {
  stepIndex: number;
  success: boolean;
  toolName?: string;
  toolParams?: unknown;
  toolOutput?: unknown;
  errorMessage?: string;
  /** ReAct chain-of-thought before action. */
  thinkingTrace?: string;
  durationMs: number;
}

/** Observation derived from a StepResult (stored for synthesis). */
export interface Observation {
  stepIndex: number;
  /** LLM-summarised or raw tool output. */
  summary: string;
  success: boolean;
  raw: StepResult;
  /** Optional divergence score attached by PlanExecuteEngine (0–1). */
  divergenceScore?: number;
  /** Whether this observation signals a stop (send-message / request-human). */
  stopSignal?: boolean;
  /**
   * Plan revision this observation was produced under. Stamped by engines
   * that support replanning (e.g. {@link PlanExecuteEngine}). Mirrors
   * {@link Plan.generation}. Allows `shouldContinue()` to count only
   * observations of the current plan revision and avoid the
   * accumulated-history corruption described in audit `a-reasoning-04`.
   */
  planGeneration?: number;
}

// ---------------------------------------------------------------------------
// Final response
// ---------------------------------------------------------------------------

/** Final agent response after synthesis. */
export interface AgentResponse {
  answer: string;
  observations: Observation[];
  totalSteps: number;
  strategy: "direct" | "react" | "plan-execute" | "rewoo" | "workflow";
  escalated: boolean;
  retriesUsed: number;
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

/** Tool executor callback — the engine calls this instead of importing registry directly. */
export type ToolExecutor = (
  toolName: string,
  params: unknown,
  context: AgentExecutionContext,
) => Promise<unknown>;

/** Trace callback for observability — called after each step. */
export type TraceCallback = (event: {
  engineStrategy: AgentResponse["strategy"];
  stepIndex: number;
  stepResult: StepResult;
  observation: Observation;
  resolvedSystemPrompt?: string;
}) => void;

// ---------------------------------------------------------------------------
// ReasoningEngine interface
// ---------------------------------------------------------------------------

/** Every concrete engine must satisfy this contract. */
export interface ReasoningEngine {
  readonly strategy: AgentResponse["strategy"];

  plan(input: string, context: AgentExecutionContext): Promise<Plan>;

  step(
    plan: Plan,
    stepIndex: number,
    tools: ToolDefinition[],
    context: AgentExecutionContext,
    executeTool: ToolExecutor,
    traceCallback?: TraceCallback,
  ): Promise<StepResult>;

  observe(stepResult: StepResult, context: AgentExecutionContext): Promise<Observation>;

  shouldContinue(
    observations: Observation[],
    plan: Plan,
    context: AgentExecutionContext,
  ): Promise<boolean>;

  synthesize(
    observations: Observation[],
    plan: Plan,
    context: AgentExecutionContext,
  ): Promise<AgentResponse>;

  /**
   * Optional hook for engines that carry mutable instance state across step
   * boundaries (e.g. divergence cache, replan flags). The execution harness
   * calls this after escalation re-planning so the engine starts the new
   * plan revision with a clean slate (audit ref: `a-reasoning-04`).
   */
  reset?(): void;
}
