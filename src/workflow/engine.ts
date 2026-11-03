import { randomUUID } from "node:crypto";

import type { AgentExecutionContext } from "../agents/execution-context.js";
import { withSpan } from "../observability/spans.js";
import { getHookBus } from "../runtime/hooks/index.js";
import { withBackoff } from "../utils/backoff.js";

import type { WorkflowStateStore } from "./state-store.js";
import {
  emptyState,
  RESUME_PAYLOAD_KEY,
  WorkflowSuspendError,
  type StepContext,
  type SuspendSignal,
  type WorkflowDefinition,
  type WorkflowState,
  type WorkflowStatus,
  type WorkflowStep,
} from "./types.js";

export interface RunWorkflowOptions {
  definition: WorkflowDefinition;
  input: unknown;
  context: AgentExecutionContext;
  store: WorkflowStateStore;
  executionId: string;
  organizationId: string;
  /** Tool executor injected by the runtime (same one reasoning engines use). */
  toolExecutor: StepContext["toolExecutor"];
  /** Default per-step timeout when a step does not declare its own. */
  defaultStepTimeoutMs?: number;
}

export interface RunWorkflowResult {
  workflowExecutionId: string;
  status: WorkflowStatus;
  output?: unknown;
  suspend?: SuspendSignal & { token: string };
  error?: string;
  stepOutputs: Record<string, unknown>;
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000;

/**
 * Run a workflow from scratch. Creates a `workflow_executions` row, walks
 * the steps in order, persists state after each step, and returns the
 * terminal/suspended state.
 */
export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunWorkflowResult> {
  const { definition, store, organizationId, executionId } = opts;

  // 1. Validate input (if schema declared).
  if (definition.inputSchema) {
    const parsed = definition.inputSchema.safeParse(opts.input);
    if (!parsed.success) {
      return {
        workflowExecutionId: "",
        status: "failed",
        error: `input validation failed: ${parsed.error.message}`,
        stepOutputs: {},
      };
    }
  }

  // 2. Persist initial row.
  const state = emptyState();
  const workflowExecutionId = await store.create({
    executionId,
    workflowId: definition.id,
    workflowVersion: definition.version,
    organizationId,
    status: "running",
    state,
    currentStep: definition.steps[0]?.id ?? null,
    suspendToken: null,
    suspendReason: null,
    resumeEvent: null,
    resumePayload: null,
    timeoutAt: null,
    error: null,
  });

  return executeFrom(workflowExecutionId, opts, state, opts.input);
}

/**
 * Resume a suspended workflow. Loads by `suspendToken` (account-scoped to
 * prevent enumeration), injects the resume payload, and resumes from the
 * persisted cursor.
 */
export async function resumeWorkflow(
  store: WorkflowStateStore,
  suspendToken: string,
  organizationId: string,
  resumePayload: unknown,
  opts: Omit<RunWorkflowOptions, "input" | "store" | "executionId" | "organizationId">,
): Promise<RunWorkflowResult> {
  const row = await store.loadBySuspendToken(suspendToken, organizationId);
  if (!row) {
    return {
      workflowExecutionId: "",
      status: "failed",
      error: "suspend_token not found",
      stepOutputs: {},
    };
  }
  if (row.status !== "suspended") {
    // Idempotent: a duplicated webhook should not corrupt state.
    return {
      workflowExecutionId: row.id,
      status: row.status,
      stepOutputs: row.state.stepOutputs,
    };
  }
  if (row.workflowId !== opts.definition.id || row.workflowVersion !== opts.definition.version) {
    return {
      workflowExecutionId: row.id,
      status: "failed",
      error: "workflow_version_mismatch",
      stepOutputs: row.state.stepOutputs,
    };
  }

  // Suspended step: record the resume payload as its output and advance
  // the cursor past it so the engine resumes at the next step.
  const suspendedStep = opts.definition.steps[row.state.cursor];
  const newStepOutputs: Record<string, unknown> = {
    ...row.state.stepOutputs,
    [RESUME_PAYLOAD_KEY]: resumePayload,
  };
  if (suspendedStep) newStepOutputs[suspendedStep.id] = resumePayload;

  const state: WorkflowState = {
    ...row.state,
    cursor: row.state.cursor + 1,
    stepOutputs: newStepOutputs,
    resumePayload,
  };

  // Guarded atomic claim: transitions suspended→running AND writes the full
  // state patch in a single UPDATE, eliminating any torn-write window.
  // Returns false if another worker (or a concurrent cleanup expiry) already
  // claimed it — CF3 engine deviation.
  const claimed = await store.claimForResume(row.id, suspendToken, { state, resumePayload });
  if (!claimed) {
    // Lost the race — bail with a no-op result using the pre-loaded row's status
    // (reflects the actual post-race state without a re-query).
    // onResumed must NOT fire on the bail path.
    return {
      workflowExecutionId: row.id,
      status: row.status,
      stepOutputs: row.state?.stepOutputs ?? {},
    };
  }

  // Emit onResumed AFTER a successful claim (not before) so consumers such as
  // the C.3 correlation projection never see a ghost "resumed" for a workflow
  // that lost the race and never actually proceeded.
  await getHookBus().emit("onResumed", {
    executionId: row.executionId,
    workflowExecutionId: row.id,
    suspendToken,
    organizationId: row.organizationId,
    contactKey: opts.context?.contactId != null ? String(opts.context.contactId) : undefined,
  });

  return executeFrom(
    row.id,
    {
      ...opts,
      input: resumePayload,
      store,
      executionId: row.executionId,
      organizationId: row.organizationId,
    },
    state,
    // The resume payload becomes the input to the next step.
    resumePayload,
  );
}

async function executeFrom(
  workflowExecutionId: string,
  opts: RunWorkflowOptions,
  state: WorkflowState,
  initialInput: unknown,
): Promise<RunWorkflowResult> {
  const { definition, store } = opts;
  let input: unknown = initialInput;

  try {
    for (let i = state.cursor; i < definition.steps.length; i++) {
      const step = definition.steps[i]!;
      state.cursor = i;
      await store.update(workflowExecutionId, { currentStep: step.id, state });

      const stepCtx = buildStepContext(opts, state);

      let output: unknown;
      try {
        output = await withSpan(
          "workflow.step.execute",
          {
            "workflow.id": definition.id,
            "workflow.version": definition.version,
            "step.id": step.id,
            "step.kind": step.kind,
            "execution.id": opts.executionId,
          },
          async () => executeStep(step, input, stepCtx, opts),
        );
      } catch (err) {
        if (err instanceof WorkflowSuspendError) {
          return await persistSuspend(workflowExecutionId, opts, state, err.signal);
        }
        const message = err instanceof Error ? err.message : String(err);
        await store.update(workflowExecutionId, {
          status: "failed",
          state,
          error: { message },
          completedAt: new Date(),
        });
        await getHookBus().emit("onWorkflowTerminal", {
          executionId: opts.executionId,
          workflowExecutionId,
          status: "failed",
          organizationId: opts.organizationId,
          contactKey: opts.context?.contactId != null ? String(opts.context.contactId) : undefined,
        });
        return {
          workflowExecutionId,
          status: "failed",
          error: message,
          stepOutputs: state.stepOutputs,
        };
      }

      state.stepOutputs[step.id] = output;
      state.cursor = i + 1;
      await store.update(workflowExecutionId, { state });
      input = output; // chain output → input of next step
    }

    await store.update(workflowExecutionId, {
      status: "completed",
      state,
      completedAt: new Date(),
      currentStep: null,
    });
    await getHookBus().emit("onWorkflowTerminal", {
      executionId: opts.executionId,
      workflowExecutionId,
      status: "completed",
      organizationId: opts.organizationId,
      contactKey: opts.context?.contactId != null ? String(opts.context.contactId) : undefined,
    });
    return {
      workflowExecutionId,
      status: "completed",
      output: input,
      stepOutputs: state.stepOutputs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.update(workflowExecutionId, {
      status: "failed",
      error: { message },
      completedAt: new Date(),
    });
    return {
      workflowExecutionId,
      status: "failed",
      error: message,
      stepOutputs: state.stepOutputs,
    };
  }
}

async function persistSuspend(
  workflowExecutionId: string,
  opts: RunWorkflowOptions,
  state: WorkflowState,
  signal: SuspendSignal,
): Promise<RunWorkflowResult> {
  const token = signal.suspendToken ?? randomUUID();
  const timeoutAt = new Date(Date.now() + signal.timeoutMs);
  await opts.store.update(workflowExecutionId, {
    status: "suspended",
    state,
    suspendToken: token,
    suspendReason: signal.resumeOn,
    resumeEvent: signal.resumeOn,
    timeoutAt,
  });
  await getHookBus().emit("onSuspended", {
    executionId: opts.executionId,
    workflowExecutionId,
    suspendToken: token,
    resumeOn: signal.resumeOn,
    timeoutAt,
    organizationId: opts.organizationId,
    contactKey: opts.context?.contactId != null ? String(opts.context.contactId) : undefined,
    workflowVersion: opts.definition.version,
  });
  return {
    workflowExecutionId,
    status: "suspended",
    suspend: { ...signal, token },
    stepOutputs: state.stepOutputs,
  };
}

function buildStepContext(opts: RunWorkflowOptions, state: WorkflowState): StepContext {
  const stepOutputs = state.stepOutputs;
  const ctx: StepContext = {
    ...opts.context,
    stepOutputs,
    toolExecutor: opts.toolExecutor,
    suspend(signal: SuspendSignal): never {
      throw new WorkflowSuspendError(signal);
    },
  };
  return ctx;
}

async function executeStep(
  step: WorkflowStep,
  input: unknown,
  ctx: StepContext,
  opts: RunWorkflowOptions,
): Promise<unknown> {
  switch (step.kind) {
    case "step":
      return runLeaf(step, input, ctx, opts);
    case "branch": {
      if (!step.predicate || !step.branches)
        throw new Error(`branch step "${step.id}" missing predicate/branches`);
      const truthy = await step.predicate(input, ctx);
      const branch = truthy ? step.branches.truthy : step.branches.falsy;
      let cur: unknown = input;
      for (const sub of branch) {
        cur = await executeStep(sub, cur, ctx, opts);
        ctx.stepOutputs[sub.id] = cur;
      }
      return cur;
    }
    case "parallel": {
      if (!step.parallel) throw new Error(`parallel step "${step.id}" missing parallel`);
      const results = await Promise.all(
        step.parallel.map((sub) => executeStep(sub, input, ctx, opts)),
      );
      step.parallel.forEach((sub, i) => {
        ctx.stepOutputs[sub.id] = results[i];
      });
      return results;
    }
    default:
      throw new Error(`unknown step kind: ${String(step.kind)}`);
  }
}

async function runLeaf(
  step: WorkflowStep,
  input: unknown,
  ctx: StepContext,
  opts: RunWorkflowOptions,
): Promise<unknown> {
  const timeoutMs = step.timeoutMs ?? opts.defaultStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const runOnce = async () => withTimeout(step.execute(input, ctx), timeoutMs, step.id);

  if (!step.retry) return runOnce();

  return withBackoff(runOnce, {
    maxAttempts: step.retry.maxAttempts,
    baseDelayMs: step.retry.baseDelayMs,
    maxDelayMs: step.retry.maxDelayMs,
    // Suspend must bubble immediately — never retry it.
    shouldRetry: (err) => !(err instanceof WorkflowSuspendError),
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`step "${label}" timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
