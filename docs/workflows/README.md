# Workflows — User Guide

Sprint C.1 introduced a declarative **workflow engine** alongside the
existing reasoning engines. Workflows are first-class citizens in
`AgentDefinition`:

```ts
{
  name: "appointment-scheduler",
  type: "surface",
  reasoning: { default: "react" },   // kept as fallback (see precedence)
  workflow: "book-appointment",       // wins when set
  permissions: { ... },
}
```

## When to use what

| Case | Pick |
|---|---|
| Known, deterministic flow ("check → reserve → charge → confirm") | **Workflow** |
| Open-ended question that needs tool exploration | **Reasoning (ReAct)** |
| Many tools in parallel, no dependencies | **Reasoning (ReWOO)** or `workflow.parallel` |
| Must pause until external event arrives (webhook) | **Workflow** (`ctx.suspend`) |
| Single direct LLM answer with no tools | **Reasoning (direct)** |

## DSL

```ts
import { createWorkflow, createStep } from "../workflow/builder.js";

const stepA = createStep("a", async (input, ctx) => {
  // call a tool the agent has permission to use
  return ctx.toolExecutor("create-appointment", { slot: input.slot }, ctx);
});

const stepB = createStep("b", async (input, ctx) => {
  return { confirmed: true };
});

export const myFlow = createWorkflow("my-flow", 1)
  .step(stepA)
  .step(stepB)
  .branch(
    "needs-approval",
    (input, ctx) => Boolean(ctx.stepOutputs["a"]?.needsApproval),
    [/* truthy steps */],
    [/* falsy steps */],
  )
  .parallel("fan-out", [stepX, stepY])
  .build("Description", optionalZodInputSchema);
```

**Notes:**
- `.step(s)` is the only API to enqueue a leaf step. There is **no
  `.then()` alias** — adding one would make the DSL ambiguous.
- `.branch()` and `.parallel()` are composite nodes. Their `id` must be
  unique across the entire workflow tree (cycle detection in `build()`).
- Pass a Zod schema as the second argument to `.build()` to validate the
  workflow's initial input.

## Step authoring

Each `StepFn` receives `(input, ctx)`:

- `input` — output of the previous step (or initial workflow input for the
  first step).
- `ctx.stepOutputs` — map of all previous outputs keyed by step id.
- `ctx.toolExecutor(name, params, ctx)` — invokes a tool that the agent
  has permission to call. Permission filtering happens in the runtime; if
  the tool isn't in the agent's `permissions.required`/`optional`, the
  executor returns `{ success: false, error: "Tool not found" }`.
- `ctx.suspend(signal)` — pauses the workflow and persists state. See
  below.

Steps can declare:
- `retry: { maxAttempts, baseDelayMs, maxDelayMs? }` — exponential
  backoff with full jitter. Suspends never retry.
- `timeoutMs` — per-step timeout. Falls back to
  `WORKFLOW_DEFAULT_TIMEOUT_MS`.

## Suspend / Resume

```ts
const wait = createStep("wait-payment", async (_input, ctx) => {
  ctx.suspend({
    resumeOn: "callback:payment.confirmed",
    timeoutMs: 30 * 60 * 1000,
    metadata: { /* anything the webhook needs */ },
  });
});
```

When a step suspends:
1. The engine persists `status='suspended'`, generates a UUID
   `suspend_token`, and sets `timeout_at = now + timeoutMs`.
2. The execution callback to Bevox reports status `running` (V1 — full
   `suspended` status is coordinated with the Bevox team).
3. When the external event fires, **Bevox calls the harness back**:
   - **Default**: HTTP POST to the private resume endpoint (ADR-012).
   - **Optional**: publish to Redis channel `workflow:resume` (set
     `WORKFLOW_RESUME_VIA_REDIS=true`).
4. The next step receives the resume payload as its input. It is also
   accessible via `ctx.stepOutputs["__resume__"]` (constant exported as
   `RESUME_PAYLOAD_KEY`).

If `timeout_at` passes before resume, the cleanup job marks the workflow
`failed` with `error.reason = 'timeout'`.

## Versioning

- `workflow.version` is part of the registry key (`id@version`). Bumping
  is **required** any time:
  - A step id is added/removed.
  - A step's input/output shape changes.
  - The branch/parallel structure changes.
- The DB row records the exact `workflow_version`. On resume, the engine
  loads `WorkflowRegistry.getExact(id, version)`. If that version is no
  longer registered, the resume fails with
  `error.reason: 'workflow_version_removed'`.
- **Retention rule**: a version may only be deprecated when no row has
  `status IN ('running','suspended')` for that `(id, version)`. Query
  this via `store.listActiveVersions(id)` before pruning.

## Precedence

Inside `AgentDefinition`:

- If `workflow` is set, **the workflow wins**: the runtime dispatches to
  the workflow engine and never instantiates a reasoning engine.
- If the workflow id is not registered, this is a **hard fail** —
  there is no silent fallback to reasoning (that would mask config
  errors).
- If `workflow` is absent, the reasoning loop runs unchanged.

## Operations

Env vars (in `src/config/env.ts`):

```
WORKFLOW_DEFAULT_TIMEOUT_MS    = 30000
WORKFLOW_SUSPEND_TTL_MS        = 1800000
WORKFLOW_CLEANUP_INTERVAL_MS   = 300000
WORKFLOW_RESUME_HOST           = 127.0.0.1
WORKFLOW_RESUME_PORT           = 4500
WORKFLOW_RESUME_SECRET         = <>=32 chars when WORKFLOW_RESUME_ENABLED=true>
WORKFLOW_RESUME_ENABLED        = false
WORKFLOW_RESUME_VIA_REDIS      = false
```

Bootstrap stage `register-workflows` registers all known workflows and
validates every `AgentDefinition.workflow` reference. Stage
`start-workflow-resume` starts the cleanup sweep and validates the resume
configuration.

## Migration: schema versioning

`WorkflowStateSchemaV1` is the current persisted shape. Future versions:

1. Define `WorkflowStateSchemaV2` and a migrator function
   `migrateV1ToV2(stateV1): stateV2`.
2. Extend the `migrateState` discriminator in `types.ts` to branch on
   `schemaVersion`.
3. Bump every persisted row's `schemaVersion` lazily on the first resume,
   or proactively via a one-off migration script.

Without `schemaVersion`, a resume after a deploy that changed the state
shape would silently corrupt running workflows.

## See also

- ADR-012 (`docs/adr/012-workflow-resume-boundary.md`) — why the resume
  endpoint is allowed to bind a TCP port despite the "no public REST"
  rule.
- `src/workflow/examples/book-appointment.ts` — full reference workflow.
