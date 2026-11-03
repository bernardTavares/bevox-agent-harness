import { estimateTokens } from "../tokenizer.js";
import type { ContextInput, ContextBlock, ContextLayer } from "../types.js";

interface CalendarService {
  id: string;
  name: string;
  duration_minutes: number;
  active: boolean;
  description?: string | null;
}

interface CalendarMember {
  id: string;
  name: string;
  role?: string | null;
  active: boolean;
}

interface MemberAvailability {
  member_id: string;
  member_name: string;
  available_slots: string[]; // e.g. ['09:00', '09:30']
}

interface CalendarContext {
  services: CalendarService[];
  members: CalendarMember[];
  availabilityToday: MemberAvailability[];
}

export interface CalendarClient {
  getCalendarContext(organizationId: string): Promise<CalendarContext>;
}

export class CalendarLayer implements ContextLayer {
  readonly name = "calendar";
  readonly priority = 30;
  readonly compressible = true;

  constructor(private readonly calendarClient: CalendarClient) {}

  async build(input: ContextInput): Promise<ContextBlock> {
    let data: CalendarContext;

    try {
      data = await this.calendarClient.getCalendarContext(input.organizationId);
    } catch {
      // Calendar service unavailable — return empty block rather than failing the whole context build
      return {
        section: "## Agenda",
        content: "",
        tokenEstimate: 0,
        priority: this.priority,
        compressible: this.compressible,
      };
    }

    const { services, members, availabilityToday } = data;

    if (services.length === 0 && members.length === 0) {
      return {
        section: "## Agenda",
        content: "",
        tokenEstimate: 0,
        priority: this.priority,
        compressible: this.compressible,
      };
    }

    const lines: string[] = [];

    if (services.length > 0) {
      lines.push("### Servicos disponíveis");
      for (const s of services.filter((s) => s.active)) {
        const desc = s.description ? ` — ${s.description}` : "";
        lines.push(`- ${s.name} (${s.duration_minutes} min)${desc}`);
      }
    }

    if (members.length > 0) {
      lines.push("");
      lines.push("### Profissionais");
      for (const m of members.filter((m) => m.active)) {
        const role = m.role ? ` (${m.role})` : "";
        lines.push(`- ${m.name}${role}`);
      }
    }

    if (availabilityToday.length > 0) {
      lines.push("");
      lines.push("### Disponibilidade hoje");
      for (const avail of availabilityToday) {
        const slots = avail.available_slots.join(", ");
        lines.push(`- ${avail.member_name}: ${slots || "Sem horarios disponíveis"}`);
      }
    }

    const content = lines.join("\n");
    return {
      section: "## Agenda",
      content,
      tokenEstimate: estimateTokens("## Agenda\n" + content),
      priority: this.priority,
      compressible: this.compressible,
    };
  }
}
