/**
 * SDR Cadence WorkflowDefinition — Account-Status FSM + 7-touch skeleton (Fase C §6, Task C.6).
 *
 * ARCHITECTURE NOTES
 * ──────────────────
 * L5  — Builder has NO loop/repeat primitive. The cadence is a FLAT, unrolled
 *        list of uniquely-id'd steps: touch-1 … touch-7, each followed by a
 *        deterministic reply-branch step. No loops.
 *
 * §6.4 — Branch guards are DETERMINISTIC (pure/no-LLM). Guards read evidence
 *        from ctx.stepOutputs["__resume__"] / the qualify-opportunity skill
 *        result stored in stepOutputs["qualify-tN"]. ctx.llmClient is NEVER called.
 *
 * FLAT WORKFLOW + EARLY-EXIT PATTERN
 * ────────────────────────────────────
 * Because the engine executes ALL flat steps sequentially with no break primitive,
 * we use an "absorbing status" pattern:
 *  - The `account-status` key in stepOutputs holds the current FSM state.
 *  - Every touch step checks `stepOutputs["account-status"]`. If a terminal state
 *    is already recorded (Dead, Quarterly, Active, Qualified), the touch step
 *    returns immediately without suspending (it's a no-op from that point).
 *  - This lets terminal states be "absorbed" without the remaining 7-N touch
 *    steps causing spurious suspends.
 *
 * REPLY_RESUMABLE — Touch suspend steps MUST use resumeOn: "reply:inbound"
 *   (∈ REPLY_RESUMABLE). The correlation probe uses this to route inbound
 *   prospect replies to the correct suspended execution.
 *
 * AE-REQUALIFICATION — The handoff suspend MUST use resumeOn NOT in
 *   REPLY_RESUMABLE: "callback:ae.requalified". This prevents the correlation
 *   probe from hijacking AE callbacks as prospect replies.
 *
 * ACCOUNT STATUS FSM
 * ──────────────────
 * States:  Cold → Working → {Qualified | Nurture:Active | Nurture:Quarterly | Nurture:Dead}
 * Avoid:*  absorbing (once set in state, no further processing).
 *
 * FSM transitions (deterministic — resume payload evidence only, no LLM):
 *   Cold    + touch-1 sent                  → Working
 *   Working + positive reply                → qualify gate → Qualified or Nurture:Active
 *   Working + opt-out / hostile             → Nurture:Dead  (absorbing)
 *   Working + soft-no / no-reply timeout    → continue cadence (next touch)
 *   Working + all 7 touches exhausted       → Nurture:Quarterly (absorbing)
 *   Qualified + AE requalification suspend  → terminal (AE takes over)
 *
 * MESSAGE COPY IS NOT HERE — this definition is the FSM/cadence skeleton +
 *   suspend points + deterministic transitions only. Outreach copy is generated
 *   by a separate doctrine-governed loop (not implemented here).
 */

import { createStep, createWorkflow } from "../builder.js";
import type { StepContext } from "../types.js";
import { RESUME_PAYLOAD_KEY } from "../types.js";
import qualifyOpportunitySkill from "../../skills-builtin/sales/qualify-opportunity/index.js";

// ---------------------------------------------------------------------------
// Constants (exported for test assertions)
// ---------------------------------------------------------------------------

/**
 * resumeOn event for the AE-requalification suspend.
 * MUST NOT be in REPLY_RESUMABLE — the correlation probe must NOT route
 * inbound prospect replies to this suspend point.
 */
export const AE_REQUALIFY_RESUME_ON = "callback:ae.requalified" as const;

/**
 * Terminal account statuses. Once any of these is stored in
 * stepOutputs["account-status"], subsequent touch steps are no-ops.
 */
export type AccountStatus =
  | "Cold"
  | "Working"
  | "Qualified"
  | "Nurture:Active"
  | "Nurture:Quarterly"
  | "Nurture:Dead";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "Qualified",
  "Nurture:Active",
  "Nurture:Quarterly",
  "Nurture:Dead",
]);

/**
 * Day-spacing timeouts for the 7-touch reply-await suspends (7×7 style).
 *   touch-1: 3 days   touch-2: 4 days   touch-3: 7 days   touch-4: 7 days
 *   touch-5: 7 days   touch-6: 14 days  touch-7: 14 days
 */
