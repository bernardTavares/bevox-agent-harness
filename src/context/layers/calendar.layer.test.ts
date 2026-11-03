import { describe, it, expect, vi } from "vitest";

import type { ContextInput } from "../types.js";

import { CalendarLayer } from "./calendar.layer.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 10n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {},
};

const mockCalendarData = {
  services: [
    {
      id: "s1",
      name: "Consulta medica",
      duration_minutes: 30,
      active: true,
      description: "Consulta padrao.",
    },
    { id: "s2", name: "Retorno", duration_minutes: 15, active: true, description: null },
  ],

  members: [{ id: "m1", name: "Dra. Ana Paula", role: "Medica", active: true }],
  availabilityToday: [
    {
      member_id: "m1",
      member_name: "Dra. Ana Paula",
      available_slots: ["09:00", "09:30", "14:00"],
    },
  ],
};

describe("CalendarLayer", () => {
  it("formats services, members, and availability", async () => {
    const mockClient = {
      getCalendarContext: vi.fn().mockResolvedValue(mockCalendarData),
    };
    const layer = new CalendarLayer(mockClient);
    const block = await layer.build(input);

    expect(block.section).toBe("## Agenda");
    expect(block.content).toContain("Consulta medica");
    expect(block.content).toContain("30 min");
    expect(block.content).toContain("Dra. Ana Paula");
    expect(block.content).toContain("09:00");
    expect(block.priority).toBe(30);
    expect(block.compressible).toBe(true);
  });

  it("returns empty section when calendar client returns no data", async () => {
    const mockClient = {
      getCalendarContext: vi
        .fn()
        .mockResolvedValue({ services: [], members: [], availabilityToday: [] }),
    };
    const layer = new CalendarLayer(mockClient);
    const block = await layer.build(input);
    expect(block.content).toBe("");
  });

  it("calls calendar client with correct organization_id", async () => {
    const mockClient = {
      getCalendarContext: vi
        .fn()
        .mockResolvedValue({ services: [], members: [], availabilityToday: [] }),
    };
    const layer = new CalendarLayer(mockClient);
    await layer.build(input);
    expect(mockClient.getCalendarContext).toHaveBeenCalledWith(5);
  });

  it("handles calendar client errors gracefully", async () => {
    const mockClient = {
      getCalendarContext: vi.fn().mockRejectedValue(new Error("calendar-service unavailable")),
    };
    const layer = new CalendarLayer(mockClient);
    // Should not throw — returns empty block with a warning comment
    const block = await layer.build(input);
    expect(block.content).toBe("");
    expect(block.tokenEstimate).toBe(0);
  });
});
