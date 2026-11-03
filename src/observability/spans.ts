import { SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";

import { getTracer } from "./tracer.js";

export type SpanAttrValue = string | number | boolean | undefined;

/**
 * Run `fn` inside an active span. Records exceptions and sets ERROR status on throw.
 * Attributes with `undefined` value are skipped to keep span clean.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, SpanAttrValue>,
  fn: (span: Span) => Promise<T>,
  tracer: Tracer = getTracer(),
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) span.setAttribute(k, v);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error)?.message ?? String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
