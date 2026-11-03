interface Props {
  query: string;
  setQuery: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  accountId: string;
  setAccountId: (v: string) => void;
}

export function FilterBar(props: Props) {
  return (
    <div className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
      <input
        placeholder="search prompts / tools / spans…"
        value={props.query}
        onChange={(e) => props.setQuery(e.target.value)}
        style={{ flex: 1 }}
      />
      <select value={props.status} onChange={(e) => props.setStatus(e.target.value)}>
        <option value="">All status</option>
        <option value="running">Running</option>
        <option value="ok">OK</option>
        <option value="error">Error</option>
      </select>
      <input
        placeholder="account id"
        value={props.accountId}
        onChange={(e) => props.setAccountId(e.target.value)}
        style={{ width: 100 }}
      />
    </div>
  );
}
