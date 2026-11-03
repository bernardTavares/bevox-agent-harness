import { trace, type Tracer } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import { getEnv } from "../config/env.js";

let sdk: NodeSDK | null = null;
let started = false;

/**
 * Initialize the OpenTelemetry SDK based on environment configuration.
 *
 * Safe to call multiple times — only the first call starts the SDK.
 * If OTEL_ENABLED is false (default), this is a no-op and `getTracer()`
 * will return a no-op tracer from the global API.
 */
export function initTracer(): void {
  if (started) return;
  const env = getEnv();
  if (!env.OTEL_ENABLED) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: env.OTEL_SERVICE_VERSION,
    }),
    traceExporter: env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT })
      : new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  started = true;
}

/**
 * Gracefully flush and shut down the tracer. Idempotent.
 */
export async function shutdownTracer(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
    } finally {
      sdk = null;
      started = false;
    }
  }
}

/**
 * Get a named tracer. If OTEL is disabled, returns a no-op tracer
 * (the global API contract guarantees this).
 */
export function getTracer(name = "bevox-agent-harness"): Tracer {
  return trace.getTracer(name);
}
