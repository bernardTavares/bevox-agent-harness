import { describe, it, expect, vi, beforeEach } from 'vitest';
// SKILLS-05 Phase 3: legacy per-tool wrapper deleted; logic lives in the skill impl.
import { execute } from "../../../src/skills-builtin/calendar/list-appointments/list-appointments.impl.js";
import * as calendarClient from "../../../src/integration/calendar-client.js";
import { makeToolContext } from "../../helpers/tool-context.js";

vi.mock('../../../src/integration/calendar-client');

describe('list-appointments skill execute', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns INVALID_PARAMS when fields are missing', async () => {
    const r1 = await execute({}, makeToolContext());
    expect(r1.error).toBe('INVALID_PARAMS');

    const r2 = await execute(
      { calendar_id: 'cal-1', date_from: '2026-04-10' },
      makeToolContext()
    );
    expect(r2.error).toBe('INVALID_PARAMS');
  });

  it('returns appointments on success', async () => {
    const fake = [{ id: 1 }, { id: 2 }];
    vi.mocked(calendarClient.listAppointments).mockResolvedValueOnce(fake);
    const result = await execute(
      { calendar_id: 'cal-1', date_from: '2026-04-10', date_to: '2026-04-12' },
      makeToolContext()
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual(fake);
    expect(calendarClient.listAppointments).toHaveBeenCalledWith(
      'cal-1',
      '2026-04-10',
      '2026-04-12'
    );
  });

  it('wraps downstream errors as CALENDAR_SERVICE_ERROR', async () => {
    vi.mocked(calendarClient.listAppointments).mockRejectedValueOnce(new Error('timeout'));
    const result = await execute(
      { calendar_id: 'cal-1', date_from: '2026-04-10', date_to: '2026-04-12' },
      makeToolContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('CALENDAR_SERVICE_ERROR');
    expect(result.detail).toContain('timeout');
  });
});