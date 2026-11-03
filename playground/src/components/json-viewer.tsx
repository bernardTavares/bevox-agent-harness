import { useState } from "react";

interface Props {
  value: unknown;
  collapsed?: boolean;
}

function safe(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function syntaxHighlight(json: string): string {
  // Minimal regex highlighting — wraps tokens in span with class. The
  // result is set via dangerouslySetInnerHTML below. Input is already
  // JSON.stringified so it cannot contain script tags before escaping
  // happens, but we still escape <, >, & defensively.
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(
    // eslint-disable-next-line no-useless-escape
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "json-num";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-str";
      } else if (/true|false/.test(match)) {
        cls = "json-bool";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

export function JsonViewer({ value, collapsed = false }: Props) {
  const [open, setOpen] = useState(!collapsed);
  const text = safe(value);
  const html = syntaxHighlight(text);
  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
        <button onClick={() => setOpen((o) => !o)} style={{ fontSize: 10, padding: "1px 6px" }}>
          {open ? "▼" : "▶"} JSON
        </button>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(text);
          }}
          style={{ fontSize: 10, padding: "1px 6px" }}
        >
          copy
        </button>
      </div>
      {open && (
        <pre
          style={{
            background: "var(--panel-2)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: 8,
            maxHeight: 360,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          <style>{`
            .json-key { color: var(--accent); }
            .json-str { color: #a5d6a7; }
            .json-num { color: #ffcc80; }
            .json-bool { color: #ce93d8; }
            .json-null { color: var(--text-dim); }
          `}</style>
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      )}
    </div>
  );
}
