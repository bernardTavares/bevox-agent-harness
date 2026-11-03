# MCP tools do bevox-agent-harness

Binary: `bevox-mcp` (em `dist/bin/bevox-mcp.js`). Iniciar via stdio ou SSE.

## Tools expostas (V1)

NOTA: lista verificável em runtime via MCP `tools/list`. Resumo:

### `inspect_execution`
Estado atual de uma execução em curso.
- Input: `execution_id: string`
- Output: `{ state, current_round, last_tool_call, llm_usage }`

### `simulate_execution`
Roda execução em modo DRY-RUN (tools mutação retornam proposals).
- Input: `{ workspace_id, conversation, execution_mode }`
- Output: estado final + sequência de tool calls

### `list_tools_available`
Lista tools que o harness expõe para os agentes IA.
- Input: nenhum
- Output: `[ { name, category, agent_type, ... } ]`

### `read_memory`
Lê facts/profile de um customer (read-only, ADR-005).
- Input: `{ workspace_id, customer_id }`
- Output: `{ profile, facts: [...] }`

### `health_check`
Health do harness e providers LLM.
- Input: nenhum
- Output: `{ ok, llm_providers: { openai: ok, gemini: ok }, redis: ok, postgres: ok }`

## Invocação

Do hub Bevox (`bevox-PRD-consolidation/.mcp.json`):

```jsonc
{
  "bevox-harness": {
    "command": "node",
    "args": ["../bevox-agent-harness/dist/bin/bevox-mcp.js"]
  }
}
```
