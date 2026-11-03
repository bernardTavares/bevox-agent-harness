import { SpanBar } from "../components/span-bar";
import type { ExecutionState, SpanRecord } from "../state/types";

interface Props {
  exec: ExecutionState;
  selectedSpanId: string | null;
  onSelect: (s: SpanRecord) => void;
  cutoffTs?: number;
}

export function Timeline({ exec, selectedSpanId, onSelect, cutoffTs }: Props) {
  const visibleSpans = (cutoffTs === undefined
    ? exec.spans
    : exec.spans.filter((s) => s.ts <= cutoffTs)
  )
    .slice()
    .sort((a, b) => a.ts - a.durationMs - (b.ts - b.durationMs));

  const totalEnd = Math.max(
    exec.completedAt ?? Date.now(),
    ...visibleSpans.map((s) => s.ts),
  );
  const totalMs = Math.max(1, totalEnd - exec.startedAt);

  return (
    <div
      style={{
        padding: 12,
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>
        Timeline — {visibleSpans.length} span(s), {totalMs.toFixed(0)}ms total
      </div>
      {visibleSpans.length === 0 && (
        <div className="dim" style={{ fontStyle: "italic", padding: "4px 0" }}>
          No spans yet. Spans appear once OTEL_ENABLED=true and instrumentation fires, or
          progressively as execution-handler emits events.
        </div>
      )}
      <div>
        {visibleSpans.map((s) => (
          <SpanBar
            key={s.spanId}
            span={s}
            startedAt={exec.startedAt}
            totalMs={totalMs}
            selected={s.spanId === selectedSpanId}
            onClick={() => onSelect(s)}
          />
        ))}
      </div>
    </div>
  );
}
