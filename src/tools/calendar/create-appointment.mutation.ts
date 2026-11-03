/**
 * EM-03 POC (issue #44) — `create-appointment` como `MutationTool`
 * (ADR-006 / ADR-007).
 *
 * Esta classe é a versão "propose-aware" do `create-appointment`.
 * Em `autonomous_supervised`, chama o calendar-client de fato (com
 * validação de params + rate-limit); em `manual_assisted` / `copilot`,
 * retorna um `ToolProposal` SEM efeito para que o backend converta em
 * AISuggestion pendente de aprovação humana (ADR-007).
 *
 * Wiring: a skill `src/skills-builtin/calendar/create-appointment/index.ts`
 * registra o `execute` via `mutationExecute(createAppointmentMutation)`,
 * que converte `AgentExecutionContext.executionMode` em
 * `ToolContext.execution_mode` antes de chamar `executeOrPropose()`.
 *
 * Idempotency: usa `deriveIdempotencyKey()` do base class para passar
 * `Idempotency-Key` ao calendar-client (C10 foundation, PR #34).
 */

import * as calendarClient from "../../integration/calendar-client.js";
import { checkRateLimit } from "../_shared/rate-limit.js";

import { MutationTool, MutationPreconditionError, type ToolContext } from "../_shared/mutation-tool.js";

// Re-export para retrocompat: a definição canônica agora vive no shared
// `mutation-tool.ts` (§4.2.a). Importadores existentes continuam válidos.
export { MutationPreconditionError };

export interface CreateAppointmentParams {
  calendar_id: string;
  service_id: string;
  member_id?: string;
  customer_name: string;
  customer_phone?: string;
  date: string;
  start_time: string;
}

export interface CreateAppointmentResult {
  appointment_id?: string;
  raw: unknown;
}

export class CreateAppointmentMutation extends MutationTool<
  CreateAppointmentParams,
  CreateAppointmentResult
> {
  readonly name = "create-appointment";
  readonly action = "create-appointment";

  async execute(
    params: CreateAppointmentParams,
    context: ToolContext,
  ): Promise<CreateAppointmentResult> {
    // Validação de params — preserva o INVALID_PARAMS do tool legado.
    if (
      !params.calendar_id ||
      !params.service_id ||
      !params.customer_name ||
      !params.date ||
      !params.start_time
    ) {
      throw new MutationPreconditionError(
        "INVALID_PARAMS",
        "calendar_id, service_id, customer_name, date, and start_time are required",
      );
    }
    // Rate-limit (mantém política `calendar-mutation`). Em draft modes
    // este código nunca roda — não há efeito a limitar (executeOrPropose
    // só chama execute() em autonomous_supervised).
    const denied = await checkRateLimit(
      context.organization_id,
      "create-appointment",
      "calendar-mutation",
    );
    if (denied) {
      throw new MutationPreconditionError(
        denied.errorCode ?? denied.error ?? "RATE_LIMITED",
        denied.detail ?? "Rate limit exceeded",
      );
    }
    const body = {
      service_id: params.service_id,
      member_id: params.member_id,
      customer_name: params.customer_name,
      customer_phone: params.customer_phone,
      date: params.date,
      start_time: params.start_time,
    };
    const idempotencyKey = this.deriveIdempotencyKey(context, params);
    const raw = (await calendarClient.createAppointment(
      params.calendar_id,
      body,
      undefined,
      idempotencyKey,
    )) as { id?: string } & Record<string, unknown>;
    return { appointment_id: raw.id, raw };
  }
}

export const createAppointmentMutation = new CreateAppointmentMutation();
