import { describe, it, expect, vi, beforeEach } from 'vitest';
// SKILLS-05 Phase 3: the legacy per-tool wrapper was deleted; the execute body now
// lives in the skill impl. Metadata (name/category/agentType) is manifest-owned
// and asserted by unified-registry + manifest-parity tests.
import { execute } from "../../../src/skills-builtin/calendar/read-calendar/read-calendar.impl.js";
import * as calendarClient from "../../../src/integration/calendar-client.js";
import { makeToolContext } from "../../helpers/tool-context.js";

vi.mock('../../../src/integration/calendar-client');

describe('read-calendar skill execute', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns INVALID_PARAMS when calendar_id is missing', async () => {
    const result = await execute({ date: '2026-04-10' }, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_PARAMS');
  });

  it('returns INVALID_PARAMS when date is missing', async () => {
    const result = await execute({ calendar_id: 'cal-1' }, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_PARAMS');
  });

  it('returns availability data on success', async () => {
    const fake = { slots: [{ start: '09:00', end: '10:00' }] };
    vi.mocked(calendarClient.getAvailability).mockResolvedValueOnce(fake);
    const result = await execute(
      { calendar_id: 'cal-1', date: '2026-04-10', service_id: 'svc-1' },
      makeToolContext()
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual(fake);
    expect(calendarClient.getAvailability).toHaveBeenCalledWith('cal-1', '2026-04-10', 'svc-1');
  });

  it('wraps downstream errors as CALENDAR_SERVICE_ERROR', async () => {
    vi.mocked(calendarClient.getAvailability).mockRejectedValueOnce(new Error('boom'));
    const result = await execute(
      { calendar_id: 'cal-1', date: '2026-04-10' },
      makeToolContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('CALENDAR_SERVICE_ERROR');
    expect(result.detail).toContain('boom');
  });

  it('omits service_id when not provided', async () => {
    vi.mocked(calendarClient.getAvailability).mockResolvedValueOnce({});
    await execute({ calendar_id: 'cal-1', date: '2026-04-10' }, makeToolContext());
    expect(calendarClient.getAvailability).toHaveBeenCalledWith('cal-1', '2026-04-10', undefined);
  });
});