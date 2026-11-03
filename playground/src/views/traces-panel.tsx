import { JsonViewer } from "../components/json-viewer";
import type { ToolCallRecord } from "../state/types";

interface Props {
  call: ToolCallRecord;
}

export function TracesPanel({ call }: Props) {
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="badge">{call.tool}</span>
        <span className={`badge ${call.success ? "ok" : "err"}`}>
          {call.success ? "ok" : "fail"}
        </span>
        <span className="dim">{call.latencyMs}ms</span>
      </div>
      <div className="col" style={{ gap: 8 }}>
        <div>
          <div className="dim" style={{ fontSize: 11, marginBottom: 2 }}>
            Params
          </div>
          <JsonViewer value={call.params} />
        </div>
        <div>
          <div className="dim" style={{ fontSize: 11, marginBottom: 2 }}>
            Result
          </div>
          <JsonViewer value={call.result} />
        </div>
      </div>
    </div>
  );
}
