import type { AgentExecutionContext } from "../../../agents/execution-context.js";
import * as calendarClient from "../../../integration/calendar-client.js";
import type { ToolResult } from "../../../tools/types.js";

interface ReadCalendarParams {
  calendar_id: string;
  date: string;
  service_id?: string;
  member_id?: string;
}

export async function execute(
  params: unknown,
  _context: AgentExecutionContext,
): Promise<ToolResult> {
  const p = params as ReadCalendarParams;
  if (!p.calendar_id || !p.date) {
    return { success: false, error: "INVALID_PARAMS", detail: "calendar_id and date are required" };
  }
  try {
    const data = await calendarClient.getAvailability(p.calendar_id, p.date, p.service_id);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: "CALENDAR_SERVICE_ERROR", detail: String(err) };
  }
}
