import type { SpanRecord } from "../state/types";

export function spanCategoryColor(name: string): string {
  if (name.startsWith("pipeline.")) return "var(--pipeline)";
  if (name.startsWith("execution.surface") || name.startsWith("reasoning.")) return "var(--surface)";
  if (name.startsWith("tool.")) return "var(--tool)";
  if (name.startsWith("llm.")) return "var(--llm)";
  return "var(--text-dim)";
}

interface Props {
  span: SpanRecord;
  startedAt: number;
  totalMs: number;
  selected: boolean;
  onClick: () => void;
}

export function SpanBar({ span, startedAt, totalMs, selected, onClick }: Props) {
  const startOffset = Math.max(0, span.ts - span.durationMs - startedAt);
  const widthMs = Math.max(2, span.durationMs);
  const leftPct = totalMs > 0 ? (startOffset / totalMs) * 100 : 0;
  const widthPct = totalMs > 0 ? Math.min(100 - leftPct, (widthMs / totalMs) * 100) : 5;
  const color = spanCategoryColor(span.name);
  return (
    <div
      onClick={onClick}
      title={`${span.name} — ${span.durationMs.toFixed(1)}ms`}
      style={{
        position: "relative",
        height: 18,
        marginBottom: 2,
        cursor: "pointer",
        outline: selected ? "1px solid var(--accent)" : "none",
        borderRadius: 3,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          top: 0,
          bottom: 0,
          background: color,
          opacity: selected ? 1 : 0.7,
          borderRadius: 3,
          paddingLeft: 4,
          fontSize: 11,
          color: "#0b0f17",
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        }}
      >
        {span.name} · {span.durationMs.toFixed(0)}ms
      </div>
    </div>
  );
}