const TOUCH_TIMEOUT_MS: readonly number[] = [
  3 * 24 * 60 * 60 * 1000,
  4 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
];

// ---------------------------------------------------------------------------
// Resume payload type (structural — guards are lenient, never throw)
// ---------------------------------------------------------------------------

interface ResumePayload {
  /** Prospect expressed strong positive interest / agreed to meeting */
  positive?: boolean;
  /** Prospect replied to the outreach (any reply) */
  replied?: boolean;
  /** Prospect explicitly opted out, unsubscribed, or said "remove me" */
  optOut?: boolean;
  /** Prospect gave a soft no ("not right now", "reach out later") */
  softNo?: boolean;
  /** PACT/PACT2 evidence dimensions (collected during qualifying conversation) */
  pain?: unknown;
  authority?: unknown;
  consequence?: unknown;
  targetProfile?: unknown;
  timing?: unknown;
  framework?: "PACT" | "PACT2";
}

// ---------------------------------------------------------------------------
// Deterministic guard helpers (§6.4 — NEVER call ctx.llmClient)
// ---------------------------------------------------------------------------

/**
 * Reads the current account status from stepOutputs["account-status"].
 * Returns the status string or "Cold" if not yet set.
 */
function readAccountStatus(ctx: StepContext): string {
  return (ctx.stepOutputs["account-status"] as string | undefined) ?? "Cold";
}

/**
 * Returns true if a terminal status has already been set.
 * Used by touch steps to skip suspending when the account is already resolved.
 */
function isTerminal(ctx: StepContext): boolean {
  return TERMINAL_STATUSES.has(readAccountStatus(ctx));
}

/**
 * Returns true when the resume payload indicates a positive buying signal
 * that warrants moving into the qualify gate.
 * Deterministic: reads payload fields only, no LLM call.
 */
function isPositiveSignal(payload: ResumePayload): boolean {
  return payload.positive === true && payload.optOut !== true;
}

/**
 * Returns true when the prospect is opting out (hostile / unsubscribe).
 * Deterministic: reads payload fields only.
 */
function isOptOut(payload: ResumePayload): boolean {
  return payload.optOut === true;
}

/**
 * Calls the qualify-opportunity skill synchronously using evidence from the
 * resume payload. Returns true when PACT gate passes.
 *
 * DETERMINISTIC: qualify-opportunity is pure compute — no DB, HTTP, LLM.
 * §6.4 invariant: guards are pure/deterministic, never LLM.
 */
async function runQualifyGate(payload: ResumePayload): Promise<boolean> {
  const result = await qualifyOpportunitySkill.execute(
    {
      pain: payload.pain ?? null,
      authority: payload.authority ?? null,
      consequence: payload.consequence ?? null,
      targetProfile: payload.targetProfile ?? null,
      timing: payload.timing ?? null,
      framework: payload.framework ?? "PACT",
    },
    // qualify-opportunity is side-effect-free; ctx is not used internally
    {} as never,
  );
  if (!result.success || !result.data) return false;
  const data = result.data as { qualified?: boolean };
  return data.qualified === true;
}

// ---------------------------------------------------------------------------
// Step factories
// ---------------------------------------------------------------------------

/**
 * Creates a touch step for touch index `n` (1-based).
 *
 * The step:
 *  1. Checks if the account is already in a terminal status → no-op (returns
 *     the current status without suspending). This is the early-exit guard
 *     for the flat-unrolled cadence.
 *  2. Otherwise, suspends with resumeOn:"reply:inbound" (∈ REPLY_RESUMABLE).
 *
 * The suspend metadata includes organizationId + contactKey from the `init` step
 * so the correlation projection hook can index this suspension.
 */
function makeTouchStep(n: number) {
  return createStep<unknown, unknown>(`touch-${n}`, async (_input, ctx) => {
    // Early-exit: if account is already in a terminal state, skip this touch.
    if (isTerminal(ctx)) {
      return ctx.stepOutputs["account-status"];
    }

    // Read contactKey + organizationId stashed by init step.
    const init = ctx.stepOutputs["init"] as
      | { contactKey?: string; organizationId?: string }
      | undefined;

    // Suspend awaiting prospect reply. Throws WorkflowSuspendError — always exits here.
    ctx.suspend({
      resumeOn: "reply:inbound",
      timeoutMs: TOUCH_TIMEOUT_MS[n - 1]!,
      metadata: {
        touchIndex: n,
        organizationId: init?.organizationId ?? ctx.organizationId,
        contactKey: init?.contactKey,
      },
    });
  });
}

