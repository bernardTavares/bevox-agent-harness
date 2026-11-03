import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import * as calendarClient from "../../../integration/calendar-client.js";
import type { ToolResult } from "../../../tools/types.js";

interface ListAppointmentsParams {
  calendar_id: string;
  date_from: string;
  date_to: string;
  status?: string;
}

export async function execute(
  params: unknown,
  _context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as ListAppointmentsParams;
  if (!p.calendar_id || !p.date_from || !p.date_to) {
    return {
      success: false,
      error: "INVALID_PARAMS",
      detail: "calendar_id, date_from, and date_to are required",
    };
  }
  try {
    const data = await calendarClient.listAppointments(p.calendar_id, p.date_from, p.date_to);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: "CALENDAR_SERVICE_ERROR", detail: String(err) };
  }
}
