/**
 * C9 — `send-message` como `MutationTool` (ADR-006 / ADR-007).
 *
 * STOP tool: o `data.message` desta tool vira o `response_text` do
 * `/complete` (extraído pelo `react.synthesize()`). NÃO chama
 * `sendComplete` — o handler é o único dispatcher. Em draft modes
 * (manual_assisted / copilot) retorna proposal sem efeito.
 */

import { checkRateLimit } from "../_shared/rate-limit.js";
import {
  MutationTool,
  MutationPreconditionError,
  type ToolContext,
} from "../_shared/mutation-tool.js";

export interface SendMessageParams {
  message: string;
}

export interface SendMessageResult {
  sent: true;
  message: string;
}

export class SendMessageMutation extends MutationTool<SendMessageParams, SendMessageResult> {
  readonly name = "send-message";
  readonly action = "send-message";

  async execute(params: SendMessageParams, context: ToolContext): Promise<SendMessageResult> {
    if (!params.message) {
      throw new MutationPreconditionError("INVALID_PARAMS", "message is required");
    }
    // Rate-limit (política `send-message`). Em draft modes nunca roda —
    // executeOrPropose só chama execute() em autonomous_supervised.
    const denied = await checkRateLimit(context.organization_id, "send-message", "send-message");
    if (denied) {
      throw new MutationPreconditionError(
        denied.errorCode ?? denied.error ?? "RATE_LIMITED",
        denied.detail ?? "Rate limit exceeded",
      );
    }
    // NÃO chama sendComplete — `message` é lido pelo synthesize e vira o
    // response_text.
    return { sent: true, message: params.message };
  }
}

export const sendMessageMutation = new SendMessageMutation();
