/**
 * C9/C10 — `reschedule-appointment` como `MutationTool` (ADR-006 / ADR-015).
 */

import * as calendarClient from "../../integration/calendar-client.js";
import { checkRateLimit } from "../_shared/rate-limit.js";
import {
  MutationTool,
  MutationPreconditionError,
  type ToolContext,
} from "../_shared/mutation-tool.js";

export interface RescheduleAppointmentParams {
  appointment_id: string;
  new_date: string;
  new_start_time: string;
}

export class RescheduleAppointmentMutation extends MutationTool<
  RescheduleAppointmentParams,
  unknown
> {
  readonly name = "reschedule-appointment";
  readonly action = "reschedule-appointment";

  async execute(params: RescheduleAppointmentParams, context: ToolContext): Promise<unknown> {
    if (!params.appointment_id || !params.new_date || !params.new_start_time) {
      throw new MutationPreconditionError(
        "INVALID_PARAMS",
        "appointment_id, new_date, and new_start_time are required",
      );
    }
    const denied = await checkRateLimit(
      context.organization_id,
      "reschedule-appointment",
      "calendar-mutation",
    );
    if (denied) {
      throw new MutationPreconditionError(
        denied.errorCode ?? denied.error ?? "RATE_LIMITED",
        denied.detail ?? "Rate limit exceeded",
      );
    }
    const idempotencyKey = this.deriveIdempotencyKey(context, params);
    return calendarClient.rescheduleAppointment(
      params.appointment_id,
      params.new_date,
      params.new_start_time,
      undefined, // token (posicional)
      idempotencyKey,
    );
  }
}

export const rescheduleAppointmentMutation = new RescheduleAppointmentMutation();
