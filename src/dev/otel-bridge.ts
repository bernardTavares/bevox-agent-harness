// Optional bridge: when OTEL is enabled via F4 (Observability), a custom
// SpanProcessor publishes finished spans to the dev event bus so the
// playground timeline shows the full span tree.
//
// Without F4 the bridge is unused — events flow directly from
// execution-handler.ts (Task 4) via getDevEventBus().emitEvent(...).
//
// We use a structural type-only import path for `SpanProcessor` so this
// module does not introduce a hard dependency on @opentelemetry/sdk-trace-base
// when the optional bridge is not registered.

import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { getDevEventBus, isDevModeEnabled } from "./event-bus.js";
import type { SpanFinishedEvent } from "./types.js";

function hrDurationMs(start: [number, number], end: [number, number]): number {
  return (end[0] - start[0]) * 1000 + (end[1] - start[1]) / 1e6;
}

function hrToMs(hr: [number, number]): number {
  return hr[0] * 1000 + Math.floor(hr[1] / 1e6);
}

/**
 * SpanProcessor that re-emits finished spans onto the in-process dev bus.
 *
 * Registered as an additional processor next to the OTLP exporter (see
 * tracer.ts wiring; only attached when isDevModeEnabled()).
 */
export class DevEventSpanProcessor implements SpanProcessor {
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  onStart(): void {
    /* no-op */
  }
  onEnd(span: ReadableSpan): void {
    if (!isDevModeEnabled()) return;
    const ctx = span.spanContext();
    const attrs = (span.attributes ?? {}) as Record<string, unknown>;
    const executionId =
      typeof attrs["execution.id"] === "string" ? (attrs["execution.id"] as string) : "unknown";

    // `parentSpanId` is a legacy field; newer @opentelemetry/sdk-trace-base
    // exposes it via `parentSpanContext?.spanId`. Read both defensively.
    const legacy = (span as unknown as { parentSpanId?: string }).parentSpanId;
    const fromCtx = (span as unknown as { parentSpanContext?: { spanId?: string } })
      .parentSpanContext?.spanId;
    const parentSpanId = legacy ?? fromCtx;

    const event: SpanFinishedEvent = {
      kind: "span.finished",
      executionId,
      name: span.name,
      ts: hrToMs(span.endTime),
      durationMs: hrDurationMs(span.startTime, span.endTime),
      attrs,
      spanId: ctx.spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
    };
    getDevEventBus().emitEvent(event);
  }
}
