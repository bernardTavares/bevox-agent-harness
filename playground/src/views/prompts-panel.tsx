import type { LLMCallRecord } from "../state/types";

interface Props {
  call: LLMCallRecord;
}

export function PromptsPanel({ call }: Props) {
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="badge">{call.provider}</span>
        <span className="badge">{call.model}</span>
        {call.purpose && <span className="badge">{call.purpose}</span>}
        <span className="dim">{call.latencyMs}ms</span>
        <span className="dim">
          in {call.tokens.input} · out {call.tokens.output}
        </span>
        <button
          onClick={() => navigator.clipboard?.writeText(call.prompt)}
          style={{ marginLeft: "auto" }}
        >
          copy prompt
        </button>
        <button onClick={() => navigator.clipboard?.writeText(call.response)}>copy response</button>
      </div>
      <Section title="Prompt" body={call.prompt} />
      <Section title="Response" body={call.response} />
    </div>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  let pretty = body;
  try {
    pretty = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    /* not JSON — display raw */
  }
  return (
    <div>
      <div className="dim" style={{ fontSize: 11, marginBottom: 2 }}>
        {title}
      </div>
      <pre
        style={{
          background: "var(--panel-2)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          padding: 8,
          maxHeight: 320,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {pretty}
      </pre>
    </div>
  );
}
