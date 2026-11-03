import type { z } from "zod";

import type { RetryPolicy, StepFn, WorkflowDefinition, WorkflowStep } from "./types.js";

/**
 * Create a leaf step.
 *
 * `.then()` was removed (correção pós-review): use `.step()` exclusively.
 * If you need a distinct semantic later, add a new method — don't alias.
 */
export function createStep<TInput, TOutput>(
  id: string,
  fn: StepFn<TInput, TOutput>,
  opts: { retry?: RetryPolicy; timeoutMs?: number } = {},
): WorkflowStep {
  return {
    id,
    kind: "step",
    execute: fn as StepFn,
    retry: opts.retry,
    timeoutMs: opts.timeoutMs,
  };
}

/**
 * Fluent builder for workflows. Use {@link createWorkflow} as entry point.
 *
 * DSL choices:
 *  - `.step(s)` is the only way to enqueue a leaf step (we intentionally do
 *    NOT alias `.then(s)` to keep the DSL one-way).
 *  - `.branch(...)`/`.parallel(...)` produce composite nodes with their own ids.
 *  - `.build()` runs DAG cycle detection across the whole tree.
 */
export class WorkflowBuilder {
  private readonly steps: WorkflowStep[] = [];

  constructor(
    private readonly id: string,
    private readonly version = 1,
  ) {}

  step(s: WorkflowStep): this {
    this.steps.push(s);
    return this;
  }

  branch(
    id: string,
    predicate: WorkflowStep["predicate"],
    truthy: WorkflowStep[],
    falsy: WorkflowStep[] = [],
  ): this {
    this.steps.push({
      id,
      kind: "branch",
      // Composite nodes never execute directly; the engine dispatches by kind.
      execute: () => Promise.resolve(null),
      predicate,
      branches: { truthy, falsy },
    });
    return this;
  }

  parallel(id: string, steps: WorkflowStep[]): this {
    this.steps.push({
      id,
      kind: "parallel",
      execute: () => Promise.resolve(null),
      parallel: steps,
    });
    return this;
  }

  /**
   * Build the definition. Validates the tree:
   *  - No duplicate step ids anywhere in the tree.
   *  - No reachable cycles via branches/parallel (a step id seen twice along
   *    a traversal path = cycle).
   */
  build(description: string, inputSchema?: z.ZodTypeAny): WorkflowDefinition {
    const allIds = new Set<string>();
    this.assertNoDuplicatesAndNoCycles(this.steps, allIds);

    return {
      id: this.id,
      version: this.version,
      description,
      steps: this.steps,
      inputSchema,
    };
  }

  private assertNoDuplicatesAndNoCycles(nodes: WorkflowStep[], seen: Set<string>): void {
    for (const node of nodes) {
      if (seen.has(node.id)) {
        throw new Error(`Workflow ${this.id}: duplicate or cyclic step id "${node.id}"`);
      }
      seen.add(node.id);

      if (node.kind === "branch" && node.branches) {
        // Each branch is its own traversal; siblings sharing ids across
        // truthy/falsy sub-trees would still be an authoring bug.
        this.assertNoDuplicatesAndNoCycles(node.branches.truthy, seen);
        this.assertNoDuplicatesAndNoCycles(node.branches.falsy, seen);
      } else if (node.kind === "parallel" && node.parallel) {
        this.assertNoDuplicatesAndNoCycles(node.parallel, seen);
      }
    }
  }
}

export function createWorkflow(id: string, version = 1): WorkflowBuilder {
  return new WorkflowBuilder(id, version);
}
