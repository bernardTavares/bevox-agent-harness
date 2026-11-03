/**
 * C9/C10 — `waitlist-add` como `MutationTool` (ADR-006 / ADR-015).
 * Preserva o comportamento legado: SEM rate-limit (a tool original não
 * chamava `checkRateLimit`). A chave idempotente é derivada do `params`
 * completo (inclui customer_name + datas) → entradas distintas geram
 * chaves distintas (open question §8.2).
 */

import * as calendarClient from "../../integration/calendar-client.js";
import {
  MutationTool,
  MutationPreconditionError,
  type ToolContext,
} from "../_shared/mutation-tool.js";

export interface WaitlistAddParams {
  calendar_id: string;
  service_id?: string;
  customer_name: string;
  preferred_date_from?: string;
  preferred_date_to?: string;
}

export class WaitlistAddMutation extends MutationTool<WaitlistAddParams, unknown> {
  readonly name = "waitlist-add";
  readonly action = "waitlist-add";

  async execute(params: WaitlistAddParams, context: ToolContext): Promise<unknown> {
    if (!params.calendar_id || !params.customer_name) {
      throw new MutationPreconditionError(
        "INVALID_PARAMS",
        "calendar_id and customer_name are required",
      );
    }
    const body = {
      service_id: params.service_id,
      customer_name: params.customer_name,
      preferred_date_from: params.preferred_date_from,
      preferred_date_to: params.preferred_date_to,
    };
    const idempotencyKey = this.deriveIdempotencyKey(context, params);
    return calendarClient.addToWaitlist(
      params.calendar_id,
      body,
      undefined, // token (posicional)
      idempotencyKey,
    );
  }
}

export const waitlistAddMutation = new WaitlistAddMutation();
