import { useEffect } from "react";

import { useDevWebSocket } from "./api/ws-client";
import { useStore } from "./state/store";
import { ExecutionDetail } from "./views/execution-detail";
import { ExecutionsList } from "./views/executions-list";

const WS_URL =
  (import.meta.env?.VITE_HARNESS_WS_URL as string | undefined) ?? "ws://127.0.0.1:4400";

export function App() {
  useDevWebSocket(WS_URL);
  const connected = useStore((s) => s.wsConnected);
  const selectedId = useStore((s) => s.selectedId);
  const exec = useStore((s) => (selectedId ? s.executions.get(selectedId) : undefined));
  const clear = useStore((s) => s.clear);

  // theme toggle (persist in localStorage)
  useEffect(() => {
    const stored = localStorage.getItem("playground.theme") ?? "dark";
    document.documentElement.className = stored;
  }, []);

  const toggleTheme = () => {
    const next = document.documentElement.className === "dark" ? "light" : "dark";
    document.documentElement.className = next;
    localStorage.setItem("playground.theme", next);
  };

  return (
    <div className="col" style={{ height: "100%" }}>
      <header
        className="row"
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
          gap: 12,
        }}
      >
        <strong>Bevox Harness Playground</strong>
        <span className={`badge ${connected ? "ok" : "err"}`}>
          {connected ? "WS connected" : "WS disconnected"}
        </span>
        <span className="dim">{WS_URL}</span>
        <div style={{ flex: 1 }} />
        <button onClick={clear}>Clear</button>
        <button onClick={toggleTheme}>Toggle theme</button>
      </header>
      {!connected && (
        <div
          className="row"
          style={{
            padding: "6px 12px",
            background: "var(--err)",
            color: "#0b0f17",
            fontSize: 12,
          }}
        >
          Disconnected from harness. Reconnecting… (is `npm run playground` running with
          HARNESS_DEV_MODE=1?)
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {exec ? <ExecutionDetail exec={exec} /> : <ExecutionsList />}
      </div>
    </div>
  );
}
