import { create } from "zustand";

import type {
  DevEvent,
  ExecutionState,
  LLMCallRecord,
  SpanRecord,
  ToolCallRecord,
} from "./types";

const MAX_EXECUTIONS = 200;

interface Store {
  executions: Map<string, ExecutionState>;
  selectedId: string | null;
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;
  select: (id: string | null) => void;
  ingest: (event: DevEvent) => void;
  clear: () => void;
}

function blank(id: string, ts: number, accountId?: number): ExecutionState {
  return {
    id,
    accountId,
    startedAt: ts,
    status: "running",
    spans: [],
    llmCalls: [],
    toolCalls: [],
  };
}

function applyEvent(ex: ExecutionState, event: DevEvent): void {
  switch (event.kind) {
    case "execution.started":
      ex.startedAt = event.ts;
      ex.accountId = event.accountId;
      ex.status = "running";
      break;
    case "execution.completed":
      ex.completedAt = event.ts;
      ex.durationMs = event.durationMs;
      ex.status = event.status === "ok" ? "ok" : "error";
      if (event.status === "error") ex.error = event.error;
      break;
    case "span.finished": {
      const rec: SpanRecord = {
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        name: event.name,
        ts: event.ts,
        durationMs: event.durationMs,
        attrs: event.attrs,
      };
      ex.spans.push(rec);
      if (typeof event.attrs["agent.name"] === "string") {
        ex.agentName = event.attrs["agent.name"] as string;
      }
      break;
    }
    case "llm.call": {
      const rec: LLMCallRecord = {
        ts: event.ts,
        provider: event.provider,
        model: event.model,
        prompt: event.prompt,
        response: event.response,
        tokens: event.tokens,
        latencyMs: event.latencyMs,
        purpose: event.purpose,
      };
      ex.llmCalls.push(rec);
      break;
    }
    case "tool.call": {
      const rec: ToolCallRecord = {
        ts: event.ts,
        tool: event.tool,
        params: event.params,
        result: event.result,
        success: event.success,
        latencyMs: event.latencyMs,
      };
      ex.toolCalls.push(rec);
      break;
    }
    case "reasoning.step":
      // currently surfaced only via spans; reserved for future
      break;
    default:
      break;
  }
}

export const useStore = create<Store>((set) => ({
  executions: new Map(),
  selectedId: null,
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),
  select: (id) => set({ selectedId: id }),
  ingest: (event) =>
    set((s) => {
      // We mutate then create a shallow copy of the Map so React notices via
      // referential equality on `executions`.
      const map = new Map(s.executions);
      const existing = map.get(event.executionId);
      const ex: ExecutionState =
        existing ??
        blank(
          event.executionId,
          event.ts,
          event.kind === "execution.started" ? event.accountId : undefined,
        );
      // Clone before mutating so React re-renders observers.
      const next: ExecutionState = {
        ...ex,
        spans: [...ex.spans],
        llmCalls: [...ex.llmCalls],
        toolCalls: [...ex.toolCalls],
      };
      applyEvent(next, event);
      map.set(event.executionId, next);

      // Cap memory by evicting the oldest started execution.
      if (map.size > MAX_EXECUTIONS) {
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const e of map.values()) {
          if (e.startedAt < oldestTs) {
            oldestTs = e.startedAt;
            oldestId = e.id;
          }
        }
        if (oldestId) map.delete(oldestId);
      }
      return { executions: map };
    }),
  clear: () => set({ executions: new Map(), selectedId: null }),
}));
