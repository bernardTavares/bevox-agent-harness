import { useEffect, useMemo, useState } from "react";

import { JsonViewer } from "../components/json-viewer";
import { ReplaySlider } from "../components/replay-slider";
import { useStore } from "../state/store";
import type { ExecutionState, SpanRecord } from "../state/types";

import { PromptsPanel } from "./prompts-panel";
import { Timeline } from "./timeline";
import { TracesPanel } from "./traces-panel";

interface Props {
  exec: ExecutionState;
}

function relTs(ts: number, base: number): string {
  return `+${(ts - base).toFixed(0)}ms`;
}

export function ExecutionDetail({ exec }: Props) {
  const select = useStore((s) => s.select);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [tSlider, setTSlider] = useState<number | null>(null);
  const [inspector, setInspector] = useState<
    | { kind: "llm"; idx: number }
    | { kind: "tool"; idx: number }
    | { kind: "span"; spanId: string }
    | null
  >(null);

  const completedTs = exec.completedAt ?? Date.now();
  const totalMs = Math.max(1, completedTs - exec.startedAt);

  // initialize slider once we have data
  useEffect(() => {
    if (tSlider === null) setTSlider(totalMs);
  }, [totalMs, tSlider]);

  // share via URL ?t=
  useEffect(() => {
    if (tSlider === null) return;
    const url = new URL(window.location.href);
    url.searchParams.set("t", String(Math.floor(tSlider)));
    history.replaceState({}, "", url.toString());
  }, [tSlider]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  const cutoffTs = tSlider === null ? undefined : exec.startedAt + tSlider;
  const visibleLlm = useMemo(
    () => (cutoffTs === undefined ? exec.llmCalls : exec.llmCalls.filter((c) => c.ts <= cutoffTs)),
    [exec.llmCalls, cutoffTs],
  );
  const visibleTools = useMemo(
    () =>
      cutoffTs === undefined ? exec.toolCalls : exec.toolCalls.filter((c) => c.ts <= cutoffTs),
    [exec.toolCalls, cutoffTs],
  );

  const onSelectSpan = (s: SpanRecord) => {
    setSelectedSpanId(s.spanId);
    setInspector({ kind: "span", spanId: s.spanId });
  };

  const totalTokens = exec.llmCalls.reduce(
    (acc, l) => acc + l.tokens.input + l.tokens.output,
    0,
  );

  return (
    <div className="col" style={{ height: "100%" }}>
      <div
        className="row"
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
          gap: 12,
        }}
      >
        <button onClick={() => select(null)}>← Back</button>
        <strong>
          <code>{exec.id}</code>
        </strong>
        <span className={`badge ${exec.status === "ok" ? "ok" : exec.status === "error" ? "err" : "running"}`}>
          {exec.status}
        </span>
        {exec.agentName && <span className="badge">{exec.agentName}</span>}
        <span className="dim">account {exec.accountId ?? "—"}</span>
        <span className="dim">
          {exec.durationMs ? `${exec.durationMs.toFixed(0)}ms` : `${totalMs.toFixed(0)}ms (live)`}
        </span>
        <span className="dim">tokens {totalTokens}</span>
        {exec.error && <span className="badge err">{exec.error}</span>}
      </div>

      <ReplaySlider
        totalMs={totalMs}
        value={tSlider ?? totalMs}
        onChange={(v) => setTSlider(v)}
      />

      <Timeline
        exec={exec}
        selectedSpanId={selectedSpanId}
        onSelect={onSelectSpan}
        cutoffTs={cutoffTs}
      />

      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: "stretch" }}>
        {/* Left: spans + events list */}
        <div
          className="col scroll"
          style={{
            width: 280,
            borderRight: "1px solid var(--border)",
            background: "var(--panel)",
          }}
        >
          <Section title="LLM calls">
            {visibleLlm.length === 0 && <div className="dim">none</div>}
            {visibleLlm.map((c, i) => (
              <div
                key={i}
                onClick={() => setInspector({ kind: "llm", idx: i })}
                className="row"
                style={{
                  padding: "4px 8px",
                  cursor: "pointer",
                  background:
                    inspector?.kind === "llm" && inspector.idx === i
                      ? "var(--panel-2)"
                      : "transparent",
                }}
              >
                <span style={{ color: "var(--llm)" }}>●</span>
                <span style={{ flex: 1 }}>
                  {c.purpose ?? `${c.provider}/${c.model}`}
                </span>
                <span className="dim" style={{ fontSize: 11 }}>
                  {relTs(c.ts, exec.startedAt)}
                </span>
              </div>
            ))}
          </Section>
          <Section title="Tool calls">
            {visibleTools.length === 0 && <div className="dim">none</div>}
            {visibleTools.map((c, i) => (
              <div
                key={i}
                onClick={() => setInspector({ kind: "tool", idx: i })}
                className="row"
                style={{
                  padding: "4px 8px",
                  cursor: "pointer",
                  background:
                    inspector?.kind === "tool" && inspector.idx === i
                      ? "var(--panel-2)"
                      : "transparent",
                }}
              >
                <span style={{ color: "var(--tool)" }}>●</span>
                <span style={{ flex: 1 }}>{c.tool}</span>
                <span
                  className={`badge ${c.success ? "ok" : "err"}`}
                  style={{ marginRight: 4 }}
                >
                  {c.success ? "ok" : "fail"}
                </span>
                <span className="dim" style={{ fontSize: 11 }}>
                  {c.latencyMs}ms
                </span>
              </div>
            ))}
          </Section>
          <Section title="Spans">
            {exec.spans.length === 0 && <div className="dim">none</div>}
            {exec.spans.map((s) => (
              <div
                key={s.spanId}
                onClick={() => onSelectSpan(s)}
                style={{
                  padding: "3px 8px",
                  cursor: "pointer",
                  paddingLeft: s.parentSpanId ? 20 : 8,
                  background: selectedSpanId === s.spanId ? "var(--panel-2)" : "transparent",
                  fontSize: 11,
                }}
              >
                {s.name}{" "}
                <span className="dim">{s.durationMs.toFixed(0)}ms</span>
              </div>
            ))}
          </Section>
        </div>

        {/* Center: Inspector */}
        <div
          className="col scroll"
          style={{ flex: 1, padding: 12, gap: 8 }}
        >
          {inspector === null && (
            <div className="dim" style={{ fontStyle: "italic" }}>
              Select a span, LLM call, or tool call to inspect.
            </div>
          )}
          {inspector?.kind === "llm" && visibleLlm[inspector.idx] && (
            <PromptsPanel call={visibleLlm[inspector.idx]} />
          )}
          {inspector?.kind === "tool" && visibleTools[inspector.idx] && (
            <TracesPanel call={visibleTools[inspector.idx]} />
          )}
          {inspector?.kind === "span" &&
            (() => {
              const span = exec.spans.find((s) => s.spanId === inspector.spanId);
              if (!span) return null;
              return (
                <div>
                  <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                    <strong>{span.name}</strong>
                    <span className="dim">{span.durationMs.toFixed(1)}ms</span>
                    <span className="dim">spanId={span.spanId.slice(0, 8)}</span>
                  </div>
                  <JsonViewer value={span.attrs} />
                </div>
              );
            })()}
        </div>

        {/* Right: Cost panel */}
        <div
          className="col"
          style={{
            width: 220,
            borderLeft: "1px solid var(--border)",
            padding: 12,
            background: "var(--panel)",
            gap: 12,
          }}
        >
          <div>
            <div className="dim" style={{ fontSize: 11 }}>
              Tokens (input)
            </div>
            <div style={{ fontSize: 18 }}>
              {exec.llmCalls.reduce((a, l) => a + l.tokens.input, 0)}
            </div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 11 }}>
              Tokens (output)
            </div>
            <div style={{ fontSize: 18 }}>
              {exec.llmCalls.reduce((a, l) => a + l.tokens.output, 0)}
            </div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 11 }}>
              LLM calls
            </div>
            <div style={{ fontSize: 18 }}>{exec.llmCalls.length}</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 11 }}>
              Tool calls
            </div>
            <div style={{ fontSize: 18 }}>{exec.toolCalls.length}</div>
          </div>
          <div>
            <div className="dim" style={{ fontSize: 11 }}>
              Spans
            </div>
            <div style={{ fontSize: 18 }}>{exec.spans.length}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        className="dim"
        style={{
          padding: "6px 8px",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
