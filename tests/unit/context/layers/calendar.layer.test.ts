import { describe, it, expect, vi } from "vitest";

import { CalendarLayer } from "../../../../src/context/layers/calendar.layer.js";
import type { ContextInput } from "../../../../src/context/types.js";

const input: ContextInput = {
  executionId: "e1",
  organizationId: "018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b",
  contactId: 10n,
  conversationKey: "c1",
  agentConfig: { systemPrompt: "" },
  dispatchPayload: {}
};

const fullCalendarData = {
  services: [
  {
    id: "s1",
    name: "Consulta medica",
    duration_minutes: 30,
    active: true,
    description: "Consulta padrao."
  },
  {
    id: "s2",
    name: "Retorno",
    duration_minutes: 15,
    active: true,
    description: null
  },
  {
    id: "s3",
    name: "Hidden",
    duration_minutes: 10,
    active: false,
    description: null
  }],

  members: [
  { id: "m1", name: "Dra. Ana Paula", role: "Medica", active: true },
  { id: "m2", name: "Inactive", role: "Medico", active: false },
  { id: "m3", name: "No Role", role: null, active: true }],

  availabilityToday: [
  {
    member_id: "m1",
    member_name: "Dra. Ana Paula",
    available_slots: ["09:00", "09:30", "14:00"]
  },
  {
    member_id: "m3",
    member_name: "No Role",
    available_slots: []
  }]

};

describe("CalendarLayer", () => {
  it("formats services, members, and availability", async () => {
    const client = {
      getCalendarContext: vi.fn().mockResolvedValue(fullCalendarData)
    };
    const layer = new CalendarLayer(client);
    const block = await layer.build(input);

    expect(block.section).toBe("## Agenda");
    expect(block.content).toContain("Consulta medica");
    expect(block.content).toContain("30 min");
    expect(block.content).toContain("Consulta padrao.");
    expect(block.content).toContain("Retorno");
    expect(block.content).toContain("Dra. Ana Paula");
    expect(block.content).toContain("(Medica)");
    expect(block.content).toContain("09:00");
    expect(block.priority).toBe(30);
    expect(block.compressible).toBe(true);
  });

  it("filters inactive services and members", async () => {
    const client = {
      getCalendarContext: vi.fn().mockResolvedValue(fullCalendarData)
    };
    const layer = new CalendarLayer(client);
    const block = await layer.build(input);
    expect(block.content).not.toContain("Hidden");
    expect(block.content).not.toContain("Inactive");
  });

  it("handles members without role gracefully", async () => {
    const client = {
      getCalendarContext: vi.fn().mockResolvedValue(fullCalendarData)
    };
    const layer = new CalendarLayer(client);
    const block = await layer.build(input);
    expect(block.content).toContain("No Role");
    // Should not have "(null)" or similar
    expect(block.content).not.toContain("(null)");
  });

  it("shows fallback text for members with no slots", async () => {
    const client = {
      getCalendarContext: vi.fn().mockResolvedValue(fullCalendarData)
    };
    const layer = new CalendarLayer(client);
    const block = await layer.build(input);
    expect(block.content).toContain("Sem horarios");
  });

  it("returns empty block when services and members both empty", async () => {
    const client = {
      getCalendarContext: vi.
      fn().
      mockResolvedValue({ services: [], members: [], availabilityToday: [] })
    };
    const layer = new CalendarLayer(client);
    const block = await layer.build(input);
    expect(block.content).toBe("");
    expect(block.tokenEstimate).toBe(0);
  });

  it("passes correct organizationId to client", async () => {
    const client = {
      getCalendarContext: vi.
      fn().
      mockResolvedValue({ services: [], members: [], availabilityToday: [] })
    };
    const layer = new CalendarLayer(client);
    await layer.build(input);
    expect(client.getCalendarContext).toHaveBeenCalledWith("018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b");
  });

  it("returns empty block when client throws", async () => {
    const client = {
      getCalendarContext: vi.
      fn().
      mockRejectedValue(new Error("calendar-service unavailable"))
    };
    const layer = new CalendarLayer(client);
    const block = await layer.build(input);
    expect(block.content).toBe("");
    expect(block.tokenEstimate).toBe(0);
    expect(block.section).toBe("## Agenda");
  });

  it("handles services only without members", async () => {
    const client = {
      getCalendarContext: vi.fn().mockResolvedValue({
        services: [
        { id: "s1", name: "Servico", duration_minutes: 60, active: true }],

        members: [],
        availabilityToday: []
      })
    };
    const layer = new CalendarLayer(client);
    const block = await layer.build(input);
    expect(block.content).toContain("Servico");
    expect(block.content).not.toContain("### Profissionais");
  });

  it("handles members only without services", async () => {
    const client = {
      getCalendarContext: vi.fn().mockResolvedValue({
        services: [],
        members: [{ id: "m1", name: "Dra X", active: true }],
        availabilityToday: []
      })
    };
    const layer = new CalendarLayer(client);
    const block = await layer.build(input);
    expect(block.content).toContain("Dra X");
    expect(block.content).not.toContain("### Servicos");
  });
});