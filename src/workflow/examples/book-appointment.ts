import { z } from "zod";

import { createStep, createWorkflow } from "../builder.js";

interface CheckAvailabilityInput {
  slotIso: string;
  price?: number;
  requiresPayment?: boolean;
}

const checkAvailability = createStep<CheckAvailabilityInput, CheckAvailabilityInput>(
  "check-availability",
  async (input, ctx) => {
    const result = (await ctx.toolExecutor("read-calendar", { slot: input.slotIso }, ctx)) as {
      available?: boolean;
    };
    if (!result || result.available === false) {
      throw new Error(`Slot ${input.slotIso} not available`);
    }
    return input;
  },
);

const reserveSlot = createStep<
  CheckAvailabilityInput,
  { appointmentId: string; requiresPayment: boolean }
>("reserve-slot", async (input, ctx) => {
  const result = (await ctx.toolExecutor(
    "create-appointment",
    { slot: input.slotIso, hold: true },
    ctx,
  )) as { data?: { id?: string }; success?: boolean };
  const appointmentId = result?.data?.id ?? `local-${Date.now()}`;
  return {
    appointmentId,
    requiresPayment: input.requiresPayment ?? false,
  };
});

const requestPayment = createStep<{ appointmentId: string; requiresPayment: boolean }, unknown>(
  "request-payment",
  async (input, ctx) => {
    // Suspend awaiting external webhook.
    ctx.suspend({
      resumeOn: "callback:payment.confirmed",
      timeoutMs: 30 * 60 * 1000,
      metadata: { appointmentId: input?.appointmentId },
    });
  },
);

// The builder validates the truthy and falsy branch sub-trees against a
// shared `seen` set, so the two arms must not reuse the same step id. Both
// confirm steps carry identical behaviour but distinct ids.
const confirmBooking = createStep<unknown, { confirmed: true }>(
  "confirm-booking",
  async (_input, ctx) => {
    const appointmentId =
      (ctx.stepOutputs["reserve-slot"] as { appointmentId?: string } | undefined)?.appointmentId ??
      "unknown";
    await ctx.toolExecutor(
      "send-message",
      {
        message: `Appointment ${appointmentId} confirmed.`,
      },
      ctx,
    );
    return { confirmed: true as const };
  },
);

const confirmBookingDirect = createStep<unknown, { confirmed: true }>(
  "confirm-booking-direct",
  async (_input, ctx) => {
    const appointmentId =
      (ctx.stepOutputs["reserve-slot"] as { appointmentId?: string } | undefined)?.appointmentId ??
      "unknown";
    await ctx.toolExecutor(
      "send-message",
      {
        message: `Appointment ${appointmentId} confirmed.`,
      },
      ctx,
    );
    return { confirmed: true as const };
  },
);

export const bookAppointmentWorkflow = createWorkflow("book-appointment", 1)
  .step(checkAvailability)
  .step(reserveSlot)
  .branch(
    "needs-payment",
    (_input, ctx) =>
      Boolean(
        (ctx.stepOutputs["reserve-slot"] as { requiresPayment?: boolean } | undefined)
          ?.requiresPayment,
      ),
    [requestPayment, confirmBooking],
    [confirmBookingDirect],
  )
  .build(
    "Marca consulta com pagamento opcional (suspende em webhook de pagamento).",
    z.object({
      slotIso: z.string(),
      price: z.number().optional(),
      requiresPayment: z.boolean().optional(),
    }),
  );
