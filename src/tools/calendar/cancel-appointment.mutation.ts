/**
 * C9/C10 — `cancel-appointment` como `MutationTool` (ADR-006 / ADR-015).
 * Em draft modes retorna proposal; em autonomous executa + injeta
 * Idempotency-Key content-derived.
 */

import * as calendarClient from "../../integration/calendar-client.js";
import { checkRateLimit } from "../_shared/rate-limit.js";
import {
  MutationTool,
  MutationPreconditionError,
  type ToolContext,
} from "../_shared/mutation-tool.js";

export interface CancelAppointmentParams {
  appointment_id: string;
  reason?: string;
}

export class CancelAppointmentMutation extends MutationTool<CancelAppointmentParams, unknown> {
  readonly name = "cancel-appointment";
  readonly action = "cancel-appointment";

  async execute(params: CancelAppointmentParams, context: ToolContext): Promise<unknown> {
    if (!params.appointment_id) {
      throw new MutationPreconditionError("INVALID_PARAMS", "appointment_id is required");
    }
    const denied = await checkRateLimit(
      context.organization_id,
      "cancel-appointment",
      "calendar-mutation",
    );
    if (denied) {
      throw new MutationPreconditionError(
        denied.errorCode ?? denied.error ?? "RATE_LIMITED",
        denied.detail ?? "Rate limit exceeded",
      );
    }
    const idempotencyKey = this.deriveIdempotencyKey(context, params);
    return calendarClient.cancelAppointment(
      params.appointment_id,
      params.reason ?? "",
      undefined, // token (posicional)
      idempotencyKey,
    );
  }
}

export const cancelAppointmentMutation = new CancelAppointmentMutation();