/**
 * Creates the reply-processing branch for touch N.
 *
 * Branch predicate (outer): is there a positive buying signal?
 *  - Truthy arm: positive signal → qualify gate step → qualify-branch (pass→handoff, fail→active)
 *  - Falsy arm: opt-out → nurture-dead; else → update status to Working and continue
 *
 * All step ids use the suffix `-t${n}` to guarantee global uniqueness across
 * all 7 branches (the builder's seen-set traverses truthy+falsy together).
 *
 * DETERMINISTIC: all predicates read stepOutputs / payload fields. No LLM.
 */
function makeReplyBranch(n: number) {
  return {
    id: `reply-branch-t${n}`,
    kind: "branch" as const,
    execute: () => Promise.resolve(null),

    // Outer predicate: is the account already terminal? If so, skip entire branch.
    // Otherwise, check for positive signal.
    predicate: (_input: unknown, ctx: StepContext): boolean => {
      if (isTerminal(ctx)) return false; // falsy arm → status-working (no-op in early-exit)
      const payload = (ctx.stepOutputs[RESUME_PAYLOAD_KEY] ?? {}) as ResumePayload;
      return isPositiveSignal(payload);
    },

    branches: {
      // Truthy: positive signal → qualify gate → pass/fail branch
      truthy: [
        // Qualify gate: calls qualify-opportunity skill (deterministic, no LLM)
        createStep<unknown, { qualified: boolean }>(`qualify-t${n}`, async (_input, ctx) => {
          const payload = (ctx.stepOutputs[RESUME_PAYLOAD_KEY] ?? {}) as ResumePayload;
          const qualified = await runQualifyGate(payload);
          return { qualified };
        }),
        // Branch: qualify pass → handoff; qualify fail → nurture-active
        {
          id: `qualify-branch-t${n}`,
          kind: "branch" as const,
          execute: () => Promise.resolve(null),
          predicate: (_input: unknown, ctx: StepContext): boolean => {
            const q = ctx.stepOutputs[`qualify-t${n}`] as { qualified?: boolean } | undefined;
            return q?.qualified === true;
          },
          branches: {
            // Qualify PASS: set status = Qualified; suspend for AE requalification
            truthy: [
              createStep<unknown, { status: "Qualified" }>(
                `set-qualified-t${n}`,
                async (_input, ctx) => {
                  ctx.stepOutputs["account-status"] = "Qualified";
                  return { status: "Qualified" as const };
                },
              ),
              // Set the absorbing status in stepOutputs["account-status"] via a
              // dedicated step (the engine stores step output in stepOutputs[stepId]).
              // The handoff step suspends — always exits here (doesn't return).
              createStep<unknown, unknown>(`handoff-t${n}`, async (_input, ctx) => {
                // Stash terminal status for subsequent steps' early-exit guard.
                // The engine stores this as stepOutputs["handoff-tN"] but the
                // early-exit guard reads "account-status". We use a marker step.
                const init = ctx.stepOutputs["init"] as
                  | { contactKey?: string; organizationId?: string }
                  | undefined;
                ctx.suspend({
                  resumeOn: AE_REQUALIFY_RESUME_ON,
                  timeoutMs: 7 * 24 * 60 * 60 * 1000, // 7 days for AE to act
                  metadata: {
                    organizationId: init?.organizationId ?? ctx.organizationId,
                    contactKey: init?.contactKey,
                    status: "Qualified",
                  },
                });
              }),
            ],
            // Qualify FAIL: set status = Nurture:Active (absorbing)
            falsy: [
              createStep<unknown, AccountStatus>(
                `set-nurture-active-t${n}`,
                async (_input, ctx) => {
                  // Mark account-status absorbing so subsequent touches skip.
                  ctx.stepOutputs["account-status"] = "Nurture:Active";
                  return "Nurture:Active";
                },
              ),
            ],
          },
        },
      ],
      // Falsy: not a positive signal → check for opt-out vs soft-no/no-reply
      falsy: [
        {
          id: `optout-branch-t${n}`,
          kind: "branch" as const,
          execute: () => Promise.resolve(null),
          predicate: (_input: unknown, ctx: StepContext): boolean => {
            if (isTerminal(ctx)) return false;
            const payload = (ctx.stepOutputs[RESUME_PAYLOAD_KEY] ?? {}) as ResumePayload;
            return isOptOut(payload);
          },
          branches: {
            // Opt-out → Nurture:Dead (absorbing)
            truthy: [
              createStep<unknown, AccountStatus>(`set-nurture-dead-t${n}`, async (_input, ctx) => {
                ctx.stepOutputs["account-status"] = "Nurture:Dead";
                return "Nurture:Dead";
              }),
            ],
            // Soft-no / no reply / timeout → continue cadence (update to Working if Cold)
            falsy: [
              createStep<unknown, AccountStatus>(`set-working-t${n}`, async (_input, ctx) => {
                if (!isTerminal(ctx)) {
                  ctx.stepOutputs["account-status"] = "Working";
                }
                return (
                  (ctx.stepOutputs["account-status"] as AccountStatus | undefined) ?? "Working"
                );
              }),
            ],
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

/**
 * SDR Cadence — flat unrolled 7-touch workflow with Account-Status FSM.
 *
 * Shape:
 *   init
 *   touch-1 → reply-branch-t1   (suspend reply:inbound; branch on payload)
 *   touch-2 → reply-branch-t2
 *   …
 *   touch-7 → reply-branch-t7
 *   set-nurture-quarterly        (fallthrough: all touches exhausted, no qualify)
 *
 * Early-exit pattern: touch-N steps check `stepOutputs["account-status"]` before
 * suspending. Terminal statuses (Dead, Active, Qualified, Quarterly) cause all
 * subsequent touch steps to be no-ops (return immediately without suspending).
 * The final `set-nurture-quarterly` step is also guarded — it only sets
 * Nurture:Quarterly if no terminal status is already set.
 */
export const sdrCadenceWorkflow = createWorkflow("sdr-cadence", 1)
  // ── Step 0: init ────────────────────────────────────────────────────────
  // Stash organizationId + contactKey from the workflow input into stepOutputs.
  // The correlation projection hook (onSuspended) reads these from the hook
  // event metadata; the touch steps' suspend metadata also includes them.
  // All subsequent steps can access them via ctx.stepOutputs["init"].
  .step(
    createStep<
      { organizationId: string; contactKey: string },
      { organizationId: string; contactKey: string }
    >("init", async (input) => ({
      organizationId: input?.organizationId ?? "",
      contactKey: input?.contactKey ?? "",
    })),
  )
  // ── Touch 1 ─────────────────────────────────────────────────────────────
  .step(makeTouchStep(1))
  .step(makeReplyBranch(1))
  // ── Touch 2 ─────────────────────────────────────────────────────────────
  .step(makeTouchStep(2))
  .step(makeReplyBranch(2))
  // ── Touch 3 ─────────────────────────────────────────────────────────────
  .step(makeTouchStep(3))
  .step(makeReplyBranch(3))
  // ── Touch 4 ─────────────────────────────────────────────────────────────
  .step(makeTouchStep(4))
  .step(makeReplyBranch(4))
  // ── Touch 5 ─────────────────────────────────────────────────────────────
  .step(makeTouchStep(5))
  .step(makeReplyBranch(5))
  // ── Touch 6 ─────────────────────────────────────────────────────────────
  .step(makeTouchStep(6))
  .step(makeReplyBranch(6))
  // ── Touch 7 ─────────────────────────────────────────────────────────────
  .step(makeTouchStep(7))
  .step(makeReplyBranch(7))
  // ── Fallthrough: all 7 touches exhausted without a qualifying reply ─────
  // Guarded: only sets Quarterly if no prior terminal status was set.
  .step(
    createStep<unknown, AccountStatus>("set-nurture-quarterly", async (_input, ctx) => {
      if (!isTerminal(ctx)) {
        ctx.stepOutputs["account-status"] = "Nurture:Quarterly";
      }
      return (
        (ctx.stepOutputs["account-status"] as AccountStatus | undefined) ?? "Nurture:Quarterly"
      );
    }),
  )
  .build(
    "SDR 7-touch cadence with Account-Status FSM (Cold→Working→{Qualified|Nurture:*}). " +
      "Touch suspends use reply:inbound (REPLY_RESUMABLE); AE handoff uses callback:ae.requalified. " +
      "Branch guards are deterministic — qualify-opportunity skill only, no LLM. " +
      "Flat unrolled structure with absorbing-status early-exit pattern.",
  );
