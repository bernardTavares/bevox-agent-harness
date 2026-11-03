import { useMemo, useState } from "react";

import { FilterBar } from "../components/filter-bar";
import { useStore } from "../state/store";
import type { ExecutionState } from "../state/types";

function statusBadge(s: ExecutionState["status"]): JSX.Element {
  const cls = s === "ok" ? "ok" : s === "error" ? "err" : "running";
  return <span className={`badge ${cls}`}>{s}</span>;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function relative(ts: number): string {
  const delta = (Date.now() - ts) / 1000;
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

export function ExecutionsList() {
  const executions = useStore((s) => s.executions);
  const select = useStore((s) => s.select);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [accountId, setAccountId] = useState("");

  const rows = useMemo(() => {
    const arr = Array.from(executions.values());
    return arr
      .filter((e) => {
        if (status && e.status !== status) return false;
        if (accountId && String(e.accountId ?? "") !== accountId) return false;
        if (query) {
          const q = query.toLowerCase();
          const hay = [
            e.id,
            e.agentName ?? "",
            ...e.llmCalls.map((l) => l.prompt + " " + l.response),
            ...e.toolCalls.map((t) => t.tool),
            ...e.spans.map((s) => s.name),
          ]
            .join(" ")
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [executions, status, accountId, query]);

  return (
    <div className="col" style={{ height: "100%" }}>
      <FilterBar
        query={query}
        setQuery={setQuery}
        status={status}
        setStatus={setStatus}
        accountId={accountId}
        setAccountId={setAccountId}
      />
      <div className="scroll" style={{ flex: 1, padding: 0 }}>
        {rows.length === 0 ? (
          <div className="dim" style={{ padding: 24, textAlign: "center" }}>
            No executions yet. Dispatch a job to the harness queue to see live traces.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={th}>Exec ID</th>
                <th style={th}>Account</th>
                <th style={th}>Agent</th>
                <th style={th}>Started</th>
                <th style={th}>Duration</th>
                <th style={th}>Status</th>
                <th style={th}>Spans</th>
                <th style={th}>LLM</th>
                <th style={th}>Tools</th>
                <th style={th}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const totalTokens = e.llmCalls.reduce(
                  (acc, l) => acc + l.tokens.input + l.tokens.output,
                  0,
                );
                return (
                  <tr
                    key={e.id}
                    onClick={() => select(e.id)}
                    style={{
                      borderBottom: "1px solid var(--border)",
                      cursor: "pointer",
                    }}
                  >
                    <td style={td}>
                      <code>{shortId(e.id)}</code>
                    </td>
                    <td style={td}>{e.accountId ?? "—"}</td>
                    <td style={td}>{e.agentName ?? "—"}</td>
                    <td style={td}>{relative(e.startedAt)}</td>
                    <td style={td}>{e.durationMs ? `${e.durationMs.toFixed(0)}ms` : "—"}</td>
                    <td style={td}>{statusBadge(e.status)}</td>
                    <td style={td}>{e.spans.length}</td>
                    <td style={td}>{e.llmCalls.length}</td>
                    <td style={td}>{e.toolCalls.length}</td>
                    <td style={td}>{totalTokens}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "8px 12px", color: "var(--text-dim)", fontWeight: 500 };
const td: React.CSSProperties = { padding: "6px 12px" };
